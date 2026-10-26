import type { Event } from "nostr-tools";
import {
  createChannelIngressError,
  createChannelIngressMonitor,
  type ChannelIngressMonitorLifecycle,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  inspectNostrIngressEvent,
  migrateNostrLegacyRecentEventIds,
  NOSTR_INGRESS_PAYLOAD_VERSION,
  NostrIngressPermanentError,
  type NostrIngressPayload,
} from "./nostr-ingress-state.js";
import { getNostrRuntime } from "./runtime.js";

const NOSTR_INGRESS_POLL_INTERVAL_MS = 500;

export type NostrIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

export const NostrIngressAdmissionRejectedError = createChannelIngressError<
  "backpressure" | "oversized-event" | "rate-limited"
>("NostrIngressAdmissionRejectedError", { withReason: true });
export type NostrIngressAdmissionRejectedError = InstanceType<
  typeof NostrIngressAdmissionRejectedError
>;

function deserializeNostrIngressEvent(rawEvent: string, claimedId: string): Event {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch (error) {
    throw new NostrIngressPermanentError(
      "invalid-event",
      `Nostr ingress row ${claimedId} contains invalid JSON.`,
      { cause: error },
    );
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.kind !== "number" ||
    typeof parsed.created_at !== "number" ||
    typeof parsed.content !== "string" ||
    typeof parsed.sig !== "string" ||
    !Array.isArray(parsed.tags)
  ) {
    throw new NostrIngressPermanentError(
      "invalid-event",
      `Nostr ingress row ${claimedId} has an invalid event shape.`,
    );
  }
  return parsed as Event;
}

