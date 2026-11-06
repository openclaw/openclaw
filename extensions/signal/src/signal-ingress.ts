import { resolveApprovalReactionDecision } from "openclaw/plugin-sdk/approval-reaction-runtime";
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
import { isSignalActiveRunControlText } from "./monitor/event-handler.control-lane.js";
import type { SignalReceivePayload } from "./monitor/event-handler.types.js";
import { getOptionalSignalRuntime } from "./runtime.js";

const SIGNAL_INGRESS_DRAIN_INTERVAL_MS = 1_000;

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
  conversationLaneKey: string;
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
  const reactionMessage = isRecord(envelope.reactionMessage)
    ? envelope.reactionMessage
    : isRecord(dataMessage?.reaction)
      ? dataMessage.reaction
      : null;
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
  const conversationLaneKey = groupId ? `group:${groupId}` : `direct:${senderKey}`;
  const message = normalizeRawString(dataMessage?.message) ?? "";
  const hasBody =
    message.length > 0 ||
    (isRecord(dataMessage?.quote) && Boolean(normalizeRawString(dataMessage.quote.text))) ||
    (Array.isArray(dataMessage?.attachments) && dataMessage.attachments.length > 0);
  const approvalReaction =
    !hasBody &&
    reactionMessage?.isRemove !== true &&
    typeof reactionMessage?.emoji === "string" &&
    asPositiveSafeInteger(reactionMessage.targetSentTimestamp) !== undefined &&
    Boolean(
      normalizeRawString(reactionMessage.targetAuthor) ||
      normalizeRawString(reactionMessage.targetAuthorUuid),
    ) &&
    resolveApprovalReactionDecision({
      reactionKey: reactionMessage.emoji,
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
  // Scheduling does not authorize a command or reaction. The existing handler still checks
  // sender access, command authorization, and the exact live approval target.
  const control = isSignalActiveRunControlText(message) || approvalReaction;
  return {
    eventId: JSON.stringify([senderKey, timestamp]),
    laneKey: control ? `${conversationLaneKey}:control` : conversationLaneKey,
    conversationLaneKey,
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
      deriveLaneKey: (record) => {
        try {
          return inspectSignalIngressEvent([record.payload.event, undefined])?.laneKey;
        } catch {
          // Delivery owns dead-lettering malformed persisted events.
          return record.laneKey;
        }
      },
      reconcileStoredLaneKey: (record, storedLaneKey, derivedLaneKey) => {
        const facts = inspectSignalIngressEvent([record.payload.event, undefined]);
        // Retain accepted pre-upgrade controls, but never move them to another conversation.
        return (
          facts?.conversationLaneKey === storedLaneKey &&
          derivedLaneKey === `${storedLaneKey}:control`
        );
      },
      resolveNonRetryableFailure: resolveSignalIngressNonRetryableFailure,
      onLog: (message) => params.runtime.log?.(`signal ${message}`),
    },
    onError: (error) => params.runtime.error?.(`signal ingress drain failed: ${String(error)}`),
  });
  monitor.start();

  return {
    receive: async (event) => {
      await monitor.admit([event, undefined]);
      await monitor.waitForPumpIdle();
    },
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  };
}
