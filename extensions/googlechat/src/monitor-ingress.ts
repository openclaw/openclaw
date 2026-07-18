// Googlechat plugin module owns raw webhook durable admission and draining.
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
import { GoogleChatEventPayloadError, parseGoogleChatInboundPayload } from "./monitor-event.js";
import { getGoogleChatRuntime } from "./runtime.js";
import type { GoogleChatEvent } from "./types.js";

const GOOGLECHAT_INGRESS_PAYLOAD_VERSION = 1;
const GOOGLECHAT_INGRESS_POLL_INTERVAL_MS = 500;
const GOOGLECHAT_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const GOOGLECHAT_INGRESS_MAX_CONCURRENT_DELIVERIES = 8;
const GOOGLECHAT_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
// The webhook retry horizon must fit beneath this cap; match Slack/Mattermost fleet sizing.
// The 30-day TTL is the real horizon, while the cap only bounds disk usage.
const GOOGLECHAT_INGRESS_COMPLETED_MAX_ENTRIES = 20_000;
const GOOGLECHAT_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const GOOGLECHAT_INGRESS_FAILED_MAX_ENTRIES = 20_000;

type GoogleChatIngressPayload = {
  version: 1;
  rawEvent: string;
};

export type GoogleChatIngressLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

type GoogleChatIngressDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

type GoogleChatIngressDispatch = (
  event: GoogleChatEvent,
  lifecycle: GoogleChatIngressLifecycle,
) => Promise<GoogleChatIngressDispatchResult | void> | GoogleChatIngressDispatchResult | void;

