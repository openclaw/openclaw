/**
 * Debounced steering queue for forwarding user messages to an active Codex
 * app-server turn.
 */
import {
  embeddedAgentLog,
  type AgentMessage,
  type queueAgentHarnessMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerIndeterminateTransportError,
  type CodexAppServerClient,
} from "./client.js";
import type { CodexUserInput } from "./protocol.js";

const CODEX_STEER_ALL_DEBOUNCE_MS = 500;
type AgentHarnessQueueMessageOptions = NonNullable<Parameters<typeof queueAgentHarnessMessage>[2]>;

export class CodexSteeringAcceptedUnconfirmedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexSteeringAcceptedUnconfirmedError";
  }
}

/** Per-message options for Codex steering queue behavior. */
export type CodexSteeringQueueOptions = Pick<
  AgentHarnessQueueMessageOptions,
  | "debounceMs"
  | "images"
  | "imageOrder"
  | "media"
  | "isInboundUserMessage"
  | "onQueueAccepted"
  | "userTurnTranscriptRecorder"
>;

type CodexSteeringCommitItem = Pick<
  CodexSteeringQueueOptions,
  "isInboundUserMessage" | "userTurnTranscriptRecorder"
>;

/**
 * Creates a queue that batches steer messages while still serializing
 * app-server `turn/steer` requests.
 */
