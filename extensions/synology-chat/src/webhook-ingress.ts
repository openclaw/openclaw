// Synology Chat plugin owns raw webhook durable admission and draining.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getSynologyRuntime } from "./runtime.js";

const SYNOLOGY_INGRESS_PAYLOAD_VERSION = 1;
const SYNOLOGY_INGRESS_POLL_INTERVAL_MS = 500;
const SYNOLOGY_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const SYNOLOGY_INGRESS_MAX_CONCURRENT_DELIVERIES = 8;
const SYNOLOGY_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
// Synology does not publish a webhook retry horizon. Keep the fleet's conservative
// webhook cap so any duplicate POST retains its post_id tombstone.
const SYNOLOGY_INGRESS_COMPLETED_MAX_ENTRIES = 20_000;
const SYNOLOGY_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SYNOLOGY_INGRESS_FAILED_MAX_ENTRIES = 20_000;

export type SynologyWebhookRawEvent = {
  bodyFields: Record<string, unknown>;
  queryFields: Record<string, unknown>;
};

type SynologyIngressPayload = {
  version: 1;
  rawEvent: string;
};

export type SynologyIngressLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

type SynologyIngressDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

type SynologyIngressDispatch = (
  event: SynologyWebhookRawEvent,
  lifecycle: SynologyIngressLifecycle,
) => Promise<SynologyIngressDispatchResult | void> | SynologyIngressDispatchResult | void;

export class SynologyIngressPermanentError extends Error {
  constructor(
    readonly reason: "invalid-event" | "synology-auth",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SynologyIngressPermanentError";
  }
}

function firstNonEmptyString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = firstNonEmptyString(item);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function pickRawField(event: SynologyWebhookRawEvent, field: string): string | undefined {
  return (
    firstNonEmptyString(event.bodyFields[field]) ?? firstNonEmptyString(event.queryFields[field])
  );
}

function inspectSynologyIngressEvent(event: SynologyWebhookRawEvent): {
  eventId: string;
  laneKey: string;
} {
  const eventId = pickRawField(event, "post_id");
  if (!eventId) {
    throw new SynologyIngressPermanentError(
      "invalid-event",
      "Synology Chat webhook is missing post_id.",
    );
  }
  const userId =
    pickRawField(event, "user_id") ?? pickRawField(event, "userId") ?? pickRawField(event, "user");
  if (!userId) {
    throw new SynologyIngressPermanentError(
      "invalid-event",
      "Synology Chat webhook is missing user_id.",
    );
  }
  const channelId = pickRawField(event, "channel_id");
  return {
    eventId,
    laneKey: channelId ? `channel:${channelId}` : `direct:${userId}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClaimedSynologyEvent(
  payload: SynologyIngressPayload,
  claimedId: string,
): SynologyWebhookRawEvent {
  if (
    payload.version !== SYNOLOGY_INGRESS_PAYLOAD_VERSION ||
    typeof payload.rawEvent !== "string"
  ) {
    throw new SynologyIngressPermanentError(
      "invalid-event",
      `Synology Chat ingress row ${claimedId} has an invalid payload.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.rawEvent);
  } catch (error) {
    throw new SynologyIngressPermanentError(
      "invalid-event",
      `Synology Chat ingress row ${claimedId} contains invalid JSON.`,
      { cause: error },
    );
  }
  if (!isRecord(parsed) || !isRecord(parsed.bodyFields) || !isRecord(parsed.queryFields)) {
    throw new SynologyIngressPermanentError(
      "invalid-event",
      `Synology Chat ingress row ${claimedId} has an invalid webhook envelope.`,
    );
  }
  const event = {
    bodyFields: parsed.bodyFields,
    queryFields: parsed.queryFields,
  };
  if (inspectSynologyIngressEvent(event).eventId !== claimedId) {
    throw new SynologyIngressPermanentError(
      "invalid-event",
      `Synology Chat ingress row ${claimedId} has invalid message identity.`,
    );
  }
  return event;
}

function resolveSynologyIngressNonRetryableFailure(error: unknown) {
  for (const candidate of collectErrorGraphCandidates(error, (current) => [current.cause])) {
    if (candidate instanceof SynologyIngressPermanentError) {
      return { reason: candidate.reason, message: candidate.message };
    }
  }
  return null;
}

