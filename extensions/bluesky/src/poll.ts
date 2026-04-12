import type { BskyAgent } from "@atproto/api";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { chatApiGet } from "./auth.js";

/** Fastest poll rate — used immediately after a new message arrives. */
const MIN_POLL_MS = 2_000;
/** Slowest poll rate — reached after prolonged inactivity. */
const MAX_POLL_MS = 90_000;
/** Multiplicative backoff factor applied after each idle poll cycle. */
const BACKOFF_FACTOR = 1.5;

// AT Protocol lexicon method IDs
const LXM_LIST_CONVOS = "chat.bsky.convo.listConvos";
const LXM_GET_MESSAGES = "chat.bsky.convo.getMessages";

type ListConvosResponse = {
  convos: ConvoView[];
  cursor?: string;
};

type ConvoView = {
  id: string;
  lastMessage?: MessageView | DeletedMessageView;
  unreadCount?: number;
};

type MessageView = {
  $type: "chat.bsky.convo.defs#messageView";
  id: string;
  rev: string;
  text: string;
  sender: {
    did: string;
  };
  sentAt: string;
};

type DeletedMessageView = {
  $type: "chat.bsky.convo.defs#deletedMessageView";
  id: string;
  rev: string;
};

type GetMessagesResponse = {
  messages: Array<MessageView | DeletedMessageView>;
  cursor?: string;
};

type InboundMessage = {
  convoId: string;
  messageId: string;
  text: string;
  senderDid: string;
  sentAt: string;
};

function isMessageView(msg: MessageView | DeletedMessageView | undefined): msg is MessageView {
  return msg?.$type === "chat.bsky.convo.defs#messageView";
}

/**
 * Compute the next poll interval.
 * Resets to MIN on activity, backs off toward MAX on idle cycles.
 */
function nextPollMs(current: number, hadActivity: boolean): number {
  if (hadActivity) {
    return MIN_POLL_MS;
  }
  return Math.min(Math.round(current * BACKOFF_FACTOR), MAX_POLL_MS);
}

/** Maximum pages fetched per convo per poll cycle to bound API cost on very active convos. */
const MAX_FETCH_PAGES = 20;
/** Maximum pages fetched from listConvos per poll cycle (30 convos/page → up to 300 conversations). */
const MAX_LIST_PAGES = 10;

type FetchNewMessagesResult = {
  messages: InboundMessage[];
  /** The oldest rev we examined (newest-first traversal), set as watermark when page cap hit. */
  oldestRevSeen: string | undefined;
  /** True when MAX_FETCH_PAGES was reached while the API still had more pages to return. */
  hitPageCap: boolean;
};

/**
 * Fetch all messages in a conversation that are newer than the tracked rev.
 *
 * Paginates `getMessages` (newest-first) until it encounters a message at or
 * before the watermark, exhausts API pages, or reaches MAX_FETCH_PAGES.
 * Returns results in chronological order (oldest first) for in-order dispatch.
 *
 * When `hitPageCap` is true there are unseen messages older than those
 * returned; callers should advance the watermark to `oldestRevSeen` rather
 * than the convo's latest rev so the next poll cycle picks up the remainder.
 */
async function fetchNewMessages(
  agent: BskyAgent,
  convoId: string,
  selfDid: string,
  lastRev: string,
): Promise<FetchNewMessagesResult> {
  const results: InboundMessage[] = [];
  let cursor: string | undefined;
  let reachedOld = false;
  let exhaustedApi = false;
  let oldestRevSeen: string | undefined;

  for (let page = 0; page < MAX_FETCH_PAGES; page++) {
    const data = await chatApiGet<GetMessagesResponse>(agent, LXM_GET_MESSAGES, {
      convoId,
      limit: 10,
      ...(cursor ? { cursor } : {}),
    });

    for (const msg of data.messages) {
      if (!isMessageView(msg)) {
        continue;
      }
      // Messages are returned newest-first; once we hit one at or before the
      // watermark, everything further back is already processed — stop paginating.
      if (msg.rev <= lastRev) {
        reachedOld = true;
        break;
      }
      // Track the oldest rev examined (all messages, including our own outbound).
      oldestRevSeen = msg.rev;
      // Skip our own outbound messages
      if (msg.sender.did === selfDid) {
        continue;
      }
      results.push({
        convoId,
        messageId: msg.id,
        text: msg.text,
        senderDid: msg.sender.did,
        sentAt: msg.sentAt,
      });
    }

    if (reachedOld) {
      break;
    }
    if (!data.cursor) {
      exhaustedApi = true;
      break;
    }
    cursor = data.cursor;
  }

  return {
    // Reverse to chronological order (oldest first) for in-order dispatch
    messages: results.toReversed(),
    oldestRevSeen,
    // Page cap: stopped because we ran out of allowed pages, not because we
    // reached the watermark or ran out of API pages.
    hitPageCap: !reachedOld && !exhaustedApi,
  };
}

/**
 * Fetch all conversations by following the listConvos cursor.
 *
 * During poll cycles (lastRev provided), the API returns conversations in
 * most-recently-active order. When a full page contains only conversations
 * whose rev is at or before the watermark, all further pages will be older
 * still and we stop early to avoid unnecessary API calls.
 *
 * During the seed phase (lastRev === null), always paginate fully so every
 * existing conversation is watermarked before the poll loop starts.
 */
