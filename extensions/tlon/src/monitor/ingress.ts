// Tlon plugin module owns raw Urbit firehose durable ingress mapping and draining.
import {
  createChannelIngressError,
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  asNullableRecord as asRecord,
  normalizeNullableString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getTlonRuntime } from "../runtime.js";
import { UrbitAuthError, UrbitHttpError } from "../urbit/errors.js";

const TLON_INGRESS_PAYLOAD_VERSION = 1;
const TLON_INGRESS_POLL_INTERVAL_MS = 1_000;

export type TlonIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

type TlonIngressSource = "channels" | "chat";

type TlonIngressPayload = {
  version: 1;
  receivedAt: number;
  source: TlonIngressSource;
  rawEvent: string;
};

type TlonIngressBody = Omit<TlonIngressPayload, "version">;

type TlonIngressRaw = { source: TlonIngressSource; event: unknown };

type TlonIngressDispatch = (
  source: TlonIngressSource,
  event: unknown,
  lifecycle: TlonIngressLifecycle,
) =>
  | Promise<ChannelIngressMonitorDeliveryResult | void>
  | ChannelIngressMonitorDeliveryResult
  | void;

const TlonIngressPermanentError = createChannelIngressError<"invalid-event" | "tlon-auth">(
  "TlonIngressPermanentError",
  { withReason: true },
);

function inspectChannelsEvent(event: unknown): { eventId: string; laneKey: string } | null {
  const envelope = asRecord(event);
  const nest = nonEmptyString(envelope?.nest);
  const response = asRecord(envelope?.response);
  const post = asRecord(response?.post);
  const rPost = asRecord(post?.["r-post"]);
  const set = asRecord(rPost?.set);
  const reply = asRecord(rPost?.reply);
  const rReply = asRecord(reply?.["r-reply"]);
  const replySet = asRecord(rReply?.set);
  if (!nest || (!asRecord(set?.essay) && !asRecord(replySet?.memo))) {
    return null;
  }
  const eventId = nonEmptyString(asRecord(replySet?.memo) ? reply?.id : post?.id);
  return eventId ? { eventId, laneKey: `group:${nest}` } : null;
}

function inspectChatEvent(event: unknown): { eventId: string; laneKey: string } | null {
  const envelope = asRecord(event);
  const response = asRecord(envelope?.response);
  const add = asRecord(response?.add);
  const essay = asRecord(add?.essay);
  const eventId = nonEmptyString(envelope?.id);
  if (!essay || !eventId) {
    return null;
  }
  const whom = nonEmptyString(asRecord(envelope?.whom)?.ship);
  const peer = nonEmptyString(envelope?.whom) ?? whom ?? nonEmptyString(essay.author);
  return { eventId, laneKey: peer ? `direct:${peer}` : `event:${eventId}` };
}

function inspectTlonIngressEvent(
  source: TlonIngressSource,
  event: unknown,
): { eventId: string; laneKey: string } | null {
  // Urbit SSE ids belong to a disposable HTTP channel. The message id inside
  // each firehose envelope survives resubscription and preserves the retired guard key.
  return source === "channels" ? inspectChannelsEvent(event) : inspectChatEvent(event);
}

function decodeTlonIngressPayload(
  payload: TlonIngressPayload,
  claimedId: string,
): { version: unknown; body: TlonIngressBody } {
  if (
    (payload.source !== "channels" && payload.source !== "chat") ||
    typeof payload.rawEvent !== "string"
  ) {
    throw new TlonIngressPermanentError(
      "invalid-event",
      `Tlon ingress row ${claimedId} has an invalid payload.`,
    );
  }
  return {
    version: payload.version,
    body: {
      receivedAt: payload.receivedAt,
      source: payload.source,
      rawEvent: payload.rawEvent,
    },
  };
}

function deserializeTlonIngressEvent(body: TlonIngressBody, claimedId: string): TlonIngressRaw {
  let event: unknown;
  try {
    event = JSON.parse(body.rawEvent);
  } catch (error) {
    throw new TlonIngressPermanentError(
      "invalid-event",
      `Tlon ingress row ${claimedId} contains invalid JSON.`,
      { cause: error },
    );
  }
  return { source: body.source, event };
}

function resolveTlonIngressNonRetryableFailure(error: unknown) {
  if (error instanceof TlonIngressPermanentError) {
    return { reason: error.reason, message: error.message };
  }
  for (const candidate of collectErrorGraphCandidates(error, (current) => [current.cause])) {
    if (
      candidate instanceof UrbitAuthError ||
      (candidate instanceof UrbitHttpError &&
        (candidate.status === 401 || candidate.status === 403))
    ) {
      return { reason: "tlon-auth", message: formatErrorMessage(candidate) };
    }
  }
  return null;
}

export function createTlonIngressMonitor(options: {
  accountId: string;
  queue?: ChannelIngressQueue<TlonIngressPayload>;
  dispatch: TlonIngressDispatch;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
  abortSignal?: AbortSignal;
}) {
  const monitor = createChannelIngressMonitor<TlonIngressRaw, TlonIngressBody, TlonIngressPayload>({
    queue:
      options.queue ??
      (() =>
        getTlonRuntime().state.openChannelIngressQueue<TlonIngressPayload>({
          accountId: options.accountId,
        })),
    inspect: (raw) => inspectTlonIngressEvent(raw.source, raw.event),
    payload: {
      version: TLON_INGRESS_PAYLOAD_VERSION,
      serialize: (raw, { receivedAt }) => ({
        receivedAt,
        source: raw.source,
        rawEvent: JSON.stringify(raw.event),
      }),
      deserialize: (body, { claim }) => deserializeTlonIngressEvent(body, claim.id),
      encode: ({ body }) => ({ version: TLON_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload, { claim }) => decodeTlonIngressPayload(payload, claim.id),
      createClaimError: (kind, claim) =>
        new TlonIngressPermanentError(
          "invalid-event",
          kind === "invalid-version"
            ? `Tlon ingress row ${claim.id} has an invalid payload.`
            : `Tlon ingress row ${claim.id} has invalid message identity.`,
        ),
    },
    deliver: (raw, lifecycle) => options.dispatch(raw.source, raw.event, lifecycle),
    pollIntervalMs: options.pollIntervalMs ?? TLON_INGRESS_POLL_INTERVAL_MS,
    // Preserve the retired process-local guard's full 2,000-message key window.
    retention: {
      completedTtlMs: undefined,
      completedMaxEntries: 2_000,
      failedMaxEntries: 2_000,
    },
    // The Tlon firehose has always surfaced a failed append to its awaited callback.
    appendRetryDelaysMs: [0],
    drain: {
      resolveNonRetryableFailure: resolveTlonIngressNonRetryableFailure,
      ...(options.adoptionStallTimeoutMs === undefined
        ? {}
        : { adoptionStallTimeoutMs: options.adoptionStallTimeoutMs }),
      onLog: (message) => options.runtime.log?.(`tlon ${message}`),
    },
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    createStoppedError: () => new Error("Tlon ingress stopped before dispatch adoption."),
    onError: (error) =>
      options.runtime.error?.(`tlon ingress drain failed: ${formatErrorMessage(error)}`),
  });

  return {
    receive: async ({
      source,
      event,
    }: TlonIngressRaw): Promise<{ kind: "accepted" | "ignored" }> => {
      const result = await monitor.admit({ source, event });
      return { kind: result.kind === "durable" ? "accepted" : "ignored" };
    },
    start: monitor.start,
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  };
}
