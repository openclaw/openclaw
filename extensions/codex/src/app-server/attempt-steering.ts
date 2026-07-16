/**
 * Debounced steering queue for forwarding user text to an active Codex
 * app-server turn.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexUserInput } from "./protocol.js";

const CODEX_STEER_ALL_DEBOUNCE_MS = 500;

/** Per-message options for Codex steering queue behavior. */
export type CodexSteeringQueueOptions = {
  debounceMs?: number;
};

/**
 * Creates a queue that batches steer text while still serializing app-server
 * `turn/steer` requests.
 */
export function createCodexSteeringQueue(params: {
  client: CodexAppServerClient;
  threadId: string;
  turnId: string;
  answerPendingUserInput: (text: string) => boolean;
  signal: AbortSignal;
}) {
  type PendingSteerText = {
    text: string;
    resolve: () => void;
    reject: (error: unknown) => void;
    settled: boolean;
  };
  type PendingSteerBatch = {
    items: PendingSteerText[];
  };
  let batchedTexts: PendingSteerText[] = [];
  const dispatchedBatches = new Map<string, PendingSteerBatch>();
  const pendingTexts = new Set<PendingSteerText>();
  let batchTimer: NodeJS.Timeout | undefined;
  let batchSequence = 0;
  let sendChain: Promise<void> = Promise.resolve();
  let closedError: Error | undefined;

  const clearBatchTimer = () => {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
  };

  const resolveItem = (item: PendingSteerText) => {
    if (item.settled) {
      return;
    }
    item.settled = true;
    pendingTexts.delete(item);
    item.resolve();
  };

  const rejectItem = (item: PendingSteerText, error: unknown) => {
    if (item.settled) {
      return;
    }
    item.settled = true;
    pendingTexts.delete(item);
    item.reject(error);
  };

  const closeQueue = (error: Error) => {
    if (closedError) {
      return;
    }
    closedError = error;
    params.signal.removeEventListener("abort", abortQueue);
    clearBatchTimer();
    batchedTexts = [];
    dispatchedBatches.clear();
    for (const item of pendingTexts) {
      rejectItem(item, error);
    }
  };
  const abortQueue = () => {
    closeQueue(new Error("codex app-server steering queue aborted"));
  };
  const cancelQueue = () => {
    closeQueue(new Error("codex app-server steering queue cancelled"));
  };

  const sendBatch = async (items: PendingSteerText[]) => {
    const liveItems = items.filter((item) => !item.settled);
    if (liveItems.length === 0) {
      return;
    }
    const unavailableError =
      closedError ??
      (params.signal.aborted ? new Error("codex app-server steering queue aborted") : undefined);
    if (unavailableError) {
      for (const item of liveItems) {
        rejectItem(item, unavailableError);
      }
      throw unavailableError;
    }
    const clientUserMessageId = `openclaw:${params.turnId}:steer:${++batchSequence}`;
    const batch = { items: liveItems };
    // RPC acceptance is not delivery: interrupt clears accepted pending input.
    // Keep the batch unsettled until Codex echoes this id on userMessage completion.
    dispatchedBatches.set(clientUserMessageId, batch);
    try {
      await params.client.request("turn/steer", {
        threadId: params.threadId,
        expectedTurnId: params.turnId,
        input: liveItems.map((item) => toCodexTextInput(item.text)),
        clientUserMessageId,
      });
    } catch (error) {
      dispatchedBatches.delete(clientUserMessageId);
      for (const item of liveItems) {
        rejectItem(item, error);
      }
      throw error;
    }
  };

  const enqueueSend = (items: PendingSteerText[]) => {
    const send = sendChain.then(() => sendBatch(items));
    sendChain = send.catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server queued steer failed", { error });
    });
    return send;
  };

  const flushBatch = () => {
    clearBatchTimer();
    const items = batchedTexts;
    batchedTexts = [];
    if (items.length === 0) {
      return sendChain;
    }
    const send = enqueueSend(items);
    void send.catch(() => undefined);
    return send;
  };

  params.signal.addEventListener("abort", abortQueue, { once: true });
  if (params.signal.aborted) {
    abortQueue();
  }

  return {
    async queue(text: string, options?: CodexSteeringQueueOptions) {
      if (params.answerPendingUserInput(text)) {
        return;
      }
      if (closedError) {
        throw closedError;
      }
      if (params.signal.aborted) {
        throw new Error("codex app-server steering queue aborted");
      }
      return await new Promise<void>((resolve, reject) => {
        const item = { text, resolve, reject, settled: false };
        batchedTexts.push(item);
        pendingTexts.add(item);
        clearBatchTimer();
        const debounceMs = normalizeCodexSteerDebounceMs(options?.debounceMs);
        if (debounceMs === 0) {
          void flushBatch();
          return;
        }
        batchTimer = setTimeout(() => {
          batchTimer = undefined;
          void flushBatch();
        }, debounceMs);
      });
    },
    async flushPending() {
      if (closedError) {
        return;
      }
      await flushBatch().catch(() => undefined);
    },
    confirmConsumed(clientUserMessageId: string) {
      const batch = dispatchedBatches.get(clientUserMessageId);
      if (!batch) {
        return false;
      }
      dispatchedBatches.delete(clientUserMessageId);
      for (const item of batch.items) {
        resolveItem(item);
      }
      return true;
    },
    cancel: cancelQueue,
  };
}

/** Normalizes steer debounce milliseconds, preserving explicit zero. */
function normalizeCodexSteerDebounceMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : CODEX_STEER_ALL_DEBOUNCE_MS;
}

/** Converts plain text into the Codex app-server user-input shape. */
function toCodexTextInput(text: string): CodexUserInput {
  return { type: "text", text, text_elements: [] };
}