export function createCodexSteeringQueue(params: {
  client: CodexAppServerClient;
  threadId: string;
  turnId: string;
  requestTimeoutMs: number;
  signal: AbortSignal;
  assertActive: () => void;
  prepareMessage: (
    text: string,
    options: CodexSteeringQueueOptions,
  ) => Promise<{
    input: CodexUserInput[];
    message: AgentMessage;
  }>;
  beforeSubmit?: (items: readonly CodexSteeringCommitItem[]) => Promise<void>;
}) {
  type PendingSteerMessage = CodexSteeringQueueOptions & {
    assertCurrent: () => void;
    acceptance: "open" | "accepted" | "rejected";
    text: string;
    resolve: () => void;
    reject: (error: unknown) => void;
    settled: boolean;
  };
  type PreparedSteerMessage = PendingSteerMessage & {
    prepared: Awaited<ReturnType<typeof params.prepareMessage>>;
  };
  type PendingSteerBatch = { items: PreparedSteerMessage[] };
  const acceptedMessages: AgentMessage[] = [];
  let batchedMessages: PendingSteerMessage[] = [];
  const dispatchedBatches = new Map<string, PendingSteerBatch>();
  const pendingMessages = new Set<PendingSteerMessage>();
  let batchTimer: NodeJS.Timeout | undefined;
  let batchSequence = 0;
  let sendChain: Promise<void> = Promise.resolve();
  let sealedError: Error | undefined;
  let closedError: Error | undefined;

  const assertActive = () => {
    const unavailableError = closedError ?? sealedError;
    if (unavailableError) {
      throw unavailableError;
    }
    params.signal.throwIfAborted();
    params.assertActive();
  };

  const clearBatchTimer = () => {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
  };

  const reportItemAcceptance = (item: PendingSteerMessage, accepted: boolean) => {
    if (item.acceptance !== "open") {
      return;
    }
    item.acceptance = accepted ? "accepted" : "rejected";
    item.onQueueAccepted?.(accepted);
  };

  // Cancellation removes wire batches; their accepted input still belongs to a refresh handoff.
  const acceptItem = (item: PreparedSteerMessage) => {
    if (item.acceptance === "open") {
      acceptedMessages.push(item.prepared.message);
    }
    reportItemAcceptance(item, true);
  };

  const resolveItem = (item: PreparedSteerMessage) => {
    if (item.settled) {
      return;
    }
    acceptItem(item);
    item.settled = true;
    pendingMessages.delete(item);
    item.resolve();
  };

  const rejectItem = (item: PendingSteerMessage, error: unknown) => {
    if (item.settled) {
      return;
    }
    item.settled = true;
    pendingMessages.delete(item);
    reportItemAcceptance(item, false);
    item.reject(
      item.acceptance === "accepted"
        ? new CodexSteeringAcceptedUnconfirmedError(
            "Codex accepted steering but did not confirm transcript consumption",
            { cause: error },
          )
        : error,
    );
  };

  const closeQueue = (error: Error) => {
    if (closedError) {
      return;
    }
    closedError = error;
    params.signal.removeEventListener("abort", abortQueue);
    clearBatchTimer();
    batchedMessages = [];
    // An issued RPC may have reached Codex before its response. Fence wire-dispatched
    // batches as accepted-unconfirmed so terminal cancellation cannot replay them.
    for (const batch of dispatchedBatches.values()) {
      for (const item of batch.items) {
        acceptItem(item);
      }
    }
    dispatchedBatches.clear();
    for (const item of pendingMessages) {
      rejectItem(item, error);
    }
  };
  const sealQueueAdmission = () => {
    if (sealedError || closedError) {
      return;
    }
    sealedError = new Error("codex app-server steering queue admission sealed");
    clearBatchTimer();
    batchedMessages = [];
    const dispatchedItems = new Set<PendingSteerMessage>(
      [...dispatchedBatches.values()].flatMap((batch) => batch.items),
    );
    // Terminal receipt closes admission immediately, but a user-message
    // completion already ahead of it on the wire still owns its dispatched batch.
    for (const item of pendingMessages) {
      if (!dispatchedItems.has(item)) {
        rejectItem(item, sealedError);
      }
    }
  };
  const abortQueue = () => {
    closeQueue(new Error("codex app-server steering queue aborted"));
  };
  const cancelQueue = () => {
    closeQueue(new Error("codex app-server steering queue cancelled"));
  };

  const sendBatch = async (items: PendingSteerMessage[]) => {
    const pendingItems = items.filter((item) => !item.settled);
    let liveItems: PreparedSteerMessage[] = [];
    if (pendingItems.length === 0) {
      return;
    }
    let clientUserMessageId: string | undefined;
    let skippedRevokedBatch = false;
    try {
      assertActive();
      const prepared: PreparedSteerMessage[] = [];
      const isCurrent = (item: PendingSteerMessage) => {
        if (item.settled) {
          return false;
        }
        try {
          item.assertCurrent();
          return true;
        } catch (error) {
          rejectItem(item, error);
          return false;
        }
      };
      // Reserve sendChain ownership before any preparation so later text cannot
      // overtake an image read. Preparing input has not crossed the wire boundary.
      for (const item of pendingItems) {
        if (!isCurrent(item)) {
          continue;
        }
        try {
          prepared.push(
            Object.assign(item, {
              prepared: await params.prepareMessage(item.text, item),
            }),
          );
        } catch (error) {
          if (isCurrent(item)) {
            throw error;
          }
        }
        assertActive();
        isCurrent(item);
      }
      liveItems = prepared.filter(isCurrent);
      if (liveItems.length === 0) {
        return;
      }
      if (params.beforeSubmit) {
        // Codex may consume input before replying. Commit source custody before
        // crossing that boundary, then revalidate owners after the awaited write.
        await params.beforeSubmit(liveItems);
        assertActive();
        liveItems = liveItems.filter(isCurrent);
        if (liveItems.length === 0) {
          return;
        }
      }
      // No await between final owner validation and RPC dispatch. Only these
      // batches become accepted-unconfirmed if cancellation races the response.
      clientUserMessageId = `openclaw:${params.turnId}:steer:${++batchSequence}`;
      dispatchedBatches.set(clientUserMessageId, { items: liveItems });
      const request = {
        threadId: params.threadId,
        expectedTurnId: params.turnId,
        input: liveItems.flatMap((item) => item.prepared.input),
        clientUserMessageId,
      };
      // turn/steer is an ack, but nothing guarantees the app-server answers it.
      // Without a deadline and the run signal the caller only unblocks when the
      // app-server client closes, which strands whichever channel handler is
      // awaiting delivery and wedges every later steer behind sendChain.
      await params.client.request("turn/steer", request, {
        timeoutMs: params.requestTimeoutMs,
        signal: params.signal,
        assertCurrent: () => {
          assertActive();
          // A later preparation or overload retry can revoke earlier items.
          // Rebuild only surviving material immediately before each physical write.
          liveItems = liveItems.filter(isCurrent);
          request.input = liveItems.flatMap((item) => item.prepared.input);
          dispatchedBatches.set(request.clientUserMessageId, { items: liveItems });
          if (liveItems.length === 0) {
            skippedRevokedBatch = true;
            throw new Error("Codex steering batch has no authorized inputs");
          }
        },
      });
      for (const item of liveItems) {
        acceptItem(item);
      }
    } catch (error) {
      if (clientUserMessageId) {
        dispatchedBatches.delete(clientUserMessageId);
      }
      if (skippedRevokedBatch) {
        return;
      }
      const acceptedUnconfirmed =
        clientUserMessageId !== undefined &&
        (isCodexAppServerIndeterminateRequestCancellationError(error) ||
          isCodexAppServerIndeterminateTransportError(error));
      if (acceptedUnconfirmed) {
        for (const item of liveItems) {
          acceptItem(item);
        }
      }
      for (const item of items) {
        rejectItem(item, error);
      }
      throw error;
    }
  };

  const enqueueSend = (items: PendingSteerMessage[]) => {
    const send = sendChain.then(() => sendBatch(items));
    // Preserve submission order after rejection: later messages must fall back
    // instead of overtaking the failed message with another turn/steer request.
    sendChain = send;
    void send.catch((error: unknown) => {
      for (const item of items) {
        rejectItem(item, error);
      }
      embeddedAgentLog.debug("codex app-server queued steer failed", { error });
    });
    return send;
  };

  const flushBatch = (): Promise<void> => {
    clearBatchTimer();
    const items = batchedMessages;
    batchedMessages = [];
    if (items.length === 0) {
      return sendChain;
    }
    const send = enqueueSend(items);
    void send.catch(() => undefined);
    return send;
  };

  const createPendingMessage = (
    text: string,
    options?: CodexSteeringQueueOptions,
    assertCurrent: () => void = () => {},
  ): { item: PendingSteerMessage; delivery: Promise<void> } => {
    let resolveDelivery!: () => void;
    let rejectDelivery!: (error: unknown) => void;
    const delivery = new Promise<void>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    const item = {
      ...options,
      assertCurrent,
      acceptance: "open" as const,
      text,
      resolve: resolveDelivery,
      reject: rejectDelivery,
      settled: false,
    };
    pendingMessages.add(item);
    return { item, delivery };
  };

  params.signal.addEventListener("abort", abortQueue, { once: true });
  if (params.signal.aborted) {
    abortQueue();
  }

  return {
    async queue(
      text: string,
      options?: CodexSteeringQueueOptions,
      assertCurrent: () => void = () => {},
    ) {
      try {
        assertActive();
        assertCurrent();
      } catch (error) {
        options?.onQueueAccepted?.(false);
        throw error;
      }
      const { item, delivery } = createPendingMessage(text, options, assertCurrent);
      batchedMessages.push(item);
      clearBatchTimer();
      const debounceMs = normalizeCodexSteerDebounceMs(options?.debounceMs);
      if (debounceMs === 0) {
        void flushBatch();
      } else {
        batchTimer = setTimeout(() => {
          batchTimer = undefined;
          void flushBatch();
        }, debounceMs);
      }
      return await delivery;
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
    getAcceptedMessages: () => acceptedMessages.slice(),
    sealAdmission: sealQueueAdmission,
    cancel: cancelQueue,
  };
}

/** Normalizes steer debounce milliseconds, preserving explicit zero. */
function normalizeCodexSteerDebounceMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : CODEX_STEER_ALL_DEBOUNCE_MS;
}
