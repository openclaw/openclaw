import type { WebClient } from "@slack/web-api";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { getSlackWebApiErrorData } from "./errors.js";

type ParentState = "live" | "deleted" | "missing";

async function readReplyParent(
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<ParentState> {
  const read = async (ts: string) => {
    const result = await client.conversations.history({
      channel,
      oldest: ts,
      latest: ts,
      inclusive: true,
      limit: 1,
    });
    if (!result.ok || !result.messages) {
      throw new Error(result.error ?? "Slack returned no parent history");
    }
    return result.messages.find((message) => message.ts === ts);
  };
  let parent = await read(threadTs);
  let rootTs = parent?.thread_ts;
  if (!parent) {
    // Channel history omits ordinary replies. Resolve a child target, then check
    // the root in history: a surviving reply does not establish a live parent.
    try {
      const replies = await client.conversations.replies({ channel, ts: threadTs, limit: 1 });
      if (!replies.ok || !replies.messages) {
        throw new Error(replies.error ?? "Slack returned no thread history");
      }
      const first = replies.messages[0];
      rootTs = first?.thread_ts ?? first?.ts;
    } catch (error) {
      if (getSlackWebApiErrorData(error)?.error === "thread_not_found") {
        return "missing";
      }
      throw error;
    }
  }
  if (rootTs && (!parent || rootTs !== threadTs)) {
    parent = await read(rootTs);
  }
  if (!parent) {
    return "missing";
  }
  return parent.subtype === "tombstone" || parent.subtype === "message_deleted" ? "deleted" : "live";
}

/** One logical send. Recheck before each physical write, including a known-safe retry. */
export function createSlackSendDispatch(params: {
  readers?: WebClient[];
  channel: string;
  threadTs?: string;
  replyParentDeleted?: AbortSignal;
  onPlatformSendDispatch?: () => Promise<void>;
}): () => Promise<void> {
  let dispatched = false;
  function stop(message: string, retryable: boolean, cause?: unknown): never {
    // A previous part or attempt may have been accepted. Never invite replay of it.
    throw dispatched
      ? new Error(message, { cause })
      : new PlatformMessageNotDispatchedError(message, { cause, retryable });
  }
  function checkDeletion() {
    if (params.replyParentDeleted?.aborted) {
      stop("Slack reply parent was deleted; stopped sending to this thread", false);
    }
  }
  return async () => {
    checkDeletion();
    if (params.threadTs && params.readers) {
      let state: ParentState = "missing";
      let lookupError: unknown;
      for (const reader of params.readers) {
        try {
          state = await readReplyParent(reader, params.channel, params.threadTs);
        } catch (error) {
          lookupError = error;
        }
        checkDeletion();
        if (state !== "missing") {
          break;
        }
      }
      if (state === "missing" && lookupError) {
        const reason = lookupError instanceof Error ? lookupError.message : "parent lookup failed";
        stop(`Could not verify Slack reply parent before sending: ${reason}`, true, lookupError);
      }
      if (state !== "live") {
        stop(`Slack reply parent is ${state}; stopped sending to this thread`, false);
      }
    }
    if (!dispatched) {
      await params.onPlatformSendDispatch?.();
      checkDeletion();
      dispatched = true;
    }
  };
}
