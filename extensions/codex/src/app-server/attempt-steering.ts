/**
 * Debounced steering queue for forwarding user text to an active Codex
 * app-server turn.
 */
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import { buildCodexUserInput } from "./user-input.js";

const CODEX_STEER_ALL_DEBOUNCE_MS = 500;

/** Per-message options for Codex steering queue behavior. */
export type CodexSteeringQueueOptions = {
  debounceMs?: number;
  images?: EmbeddedRunAttemptParams["images"];
};

/**
 * Creates a queue that batches steer text while still serializing app-server
 * `turn/steer` requests.
 */
export function createCodexSteeringQueue(params: {
  client: CodexAppServerClient;
  threadId: string;
  turnId: string;
  claimPendingUserInput: () =>
    | {
        answer: (text: string) => boolean;
        cancel: () => boolean;
      }
    | undefined;
  signal: AbortSignal;
}) {
  type SteerMessage = {
    text?: string;
    images?: EmbeddedRunAttemptParams["images"];
  };
  type PendingSteerMessage = SteerMessage & {
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  let batchedMessages: PendingSteerMessage[] = [];
  let batchTimer: NodeJS.Timeout | undefined;
  let sendChain: Promise<void> = Promise.resolve();

  const clearBatchTimer = () => {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
  };

  const sendMessages = async (messages: SteerMessage[]) => {
    if (messages.length === 0) {
      return;
    }
    if (params.signal.aborted) {
      throw new Error("codex app-server steering queue aborted");
    }
    await params.client.request("turn/steer", {
      threadId: params.threadId,
      expectedTurnId: params.turnId,
      input: messages.flatMap((message) => buildCodexUserInput(message.text, message.images)),
    });
  };

  const enqueueSend = (messages: SteerMessage[]) => {
    const send = sendChain.then(() => sendMessages(messages));
    // A rejected steer means this active turn can no longer accept queued input.
    // Keep the chain rejected so later messages fall back in order instead of
    // overtaking the failed message with another turn/steer request.
    sendChain = send;
    void send.catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server queued steer failed", { error });
    });
    return send;
  };

  const flushBatch = (): Promise<void> => {
    clearBatchTimer();
    const items = batchedMessages;
    batchedMessages = [];
    const send = enqueueSend(items);
    void send.then(
      () => {
        for (const item of items) {
          item.resolve();
        }
      },
      (error: unknown) => {
        for (const item of items) {
          item.reject(error);
        }
      },
    );
    return send;
  };

  const flushBatchDetached = () => {
    void flushBatch().catch(() => undefined);
  };

  return {
    async queue(text: string, options?: CodexSteeringQueueOptions) {
      const pendingUserInput = params.claimPendingUserInput();
      if (pendingUserInput) {
        if (!options?.images?.length) {
          pendingUserInput.answer(text);
          return;
        }
        // request_user_input blocks the active turn, and its response cannot carry
        // images. Queue the complete user message first, then cancel the prompt.
        flushBatchDetached();
        try {
          await enqueueSend([{ text, images: options.images }]);
        } finally {
          // A rejected steer falls back to a normal follow-up. Release the blocked
          // turn without partially consuming the user's text in either outcome.
          pendingUserInput.cancel();
        }
        return;
      }
      return await new Promise<void>((resolve, reject) => {
        batchedMessages.push({
          text,
          images: options?.images,
          resolve,
          reject,
        });
        clearBatchTimer();
        const debounceMs = normalizeCodexSteerDebounceMs(options?.debounceMs);
        if (debounceMs === 0) {
          flushBatchDetached();
          return;
        }
        batchTimer = setTimeout(() => {
          batchTimer = undefined;
          flushBatchDetached();
        }, debounceMs);
      });
    },
    async flushPending() {
      await flushBatch().catch(() => undefined);
    },
    cancel() {
      clearBatchTimer();
      const items = batchedMessages;
      batchedMessages = [];
      for (const item of items) {
        item.reject(new Error("codex app-server steering queue cancelled"));
      }
    },
  };
}

/** Normalizes steer debounce milliseconds, preserving explicit zero. */
function normalizeCodexSteerDebounceMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : CODEX_STEER_ALL_DEBOUNCE_MS;
}
