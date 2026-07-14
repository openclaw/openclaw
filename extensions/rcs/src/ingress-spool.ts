// Rcs plugin module owns durable Twilio webhook admission and replay.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressMonitor,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { normalizeRcsIdentity } from "./address.js";
import { dispatchRcsInboundEvent, type RcsChannelRuntime } from "./inbound.js";
import { getRcsRuntime } from "./runtime.js";
import { buildTwilioInboundMessage } from "./twilio.js";
import type { RcsInboundMessage, ResolvedRcsAccount } from "./types.js";

const RCS_INGRESS_PAYLOAD_VERSION = 1;
const RCS_INGRESS_DRAIN_INTERVAL_MS = 500;
const RCS_COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const RCS_COMPLETED_MAX_ENTRIES = 20_000;
const RCS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RCS_FAILED_MAX_ENTRIES = 1_000;

type RcsIngressPayload = {
  version: typeof RCS_INGRESS_PAYLOAD_VERSION;
  form: Record<string, string>;
};

type RcsIngressLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

export type RcsIngressLog = Partial<Record<"info" | "warn" | "error", (message: string) => void>>;

class RcsIngressPermanentError extends Error {}

function resolveTwilioMessageSid(form: Record<string, string>): string {
  return (form.MessageSid || form.SmsSid || form.SmsMessageSid || "").trim();
}

function parseRcsIngressForm(
  form: Record<string, string>,
  account: ResolvedRcsAccount,
): RcsInboundMessage {
  const message = buildTwilioInboundMessage(form);
  if (!message) {
    throw new RcsIngressPermanentError("RCS ingress payload is invalid.");
  }
  if (message.accountSid && message.accountSid !== account.accountSid) {
    throw new RcsIngressPermanentError("RCS ingress payload has an invalid Twilio account.");
  }
  return message;
}

export function createRcsIngressSpool(params: {
  cfg: OpenClawConfig;
  account: ResolvedRcsAccount;
  channelRuntime: RcsChannelRuntime;
  queue?: ChannelIngressQueue<RcsIngressPayload>;
  abortSignal?: AbortSignal;
  log?: RcsIngressLog;
  deliver?: (
    message: RcsInboundMessage,
    lifecycle: RcsIngressLifecycle,
    receivedAt: number,
  ) => Promise<void>;
}) {
  const queue =
    params.queue ??
    getRcsRuntime().state.openChannelIngressQueue<RcsIngressPayload>({
      accountId: params.account.accountId,
    });
  const deliver =
    params.deliver ??
    (async (message: RcsInboundMessage, lifecycle: RcsIngressLifecycle, receivedAt: number) => {
      await dispatchRcsInboundEvent({
        cfg: params.cfg,
        account: params.account,
        channelRuntime: params.channelRuntime,
        msg: message,
        receivedAt,
        turnAdoptionLifecycle: lifecycle,
        log: params.log,
      });
    });
  const monitor = createChannelIngressMonitor<
    Record<string, string>,
    Record<string, string>,
    RcsIngressPayload
  >({
    queue,
    inspect: (form, context) => {
      const eventId = resolveTwilioMessageSid(form);
      if (!eventId) {
        if (context.phase === "claim") {
          throw new RcsIngressPermanentError("RCS ingress payload is invalid.");
        }
        throw new Error("RCS webhook is missing MessageSid.");
      }
      const sender = normalizeRcsIdentity(form.From ?? "");
      return { eventId, laneKey: sender ? `sender:${sender}` : `event:${eventId}` };
    },
    payload: {
      version: RCS_INGRESS_PAYLOAD_VERSION,
      serialize: (form) => form,
      deserialize: (form) => form,
      encode: ({ body }) => ({ version: RCS_INGRESS_PAYLOAD_VERSION, form: body }),
      decode: (payload) => ({ version: payload.version, body: payload.form }),
      createClaimError: (kind) =>
        new RcsIngressPermanentError(
          kind === "invalid-version"
            ? "RCS ingress payload version is invalid."
            : "RCS ingress identity changed after durable admission.",
        ),
    },
    deliver: (_form, lifecycle, event) =>
      deliver(
        parseRcsIngressForm(event.payload.form, params.account),
        bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle,
        event.receivedAt,
      ),
    pollIntervalMs: RCS_INGRESS_DRAIN_INTERVAL_MS,
    retention: {
      pruneIntervalMs: 0,
      completedTtlMs: RCS_COMPLETED_TTL_MS,
      completedMaxEntries: RCS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: RCS_FAILED_TTL_MS,
      failedMaxEntries: RCS_FAILED_MAX_ENTRIES,
    },
    appendRetryDelaysMs: [0],
    waitForDeliveryIdleBeforeRepump: false,
    waitForDeliveryIdleOnStop: false,
    runPumpTask: runDetachedWebhookWork,
    admissionMode: "durable-after-stop",
    drain: {
      onLog: (message) => params.log?.warn?.(message),
      resolveNonRetryableFailure: (error) =>
        error instanceof RcsIngressPermanentError
          ? { reason: "invalid-payload", message: error.message }
          : null,
    },
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    createStoppedError: () => new Error("RCS ingress stopped."),
    onError: (error) =>
      params.log?.error?.(
        `RCS ingress drain failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  return {
    enqueue: async (form: Record<string, string>) => {
      const admitted = await monitor.admit(form);
      if (admitted.kind === "ignored") {
        throw new Error("RCS webhook admission was unexpectedly ignored.");
      }
      return { kind: admitted.queueResult.kind, duplicate: admitted.queueResult.duplicate };
    },
    start: monitor.start,
    pause: monitor.pause,
    waitForIdle: monitor.waitForIdle,
    stop: monitor.stop,
  };
}