class GoogleChatIngressPermanentError extends Error {
  constructor(
    readonly reason: "invalid-event" | "googlechat-auth",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GoogleChatIngressPermanentError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new GoogleChatIngressPermanentError(
    "invalid-event",
    `Google Chat MESSAGE event is missing ${field}.`,
  );
}

function inspectGoogleChatIngressEvent(raw: unknown): { eventId: string; laneKey: string } | null {
  if (!isRecord(raw)) {
    throw new GoogleChatIngressPermanentError(
      "invalid-event",
      "Google Chat webhook envelope must be an object.",
    );
  }

  const commonEventObject = isRecord(raw.commonEventObject) ? raw.commonEventObject : null;
  const chat = isRecord(raw.chat) ? raw.chat : null;
  const isAddOn = commonEventObject?.hostApp === "CHAT";
  let eventType: unknown = raw.type ?? raw.eventType;
  let space: Record<string, unknown> | null = isRecord(raw.space) ? raw.space : null;
  let message: Record<string, unknown> | null = isRecord(raw.message) ? raw.message : null;

  if (isAddOn) {
    const messagePayload = isRecord(chat?.messagePayload) ? chat.messagePayload : null;
    if (!messagePayload) {
      // Card clicks and other Add-on actions do not start agent turns.
      return null;
    }
    eventType = "MESSAGE";
    space = isRecord(messagePayload.space) ? messagePayload.space : null;
    message = isRecord(messagePayload.message) ? messagePayload.message : null;
  }

  if (eventType !== "MESSAGE") {
    return null;
  }
  const spaceName = requiredString(space?.name, "space.name");
  const messageName = requiredString(message?.name, "message.name");
  return { eventId: messageName, laneKey: `space:${spaceName}` };
}

function parseClaimedGoogleChatEvent(
  payload: GoogleChatIngressPayload,
  claimedId: string,
): GoogleChatEvent {
  if (
    payload.version !== GOOGLECHAT_INGRESS_PAYLOAD_VERSION ||
    typeof payload.rawEvent !== "string"
  ) {
    throw new GoogleChatIngressPermanentError(
      "invalid-event",
      `Google Chat ingress row ${claimedId} has an invalid payload.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload.rawEvent);
  } catch (error) {
    throw new GoogleChatIngressPermanentError(
      "invalid-event",
      `Google Chat ingress row ${claimedId} contains invalid JSON.`,
      { cause: error },
    );
  }
  const facts = inspectGoogleChatIngressEvent(raw);
  if (!facts || facts.eventId !== claimedId) {
    throw new GoogleChatIngressPermanentError(
      "invalid-event",
      `Google Chat ingress row ${claimedId} has invalid message identity.`,
    );
  }
  try {
    const parsed = parseGoogleChatInboundPayload(raw);
    const eventType = parsed.event.type ?? parsed.event.eventType;
    if (eventType !== "MESSAGE") {
      throw new GoogleChatEventPayloadError();
    }
    return parsed.event;
  } catch (error) {
    throw new GoogleChatIngressPermanentError(
      "invalid-event",
      `Google Chat ingress row ${claimedId} cannot be normalized.`,
      { cause: error },
    );
  }
}

function resolveGoogleChatIngressNonRetryableFailure(error: unknown) {
  for (const candidate of collectErrorGraphCandidates(error, (current) => [current.cause])) {
    if (candidate instanceof GoogleChatIngressPermanentError) {
      return { reason: candidate.reason, message: candidate.message };
    }
    const message = formatErrorMessage(candidate);
    if (
      /Google Chat API 401\b/.test(message) ||
      /^(?:Missing Google Chat access token|Google Chat (?:credentials|service account)\b|(?:Failed to load|Invalid) Google Chat service account\b)/.test(
        message,
      )
    ) {
      return { reason: "googlechat-auth", message };
    }
  }
  return null;
}

export type GoogleChatIngressMonitor = {
  receive: (
    rawEvent: unknown,
  ) => Promise<{ kind: "durable" | "ignored" } | { kind: "invalid"; message: string }>;
  start: () => void;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createGoogleChatIngressMonitor(options: {
  accountId: string;
  queue?: ChannelIngressQueue<GoogleChatIngressPayload>;
  dispatch: GoogleChatIngressDispatch;
  runtime: {
    error?: (message: string) => void;
    log?: (message: string) => void;
  };
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): GoogleChatIngressMonitor {
  let queue = options.queue;
  let drain: ChannelIngressDrain | undefined;
  let running = false;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastPrunedAt = 0;
  const activeDeliveries = new Set<Promise<GoogleChatIngressDispatchResult | void>>();

  const getQueue = (): ChannelIngressQueue<GoogleChatIngressPayload> => {
    queue ??= getGoogleChatRuntime().state.openChannelIngressQueue<GoogleChatIngressPayload>({
      accountId: options.accountId,
    });
    return queue;
  };

  const getDrain = (): ChannelIngressDrain => {
    drain ??= createChannelIngressDrain<GoogleChatIngressPayload>({
      queue: getQueue(),
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      startLimit: GOOGLECHAT_INGRESS_MAX_CONCURRENT_DELIVERIES,
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      },
      resolveNonRetryableFailure: resolveGoogleChatIngressNonRetryableFailure,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      onLog: (message) => options.runtime.error?.(`googlechat: ${message}`),
      dispatchClaimedEvent: async (record, lifecycle) => {
        if (lifecycle.abortSignal.aborted) {
          return { kind: "failed-retryable", error: lifecycle.abortSignal.reason };
        }
        const event = parseClaimedGoogleChatEvent(record.payload, record.id);
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
    if (now - lastPrunedAt < GOOGLECHAT_INGRESS_PRUNE_INTERVAL_MS) {
      return;
    }
    await getQueue().prune({
      completedTtlMs: GOOGLECHAT_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: GOOGLECHAT_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: GOOGLECHAT_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: GOOGLECHAT_INGRESS_FAILED_MAX_ENTRIES,
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
            !running || activeDeliveries.size >= GOOGLECHAT_INGRESS_MAX_CONCURRENT_DELIVERIES,
        });
        await waitForActiveDeliveries();
        if (!running || (!requested && started === 0)) {
          break;
        }
      }
    } catch (error) {
      options.runtime.error?.(`googlechat ingress drain failed: ${formatErrorMessage(error)}`);
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

  // Serialize concurrent HTTP admissions so append retry cannot invert a space lane.
  let admissionTail: Promise<void> = Promise.resolve();

  const serializeForIngress = (rawEvent: unknown): string => {
    if (!isRecord(rawEvent)) {
      throw new GoogleChatIngressPermanentError(
        "invalid-event",
        "Google Chat webhook envelope must be an object.",
      );
    }
    const durableEvent = { ...rawEvent };
    // Authentication is complete before admission; no Add-on authorization token is replay data.
    delete durableEvent.authorizationEventObject;
    const serialized = JSON.stringify(durableEvent);
    if (typeof serialized !== "string") {
      throw new GoogleChatIngressPermanentError(
        "invalid-event",
        "Google Chat webhook envelope cannot be serialized.",
      );
    }
    return serialized;
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
          { version: GOOGLECHAT_INGRESS_PAYLOAD_VERSION, rawEvent: params.rawEvent },
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
        throw new Error("Google Chat ingress is stopped.");
      }
      let facts: ReturnType<typeof inspectGoogleChatIngressEvent>;
      try {
        facts = inspectGoogleChatIngressEvent(rawEvent);
      } catch (error) {
        if (error instanceof GoogleChatIngressPermanentError) {
          return { kind: "invalid", message: error.message };
        }
        throw error;
      }
      if (!facts) {
        return { kind: "ignored" };
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
        options.pollIntervalMs ?? GOOGLECHAT_INGRESS_POLL_INTERVAL_MS,
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