async function fetchAllConvos(
  agent: BskyAgent,
  lastRev: Map<string, string> | null,
): Promise<ConvoView[]> {
  const allConvos: ConvoView[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const data = await chatApiGet<ListConvosResponse>(agent, LXM_LIST_CONVOS, {
      limit: 30,
      ...(cursor ? { cursor } : {}),
    });

    allConvos.push(...data.convos);

    // During poll cycles: stop early if every convo on this page is unchanged —
    // older pages will be even staler.
    if (lastRev !== null) {
      const allStale = data.convos.every((convo) => {
        const msg = convo.lastMessage;
        if (!msg || !("rev" in msg) || !msg.rev) {
          return true;
        }
        const prev = lastRev.get(convo.id);
        return prev !== undefined && msg.rev <= prev;
      });
      if (allStale) {
        break;
      }
    }

    if (!data.cursor) {
      break;
    }
    cursor = data.cursor;
  }

  return allConvos;
}

export type PollCallbacks = {
  onMessage: (msg: InboundMessage) => Promise<void>;
  onError?: (err: Error, context: string) => void;
};

/**
 * Run the adaptive polling loop for Bluesky DM conversations.
 *
 * Starts by seeding the lastRev map from the current conversation state
 * so that no historical messages are replayed on startup.
 * After that, polls at an interval that starts at MIN_POLL_MS immediately
 * after activity and backs off exponentially to MAX_POLL_MS during idle periods.
 *
 * Resolves when the abortSignal fires.
 */
export async function runBlueSkyPollLoop(params: {
  agent: BskyAgent;
  selfDid: string;
  abortSignal: AbortSignal;
  callbacks: PollCallbacks;
}): Promise<void> {
  const { agent, selfDid, abortSignal, callbacks } = params;

  if (abortSignal.aborted) {
    return;
  }

  // lastRev tracks the most recent message rev per convoId we have processed.
  const lastRev = new Map<string, string>();

  // --- Seed phase: snapshot current convo state without dispatching ---
  try {
    const seedConvos = await fetchAllConvos(agent, null);
    for (const convo of seedConvos) {
      const msg = convo.lastMessage;
      if (msg && "rev" in msg && msg.rev) {
        lastRev.set(convo.id, msg.rev);
      }
    }
    logVerbose(`Bluesky: seeded ${lastRev.size} conversation(s) for polling`);
  } catch (err) {
    callbacks.onError?.(err instanceof Error ? err : new Error(String(err)), "seed");
  }

  let intervalMs = MIN_POLL_MS;

  return new Promise<void>((resolve) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      resolve();
    };

    abortSignal.addEventListener("abort", stop, { once: true });

    const poll = async () => {
      if (abortSignal.aborted) {
        stop();
        return;
      }

      let hadActivity = false;

      try {
        const convos = await fetchAllConvos(agent, lastRev);

        for (const convo of convos) {
          const msg = convo.lastMessage;
          if (!msg || !("rev" in msg) || !msg.rev) {
            continue;
          }

          const prev = lastRev.get(convo.id);

          // No change in this conversation
          if (prev !== undefined && msg.rev <= prev) {
            continue;
          }

          // New activity detected — fetch full messages to find exactly what's new
          const {
            messages: newMessages,
            oldestRevSeen,
            hitPageCap,
          } = await fetchNewMessages(agent, convo.id, selfDid, prev ?? "");

          if (newMessages.length > 0) {
            hadActivity = true;
            // When we hit the page cap there are older unseen messages; advance
            // the watermark only to the oldest rev we examined so the next poll
            // cycle fetches the remainder rather than skipping it permanently.
            const newWatermark = hitPageCap && oldestRevSeen ? oldestRevSeen : msg.rev;
            lastRev.set(convo.id, newWatermark);

            logVerbose(
              `Bluesky: ${newMessages.length} new message(s) in convo ${convo.id} (watermark=${newWatermark}${hitPageCap ? ", page-cap hit" : ""})`,
            );

            for (const inbound of newMessages) {
              if (abortSignal.aborted) {
                stop();
                return;
              }
              try {
                await callbacks.onMessage(inbound);
              } catch (err) {
                callbacks.onError?.(
                  err instanceof Error ? err : new Error(String(err)),
                  `dispatch:${inbound.convoId}`,
                );
              }
            }
          } else {
            // Rev changed but only our own messages — still update watermark
            lastRev.set(convo.id, msg.rev);
          }
        }
      } catch (err) {
        callbacks.onError?.(err instanceof Error ? err : new Error(String(err)), "poll");
      }

      intervalMs = nextPollMs(intervalMs, hadActivity);

      if (!abortSignal.aborted) {
        logVerbose(`Bluesky: next poll in ${intervalMs}ms (activity=${hadActivity})`);
        timeoutHandle = setTimeout(() => {
          void poll();
        }, intervalMs);
      } else {
        stop();
      }
    };

    // Kick off first poll after MIN_POLL_MS
    timeoutHandle = setTimeout(() => {
      void poll();
    }, MIN_POLL_MS);
  });
}

export type { InboundMessage };
