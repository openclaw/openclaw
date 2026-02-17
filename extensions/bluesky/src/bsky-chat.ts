import type { AtpAgent } from "@atproto/api";
import type { BlueskySession } from "./bsky-session.js";
import { createBlueskySession } from "./bsky-session.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./types.js";

export interface BlueskyMessageEvent {
  senderDid: string;
  text: string;
  convoId: string;
  messageId: string;
}

export interface BleskyChatOptions {
  identifier: string;
  appPassword: string;
  service: string;
  pollIntervalMs?: number;
  onMessage: (
    senderDid: string,
    text: string,
    reply: (text: string) => Promise<void>,
  ) => Promise<void>;
  onError?: (error: Error, context: string) => void;
  onConnect?: () => void;
}

export interface BleskyChatHandle {
  close: () => void;
  sendDm: (recipientDid: string, text: string) => Promise<void>;
}

// Chat proxy service header required for DM API calls
const CHAT_PROXY_HEADER = "atproto-proxy";
const CHAT_PROXY_VALUE = "did:web:api.bsky.chat#bsky_chat";

/**
 * Add the chat proxy header to the agent for DM API calls.
 * Bluesky routes chat requests through a separate service.
 */
function withChatProxy(agent: AtpAgent): Record<string, string> {
  return { [CHAT_PROXY_HEADER]: CHAT_PROXY_VALUE };
}

/**
 * Start the Bluesky chat polling bus.
 * Polls for new DMs and delivers them via onMessage callback.
 */
export async function startBlueskyChat(opts: BleskyChatOptions): Promise<BleskyChatHandle> {
  const session: BlueskySession = await createBlueskySession({
    identifier: opts.identifier,
    appPassword: opts.appPassword,
    service: opts.service,
  });

  const { agent, did: myDid } = session;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const seenMessageIds = new Set<string>();

  let running = true;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  // Track cursor for each conversation to only fetch new messages
  const convoCursors = new Map<string, string>();

  /**
   * Poll for new messages across all conversations.
   */
  async function poll(): Promise<void> {
    if (!running) return;

    try {
      // List all conversations
      const convosResponse = await agent.api.chat.bsky.convo.listConvos(
        {},
        { headers: withChatProxy(agent) },
      );

      const convos = convosResponse.data.convos ?? [];

      for (const convo of convos) {
        if (!running) break;

        try {
          // Get messages for this conversation
          const cursor = convoCursors.get(convo.id);
          const messagesResponse = await agent.api.chat.bsky.convo.getMessages(
            { convoId: convo.id, cursor },
            { headers: withChatProxy(agent) },
          );

          const messages = messagesResponse.data.messages ?? [];

          // Update cursor for next poll
          if (messagesResponse.data.cursor) {
            convoCursors.set(convo.id, messagesResponse.data.cursor);
          }

          for (const message of messages) {
            // Skip non-message records (deleted messages, etc.)
            if (message.$type !== "chat.bsky.convo.defs#messageView") continue;

            const msg = message as {
              id: string;
              sender: { did: string };
              text?: string;
            };

            // Skip our own messages
            if (msg.sender.did === myDid) continue;

            // Skip already-seen messages
            if (seenMessageIds.has(msg.id)) continue;
            seenMessageIds.add(msg.id);

            // Cap the seen set to avoid unbounded memory growth
            if (seenMessageIds.size > 10000) {
              const iterator = seenMessageIds.values();
              for (let i = 0; i < 5000; i++) {
                const next = iterator.next();
                if (next.done) break;
                seenMessageIds.delete(next.value);
              }
            }

            const text = msg.text ?? "";
            if (!text.trim()) continue;

            const senderDid = msg.sender.did;
            const convoId = convo.id;

            // Deliver the message
            try {
              await opts.onMessage(senderDid, text, async (replyText: string) => {
                await sendMessageToConvo(agent, convoId, replyText);
              });
            } catch (err) {
              opts.onError?.(
                err instanceof Error ? err : new Error(String(err)),
                "onMessage handler",
              );
            }
          }
        } catch (err) {
          opts.onError?.(
            err instanceof Error ? err : new Error(String(err)),
            `getMessages for convo ${convo.id}`,
          );
        }
      }
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)), "listConvos");
    }

    // Schedule next poll
    if (running) {
      pollTimer = setTimeout(() => void poll(), pollIntervalMs);
    }
  }

  /**
   * Send a message to an existing conversation.
   */
  async function sendMessageToConvo(agent: AtpAgent, convoId: string, text: string): Promise<void> {
    await agent.api.chat.bsky.convo.sendMessage(
      { convoId, message: { text } },
      {
        headers: withChatProxy(agent),
        encoding: "application/json",
      },
    );
  }

  /**
   * Send a DM to a user by DID.
   * Resolves or creates the conversation first.
   */
  async function sendDm(recipientDid: string, text: string): Promise<void> {
    // Resolve handle to DID if needed
    let did = recipientDid;
    if (!recipientDid.startsWith("did:")) {
      const resolved = await agent.resolveHandle({ handle: recipientDid });
      did = resolved.data.did;
    }

    // Get or create conversation with this user
    const convoResponse = await agent.api.chat.bsky.convo.getConvoForMembers(
      { members: [did] },
      { headers: withChatProxy(agent) },
    );

    const convoId = convoResponse.data.convo.id;
    await sendMessageToConvo(agent, convoId, text);
  }

  // Start polling
  opts.onConnect?.();

  // Do initial poll to seed cursors (mark existing messages as seen)
  try {
    const convosResponse = await agent.api.chat.bsky.convo.listConvos(
      {},
      { headers: withChatProxy(agent) },
    );
    for (const convo of convosResponse.data.convos ?? []) {
      const messagesResponse = await agent.api.chat.bsky.convo.getMessages(
        { convoId: convo.id },
        { headers: withChatProxy(agent) },
      );
      // Mark all existing messages as seen
      for (const msg of messagesResponse.data.messages ?? []) {
        if (msg.$type === "chat.bsky.convo.defs#messageView") {
          seenMessageIds.add((msg as { id: string }).id);
        }
      }
      if (messagesResponse.data.cursor) {
        convoCursors.set(convo.id, messagesResponse.data.cursor);
      }
    }
  } catch (err) {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)), "initial message seeding");
  }

  // Begin the poll loop
  pollTimer = setTimeout(() => void poll(), pollIntervalMs);

  return {
    close: () => {
      running = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    },
    sendDm,
  };
}
