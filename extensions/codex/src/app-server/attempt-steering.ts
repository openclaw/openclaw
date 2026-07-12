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
  rejectSteering?: () => Error | undefined;
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
    dispatchedItems?: PendingSteerText[];
  };
  let batchedTexts: PendingSteerText[] = [];
  const deliveredBatches: PendingSteerText[][] = [];
  const pendingTexts = new Set<PendingSteerText>();
  let batchTimer: NodeJS.Timeout | undefined;
  let sendChain: Promise<void> = Promise.resolve();
  let dispatchingBatch: PendingSteerBatch | undefined;
  let paused = false;
  const dispatchWaiters = new Set<() => void>();

  const clearBatchTimer = () => {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
  };

  const sendTexts = async (texts: string[]) => {
    if (texts.length === 0) {
      return;
    }
    if (params.signal.aborted) {
      throw new Error("codex app-server steering queue aborted");
    }
    await params.client.request("turn/steer", {
      threadId: params.threadId,
      expectedTurnId: params.turnId,
      input: texts.map(toCodexTextInput),
    });
  };

  const wakeDispatchWaiters = () => {
    for (const wake of dispatchWaiters) {
      wake();
    }
    dispatchWaiters.clear();
  };

  const enqueueSend = (batch: PendingSteerBatch) => {
    const send = sendChain.then(async () => {
      while (true) {
        const liveItems = batch.items.filter((item) => !item.settled);
        if (liveItems.length === 0) {
          return;
        }
        if (!paused) {
          batch.dispatchedItems = liveItems;
          dispatchingBatch = batch;
          await sendTexts(liveItems.map((item) => item.text));
          return;
        }
        await new Promise<void>((resolve) => {
          dispatchWaiters.add(resolve);
        });
      }
    });
    sendChain = send.catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server queued steer failed", { error });
    });
    return send;
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

  const flushBatch = () => {
    clearBatchTimer();
    const items = batchedTexts;
    batchedTexts = [];
    const batch: PendingSteerBatch = { items };
    const send = enqueueSend(batch);
    void send.then(
      () => {
        const deliveredItems = (batch.dispatchedItems ?? []).filter((item) => !item.settled);
        if (deliveredItems.length > 0) {
          deliveredBatches.push(deliveredItems);
        }
        if (dispatchingBatch === batch) {
          dispatchingBatch = undefined;
        }
      },
      (error: unknown) => {
        for (const item of items) {
          rejectItem(item, error);
        }
        if (dispatchingBatch === batch) {
          dispatchingBatch = undefined;
        }
      },
    );
    return send;
  };

  return {
    async queue(text: string, options?: CodexSteeringQueueOptions) {
      if (params.answerPendingUserInput(text)) {
        return;
      }
      const unavailable = params.rejectSteering?.();
      if (unavailable) {
        throw unavailable;
      }
      return await new Promise<void>((resolve, reject) => {
        const item = { text, resolve, reject, settled: false };
        batchedTexts.push(item);
        pendingTexts.add(item);
        clearBatchTimer();
        if (paused) {
          return;
        }
        const debounceMs = normalizeCodexSteerDebounceMs(options?.debounceMs);
        if (debounceMs === 0) {
          void flushBatch().catch(() => undefined);
          return;
        }
        batchTimer = setTimeout(() => {
          batchTimer = undefined;
          void flushBatch().catch(() => undefined);
        }, debounceMs);
      });
    },
    async flushPending() {
      if (paused) {
        return;
      }
      await flushBatch().catch(() => undefined);
    },
    confirmConsumed(texts: readonly string[]) {
      const items = deliveredBatches[0] ?? dispatchingBatch?.dispatchedItems;
      if (
        !items ||
        items.length !== texts.length ||
        items.some((item, index) => item.text !== texts[index])
      ) {
        return false;
      }
      if (deliveredBatches[0] === items) {
        deliveredBatches.shift();
      }
      for (const item of items) {
        resolveItem(item);
      }
      return true;
    },
    pause() {
      paused = true;
      clearBatchTimer();
    },
    resume() {
      if (!paused) {
        return;
      }
      paused = false;
      if (batchedTexts.length > 0) {
        void flushBatch().catch(() => undefined);
      }
      wakeDispatchWaiters();
    },
    cancel() {
      clearBatchTimer();
      batchedTexts = [];
      deliveredBatches.length = 0;
      dispatchingBatch = undefined;
      const error = new Error("codex app-server steering queue cancelled");
      // A turn/steer request can already be accepted when terminal release
      // starts. Reject its logical delivery until Codex confirms consumption:
      // interrupting the old turn clears accepted-but-pending input.
      for (const item of pendingTexts) {
        rejectItem(item, error);
      }
      wakeDispatchWaiters();
    },
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