export function createNostrIngress(options: {
  accountId: string;
  queue?: ChannelIngressQueue<NostrIngressPayload>;
  legacyEventIds?: readonly string[];
  maxSerializedPayloadBytes: number;
  maxPendingEvents: number;
  maxQueuedAdmissions: number;
  admissionRateLimit: { windowMs: number; maxEvents: number };
  afterDurableAppend: (event: Event) => void;
  deliver: (event: Event, lifecycle: NostrIngressLifecycle) => Promise<void>;
  onError?: (error: Error, context: string) => void;
}) {
  let queue = options.queue;
  let admissionFailure: Error | undefined;
  let admissionWindowStartedAt = Date.now();
  let admissionWindowCount = 0;
  let queuedAdmissions = 0;
  let stopping = false;
  let stopTask: Promise<void> | undefined;

  const createStoppedError = () => new Error("Nostr ingress stopped");

  const getQueue = (): ChannelIngressQueue<NostrIngressPayload> => {
    queue ??= getNostrRuntime().state.openChannelIngressQueue<NostrIngressPayload>({
      accountId: options.accountId,
    });
    return queue;
  };

  type PreparedEvent = ReturnType<typeof prepareAdmission>;
  const monitor = createChannelIngressMonitor<
    PreparedEvent,
    { receivedAt: number; rawEvent: string },
    NostrIngressPayload
  >({
    queue: getQueue,
    inspect: ({ facts }) => facts,
    inspectAsync: async ({ facts }, context) => {
      if (context.phase === "admission") {
        await monitorStart;
        if (admissionFailure) {
          throw admissionFailure;
        }
        const pending = await getQueue().listPending({ limit: options.maxPendingEvents });
        const claims = await getQueue().listClaims();
        if (pending.length + claims.length >= options.maxPendingEvents) {
          throw new NostrIngressAdmissionRejectedError(
            "backpressure",
            "Nostr event exceeds the durable ingress backlog.",
          );
        }
      }
      return facts;
    },
    payload: {
      version: NOSTR_INGRESS_PAYLOAD_VERSION,
      serialize: ({ payload }) => ({
        receivedAt: payload.receivedAt,
        rawEvent: payload.rawEvent,
      }),
      deserialize: (body, { claim }) => {
        const event = deserializeNostrIngressEvent(body.rawEvent, claim.id);
        return {
          event,
          facts: inspectNostrIngressEvent(event),
          receivedAt: body.receivedAt,
          payload: { version: NOSTR_INGRESS_PAYLOAD_VERSION, ...body },
        };
      },
      encode: ({ body }) => ({ version: NOSTR_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload, { claim }) => {
        if (
          typeof payload !== "object" ||
          payload === null ||
          typeof payload.rawEvent !== "string"
        ) {
          throw new NostrIngressPermanentError(
            "invalid-event",
            `Nostr ingress row ${claim.id} has an invalid payload.`,
          );
        }
        return {
          version: payload.version,
          body: {
            receivedAt: typeof payload.receivedAt === "number" ? payload.receivedAt : 0,
            rawEvent: payload.rawEvent,
          },
        };
      },
      createClaimError: (kind, claim) =>
        new NostrIngressPermanentError(
          "invalid-event",
          kind === "invalid-version"
            ? `Nostr ingress row ${claim.id} has an unsupported version.`
            : `Nostr ingress row ${claim.id} changed event identity.`,
        ),
    },
    deliver: ({ event }, lifecycle) => options.deliver(event, lifecycle),
    onDurableAdmission: ({ event }) => options.afterDurableAppend(event),
    onAdmissionFailure: (_event, error) => {
      if (
        error instanceof NostrIngressAdmissionRejectedError ||
        error instanceof NostrIngressPermanentError
      ) {
        return;
      }
      admissionFailure ??= new Error(
        `Nostr durable admission failed: ${formatErrorMessage(error)}`,
        { cause: error },
      );
      throw admissionFailure;
    },
    pollIntervalMs: NOSTR_INGRESS_POLL_INTERVAL_MS,
    retention: {
      completedMaxEntries: 100_000,
      failedMaxEntries: 100_000,
    },
    drain: {
      resolveNonRetryableFailure: (error) =>
        error instanceof NostrIngressPermanentError
          ? { reason: error.reason, message: error.message }
          : null,
      onLog: (message) => options.onError?.(new Error(message), "ingress drain"),
    },
    createStoppedError,
    onError: (error) => options.onError?.(error as Error, "ingress drain"),
  });
  const monitorStart = (async () => {
    // Open through the shared monitor first so a denied queue is classified for
    // gateway health before Nostr's legacy tombstone migration touches it.
    monitor.ensureQueueAvailable();
    await migrateNostrLegacyRecentEventIds({
      queue: getQueue(),
      eventIds: options.legacyEventIds ?? [],
    });
    // stop() may run while the legacy migration is pending. Do not let that
    // deferred startup revive polling after shutdown has begun.
    if (!stopping) {
      monitor.start();
    }
  })();
  void monitorStart.catch((error: unknown) => options.onError?.(error as Error, "ingress drain"));

  const prepareAdmission = (event: Event) => {
    const facts = inspectNostrIngressEvent(event);
    const receivedAt = Date.now();
    if (receivedAt - admissionWindowStartedAt >= options.admissionRateLimit.windowMs) {
      admissionWindowStartedAt = receivedAt;
      admissionWindowCount = 0;
    }
    if (admissionWindowCount >= options.admissionRateLimit.maxEvents) {
      throw new NostrIngressAdmissionRejectedError(
        "rate-limited",
        "Nostr event exceeds the durable admission rate.",
      );
    }
    admissionWindowCount += 1;
    if (queuedAdmissions >= options.maxQueuedAdmissions) {
      throw new NostrIngressAdmissionRejectedError(
        "backpressure",
        "Nostr event exceeds the in-memory admission backlog.",
      );
    }

    let payload: NostrIngressPayload;
    let serializedPayload: string;
    try {
      payload = {
        version: NOSTR_INGRESS_PAYLOAD_VERSION,
        receivedAt,
        rawEvent: JSON.stringify(event),
      };
      serializedPayload = JSON.stringify(payload);
    } catch (error) {
      throw new NostrIngressPermanentError(
        "invalid-event",
        "Nostr event could not be serialized for durable ingress.",
        { cause: error },
      );
    }
    if (Buffer.byteLength(serializedPayload, "utf8") > options.maxSerializedPayloadBytes) {
      throw new NostrIngressAdmissionRejectedError(
        "oversized-event",
        "Nostr event exceeds the durable ingress size limit.",
      );
    }

    return { event, facts, receivedAt, payload };
  };

  return {
    ready: () => monitorStart,
    receive: (event: Event) => {
      if (stopping) {
        return Promise.reject(createStoppedError());
      }
      let prepared: ReturnType<typeof prepareAdmission>;
      try {
        prepared = prepareAdmission(event);
      } catch (error) {
        return Promise.reject(error as Error);
      }
      queuedAdmissions += 1;
      const reservedWindowStartedAt = admissionWindowStartedAt;
      return monitor
        .admit(prepared, { receivedAt: prepared.receivedAt })
        .then((result): "accepted" | "duplicate" => {
          if (result.queueResult?.kind === "accepted") {
            return "accepted";
          }
          // A replayed event the queue already holds appends nothing; it must not use up the
          // window that a new event needs after a relay resubscribes.
          if (reservedWindowStartedAt === admissionWindowStartedAt && admissionWindowCount > 0) {
            admissionWindowCount -= 1;
          }
          return "duplicate";
        })
        .finally(() => {
          queuedAdmissions -= 1;
        });
    },
    stop: () => {
      if (stopTask) {
        return stopTask;
      }
      stopping = true;
      // Pause delivery before joining the monitor's accepted durable admissions.
      const pauseTask = monitor.pause();
      stopTask = (async () => {
        await monitorStart.catch(() => undefined);
        await pauseTask;
        await monitor.stop();
      })();
      return stopTask;
    },
    waitForIdle: async () => {
      await monitorStart;
      await monitor.waitForIdle();
    },
  };
}
