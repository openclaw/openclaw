import {
  createChannelIngressError,
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  asPositiveSafeInteger,
  isRecord,
  normalizeNullableString as normalizeRawString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SignalSseEvent } from "./client-adapter.js";
import type { SignalReceivePayload } from "./monitor/event-handler.types.js";
import { getOptionalSignalRuntime } from "./runtime.js";

const SIGNAL_INGRESS_DRAIN_INTERVAL_MS = 1_000;
// Bounds one append transaction, which holds the shared state writer: 10k rows commit
// in about 0.4 s, and a 100k burst still lands in about 8 s.
const SIGNAL_INGRESS_BATCH_MAX_EVENTS = 10_000;
// About 200 MiB of decoded messages; a burst that SQLite keeps up with stays below it.
const SIGNAL_INGRESS_BACKLOG_WARN_EVENTS = 50_000;

type SignalIngressEnvelope = {
  sourceNumber?: unknown;
  sourceUuid?: unknown;
  timestamp?: unknown;
  syncMessage?: unknown;
  dataMessage?: unknown;
  editMessage?: { dataMessage?: unknown } | null;
  reactionMessage?: unknown;
};

type SignalIngressEventFacts = {
  eventId: string;
  laneKey: string;
};

type SignalPreparedIngressEvent = [
  event: SignalSseEvent,
  parsedPayload: SignalReceivePayload | null | undefined,
];

type SignalIngressPayload = {
  version: 1;
  receivedAt: number;
  event: SignalSseEvent;
};

type SignalIngressBody = Omit<SignalIngressPayload, "version">;

export type SignalIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

type SignalIngressDispatch = (
  event: SignalSseEvent,
  lifecycle: SignalIngressLifecycle,
  parsedPayload: SignalReceivePayload,
) =>
  | Promise<ChannelIngressMonitorDeliveryResult | void>
  | ChannelIngressMonitorDeliveryResult
  | void;

const SignalIngressPermanentError = createChannelIngressError<
  "parse-error" | "missing-sender" | "missing-timestamp" | "unsupported-event"
>("SignalIngressPermanentError", { withReason: true });

function parseReceivePayload(event: SignalSseEvent): SignalReceivePayload | null {
  if (event.event !== "receive" || !event.data) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch (error) {
    throw new SignalIngressPermanentError(
      "parse-error",
      "Signal receive event contains invalid JSON",
      {
        cause: error,
      },
    );
  }
  if (!isRecord(parsed)) {
    throw new SignalIngressPermanentError(
      "parse-error",
      "Signal receive event must contain a JSON object",
    );
  }
  // SAFETY: SignalReceivePayload has only optional fields; downstream code validates each field.
  return parsed as SignalReceivePayload;
}

function resolveDataMessage(envelope: SignalIngressEnvelope): Record<string, unknown> | null {
  if (isRecord(envelope.dataMessage)) {
    return envelope.dataMessage;
  }
  return isRecord(envelope.editMessage?.dataMessage) ? envelope.editMessage.dataMessage : null;
}

function inspectSignalIngressEvent(
  prepared: SignalPreparedIngressEvent,
): SignalIngressEventFacts | null {
  const payload = (prepared[1] ??= parseReceivePayload(prepared[0]));
  const envelope = isRecord(payload?.envelope) ? (payload.envelope as SignalIngressEnvelope) : null;
  if (!envelope || "syncMessage" in envelope) {
    return null;
  }
  const dataMessage = resolveDataMessage(envelope);
  const reactionMessage = isRecord(envelope.reactionMessage) ? envelope.reactionMessage : null;
  if (!dataMessage && !reactionMessage) {
    // Receipts, typing notifications, and other transport-only envelopes never dispatch.
    return null;
  }
  const senderUuid = normalizeRawString(envelope.sourceUuid);
  const senderNumber = normalizeRawString(envelope.sourceNumber);
  const senderKey = senderUuid
    ? `uuid:${senderUuid}`
    : senderNumber
      ? `number:${senderNumber}`
      : null;
  if (!senderKey) {
    throw new SignalIngressPermanentError(
      "missing-sender",
      "Signal dispatchable envelope is missing sourceUuid/sourceNumber",
    );
  }
  const timestamp =
    asPositiveSafeInteger(envelope.timestamp) ?? asPositiveSafeInteger(dataMessage?.timestamp);
  if (timestamp === undefined) {
    throw new SignalIngressPermanentError(
      "missing-timestamp",
      "Signal dispatchable envelope is missing a stable timestamp",
    );
  }
  const dataGroup = isRecord(dataMessage?.groupInfo) ? dataMessage.groupInfo : null;
  const reactionGroup = isRecord(reactionMessage?.groupInfo) ? reactionMessage.groupInfo : null;
  const groupId =
    normalizeRawString(dataGroup?.groupId) ?? normalizeRawString(reactionGroup?.groupId);
  return {
    eventId: JSON.stringify([senderKey, timestamp]),
    laneKey: groupId ? `group:${groupId}` : `direct:${senderKey}`,
  };
}