export type SynologyIngressMonitor = {
  receive: (
    rawEvent: SynologyWebhookRawEvent,
  ) => Promise<{ kind: "durable" } | { kind: "invalid"; message: string }>;
  start: () => void;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createSynologyIngressMonitor(options: {
  accountId: string;
  queue?: ChannelIngressQueue<SynologyIngressPayload>;
  dispatch: SynologyIngressDispatch;
  runtime: {
    error?: (message: string) => void;
  };
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): SynologyIngressMonitor {
  let queue = options.queue;
  let drain: ChannelIngressDrain | undefined;
  let running = false;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastPrunedAt = 0;
  const activeDeliveries = new Set<Promise<SynologyIngressDispatchResult | void>>();

  const getQueue = (): ChannelIngressQueue<SynologyIngressPayload> => {
    queue ??= getSynologyRuntime().state.openChannelIngressQueue<SynologyIngressPayload>({
      accountId: options.accountId,
    });
    return queue;
  };

  const getDrain = (): ChannelIngressDrain => {
    drain ??= createChannelIngressDrain<SynologyIngressPayload>({
      queue: getQueue(),
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      startLimit: SYNOLOGY_INGRESS_MAX_CONCURRENT_DELIVERIES,
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      },
      resolveNonRetryableFailure: resolveSynologyIngressNonRetryableFailure,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      onLog: (message) => options.runtime.error?.(`synology-chat: ${message}`),
      dispatchClaimedEvent: async (record, lifecycle) => {
        if (lifecycle.abortSignal.aborted) {
          return { kind: "failed-retryable", error: lifecycle.abortSignal.reason };
        }
        const event = parseClaimedSynologyEvent(record.payload, record.id);
        const boundLifecycle = bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle;
        if (boundLifecycle.abortSignal.aborted) {
          return { kind: "failed-retryable", error: boundLifecycle.abortSignal.reason };
        }
        const delivery = Promise.resolve().then(() => options.dispatch(event, boundLifecycle));
        activeDeliveries.add(delivery);
        try {
          return await delivery;
        } finally {
          activeDeliveries.delete(delivery);
        }
      },
    });
    return drain;
  };

  const pruneIfDue = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPrunedAt < SYNOLOGY_INGRESS_PRUNE_INTERVAL_MS) {
      return;
    }
    await getQueue().prune({
      completedTtlMs: SYNOLOGY_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: SYNOLOGY_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: SYNOLOGY_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: SYNOLOGY_INGRESS_FAILED_MAX_ENTRIES,
      now,
    });
    lastPrunedAt = now;
  };

  const waitForActiveDeliveries = async (): Promise<void> => {
    while (activeDeliveries.size > 0) {
      await Promise.allSettled(activeDeliveries);
    }
  };

  const runPump = async (): Promise<void> => {
    try {
      for (;;) {
        requested = false;
        await pruneIfDue();
        // stop() may race the async prune; never create a fresh drain afterward.
        if (!running) {
          break;
        }
        const activeDrain = getDrain();
        const { started } = await activeDrain.drainOnce({
          shouldStop: () =>
            !running || activeDeliveries.size >= SYNOLOGY_INGRESS_MAX_CONCURRENT_DELIVERIES,
        });
        await waitForActiveDeliveries();
        if (!running || (!requested && started === 0)) {
          break;
        }
      }
    } catch (error) {
      options.runtime.error?.(`synology-chat ingress drain failed: ${formatErrorMessage(error)}`);
    } finally {
      pumping = undefined;
      if (running && requested) {
        requestDrain();
      }
    }
  };

  const requestDrain = (): void => {
    requested = true;
    if (!running || pumping) {
      return;
    }
    pumping = runPump();
  };

  // Serialize concurrent HTTP admissions so append retry cannot invert a conversation lane.
  let admissionTail: Promise<void> = Promise.resolve();

  const serializeForIngress = (rawEvent: SynologyWebhookRawEvent): string => {
    const bodyFields = { ...rawEvent.bodyFields };
    const queryFields = { ...rawEvent.queryFields };
    // Authentication is complete before admission; tokens are not replay data.
    delete bodyFields.token;
    delete queryFields.token;
    return JSON.stringify({ bodyFields, queryFields });
  };

  const admitOnce = async (params: {
    rawEvent: string;
    facts: { eventId: string; laneKey: string };
    receivedAt: number;
  }): Promise<void> => {
    let lastError: unknown;
    for (const delayMs of [0, 100, 300]) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      try {
        await getQueue().enqueue(
          params.facts.eventId,
          { version: SYNOLOGY_INGRESS_PAYLOAD_VERSION, rawEvent: params.rawEvent },
          { receivedAt: params.receivedAt, laneKey: params.facts.laneKey },
        );
        requestDrain();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  return {
    receive: async (rawEvent) => {
      if (!running) {
        throw new Error("Synology Chat ingress is stopped.");
      }
      let facts: ReturnType<typeof inspectSynologyIngressEvent>;
      try {
        facts = inspectSynologyIngressEvent(rawEvent);
      } catch (error) {
        if (error instanceof SynologyIngressPermanentError) {
          return { kind: "invalid", message: error.message };
        }
        throw error;
      }
      const serialized = serializeForIngress(rawEvent);
      const receivedAt = Date.now();
      const admission = admissionTail.then(async () => {
        await admitOnce({ rawEvent: serialized, facts, receivedAt });
      });
      admissionTail = admission.catch(() => undefined);
      await admission;
      return { kind: "durable" };
    },
    start: () => {
      if (running) {
        return;
      }
      running = true;
      pollTimer = setInterval(
        requestDrain,
        options.pollIntervalMs ?? SYNOLOGY_INGRESS_POLL_INTERVAL_MS,
      );
      pollTimer.unref?.();
      requestDrain();
    },
    stop: async () => {
      running = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      await admissionTail;
      drain?.dispose();
      await pumping;
      await waitForActiveDeliveries();
      // The pump can lazily create the drain before observing running=false.
      drain?.dispose();
      await drain?.waitForIdle();
    },
    waitForIdle: async () => {
      for (;;) {
        const activePump = pumping;
        if (!activePump) {
          break;
        }
        await activePump;
      }
      await waitForActiveDeliveries();
      await drain?.waitForIdle();
    },
  };
}