function resolveSignalIngressNonRetryableFailure(error: unknown) {
  return error instanceof SignalIngressPermanentError
    ? { reason: error.reason, message: error.message }
    : null;
}

export type SignalIngressMonitor = {
  receive: (event: SignalSseEvent) => Promise<void>;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

/** Open the account queue, recover it, and keep newly appended rows draining. */
export async function startSignalIngressMonitor(params: {
  accountId: string;
  queue?: ChannelIngressQueue<SignalIngressPayload>;
  dispatch: SignalIngressDispatch;
  runtime: Pick<RuntimeEnv, "error" | "log">;
}): Promise<SignalIngressMonitor> {
  let queue = params.queue;
  if (!queue) {
    const pluginRuntime = getOptionalSignalRuntime();
    if (!pluginRuntime) {
      throw new Error("Signal runtime not initialized for durable ingress");
    }
    queue = pluginRuntime.state.openChannelIngressQueue<SignalIngressPayload>({
      accountId: params.accountId,
    });
  }
  const ingressQueue = queue;
  const monitor = createChannelIngressMonitor<
    SignalPreparedIngressEvent,
    SignalIngressBody,
    SignalIngressPayload
  >({
    queue: ingressQueue,
    inspect: inspectSignalIngressEvent,
    payload: {
      version: 1,
      // Parsed JSON remains transient; durable rows retain the exact raw event shape.
      serialize: ([event], { receivedAt }) => ({ receivedAt, event }),
      deserialize: (body) => [body.event, undefined],
      encode: ({ body }) => ({ version: 1, ...body }),
      decode: (payload) => ({ version: payload.version, body: payload }),
      createClaimError: (_kind, claim) =>
        new SignalIngressPermanentError(
          "unsupported-event",
          `Signal ingress row ${claim.id} has an invalid payload`,
        ),
    },
    deliver: ([event, parsedPayload], lifecycle) =>
      parsedPayload ? params.dispatch(event, lifecycle, parsedPayload) : undefined,
    pollIntervalMs: SIGNAL_INGRESS_DRAIN_INTERVAL_MS,
    retention: {
      // Signal previously pruned before every enqueue rather than on a timed cadence.
      pruneIntervalMs: 0,
      completedMaxEntries: 2_000,
      failedMaxEntries: 1_000,
    },
    appendRetryDelaysMs: [0],
    drain: {
      resolveNonRetryableFailure: resolveSignalIngressNonRetryableFailure,
      onLog: (message) => params.runtime.log?.(`signal ${message}`),
    },
    onError: (error) => params.runtime.error?.(`signal ingress drain failed: ${String(error)}`),
  });
  monitor.start();

  // Group commit: events that arrive while one append runs share the next transaction,
  // so a burst moves into the durable queue at SQLite speed instead of one write each.
  // Receive settles at the durable append; claiming and dispatch run on the drain.
  type Waiter = {
    event: SignalPreparedIngressEvent;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  const waiting: Waiter[] = [];
  let flushing: Promise<void> | undefined;
  let backlogWarned = false;
  const flush = async () => {
    while (waiting.length > 0) {
      const batch = waiting.splice(0, SIGNAL_INGRESS_BATCH_MAX_EVENTS);
      try {
        await monitor.admitBatch(batch.map((waiter) => waiter.event));
        batch.forEach((waiter) => waiter.resolve());
      } catch {
        // Keep every good event of a failed batch: admit them one by one, so only the
        // event that cannot be appended (or all of them, if the store is down) rejects.
        await Promise.all(
          batch.map((waiter) => monitor.admit(waiter.event).then(waiter.resolve, waiter.reject)),
        );
      }
      if (backlogWarned && waiting.length < SIGNAL_INGRESS_BACKLOG_WARN_EVENTS) {
        backlogWarned = false;
      }
    }
    // Cleared in the same turn as the empty check, so no receive can be left unflushed.
    flushing = undefined;
  };

  return {
    receive: (event) =>
      new Promise<void>((resolve, reject) => {
        waiting.push({ event: [event, undefined], resolve, reject });
        // Accepted edge: a store that stalls keeps later events in memory, as before
        // durable batching. Nothing is dropped; the warning makes the stall visible.
        if (!backlogWarned && waiting.length >= SIGNAL_INGRESS_BACKLOG_WARN_EVENTS) {
          backlogWarned = true;
          params.runtime.error?.(
            `signal ingress: ${waiting.length} received messages are waiting in memory for the state database; if this persists, check disk space and database health`,
          );
        }
        flushing ??= flush();
      }),
    // Graceful stop keeps every event the socket already read: append them, then stop.
    stop: async () => {
      await flushing;
      await monitor.stop();
    },
    waitForIdle: monitor.waitForIdle,
  };
}
