import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressError,
  createChannelIngressMonitor,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "openclaw/plugin-sdk/channel-outbound";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { ZaloApiError, type ZaloUpdate } from "./api.js";
import {
  webhookAdmissionSchema,
  webhookEnvelopeSchema,
  webhookUpdateSchema,
} from "./message-schema.js";
import type { ZaloRuntimeEnv } from "./monitor.types.js";
import { getZaloRuntime } from "./runtime.js";

const ZALO_WEBHOOK_SPOOL_VERSION = 1;
const ZALO_WEBHOOK_DRAIN_INTERVAL_MS = 500;
const ZALO_WEBHOOK_MAX_CONCURRENT_DELIVERIES = 8;

type ZaloWebhookSpoolPayload = {
  version: 1;
  rawEvent: string;
};

export type ZaloWebhookIngressLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

export const ZaloWebhookPayloadError = createChannelIngressError("ZaloWebhookPayloadError");
export type ZaloWebhookPayloadError = InstanceType<typeof ZaloWebhookPayloadError>;

function parseRawRecord(rawEvent: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch (error) {
    throw new ZaloWebhookPayloadError("Zalo webhook body contains invalid JSON.", { cause: error });
  }
  const envelope = webhookEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new ZaloWebhookPayloadError("Zalo webhook body must be a JSON object.");
  }
  return envelope.data;
}

function inspectZaloWebhookEvent(rawEvent: string) {
  const update = parseRawRecord(rawEvent);
  const admission = webhookAdmissionSchema.safeParse(update);
  if (!admission.success) {
    const missingEventId = admission.error.issues.some(
      (issue) =>
        issue.path[0] === "message" && (issue.path.length === 1 || issue.path[1] === "message_id"),
    );
    if (missingEventId) {
      throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.message_id.");
    }
    const missingChatId = admission.error.issues.some(
      (issue) => issue.path[0] === "message" && issue.path[1] === "chat",
    );
    if (missingChatId) {
      throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.chat.id.");
    }
    throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.message_id.");
  }
  const eventId = admission.data.message.message_id;
  const chatId = admission.data.message.chat.id;
  return { eventId, laneKey: `chat:${chatId}`, update };
}

function parseClaimedUpdate(rawEvent: string): ZaloUpdate {
  const parsed = webhookUpdateSchema.safeParse(parseRawRecord(rawEvent));
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join("."));
    if (paths.some((path) => path === "event_name")) {
      throw new ZaloWebhookPayloadError("Zalo webhook event_name is unsupported.");
    }
    if (paths.some((path) => path === "message.from" || path.startsWith("message.from.id"))) {
      throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.from.id.");
    }
    if (paths.some((path) => path === "message.chat" || path.startsWith("message.chat.id"))) {
      throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.chat.id.");
    }
    if (paths.some((path) => path.startsWith("message.chat.chat_type"))) {
      throw new ZaloWebhookPayloadError("Zalo webhook message has an invalid chat type.");
    }
    if (paths.some((path) => path.startsWith("message.date"))) {
      throw new ZaloWebhookPayloadError("Zalo webhook message has an invalid date.");
    }
    if (paths.some((path) => path.startsWith("message.text"))) {
      throw new ZaloWebhookPayloadError("Zalo text event is missing message.text.");
    }
    throw new ZaloWebhookPayloadError("Zalo webhook event_name is unsupported.");
  }
  return parsed.data;
}

function isZaloAuthenticationFailure(error: unknown): boolean {
  for (const current of collectErrorGraphCandidates(error, (candidate) => [candidate.cause])) {
    const candidate = asOptionalObjectRecord(current);
    if (!candidate) {
      continue;
    }
    if (
      (candidate instanceof ZaloApiError &&
        (candidate.errorCode === 401 || candidate.errorCode === 403)) ||
      candidate.status === 401 ||
      candidate.status === 403 ||
      candidate.statusCode === 401 ||
      candidate.statusCode === 403
    ) {
      return true;
    }
  }
  return false;
}

function createZaloWebhookIngress(options: {
  accountId: string;
  runtime: Pick<ZaloRuntimeEnv, "error" | "log">;
  deliver: (update: ZaloUpdate, lifecycle: ZaloWebhookIngressLifecycle) => Promise<void>;
}) {
  const queue = getZaloRuntime().state.openChannelIngressQueue<ZaloWebhookSpoolPayload>({
    accountId: options.accountId,
  });
  const monitor = createChannelIngressMonitor<string, string, ZaloWebhookSpoolPayload>({
    queue,
    inspect: (rawEvent) => inspectZaloWebhookEvent(rawEvent),
    payload: {
      storage: "raw-event",
      version: ZALO_WEBHOOK_SPOOL_VERSION,
      serialize: (rawEvent) => rawEvent,
      deserialize: (rawEvent) => rawEvent,
      createClaimError: (kind) =>
        new ZaloWebhookPayloadError(
          kind === "invalid-version"
            ? "Zalo webhook spool payload is invalid."
            : "Zalo webhook identity changed after durable admission.",
        ),
    },
    deliver: async (rawEvent, lifecycle) => {
      const update = parseClaimedUpdate(rawEvent);
      await options.deliver(
        update,
        bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle,
      );
    },
    pollIntervalMs: ZALO_WEBHOOK_DRAIN_INTERVAL_MS,
    // Standard 30-day tombstones dominate the retired 5-minute / 5,000-key replay cache.
    retention: {
      failedMaxEntries: 5_000,
    },
    waitForDeliveryIdleBeforeRepump: false,
    runPumpTask: runDetachedWebhookWork,
    deferredClaims: "wait-on-stop",
    drain: {
      adoptionStallTimeoutMs: DEFAULT_INGRESS_ADOPTION_STALL_MS,
      startLimit: ZALO_WEBHOOK_MAX_CONCURRENT_DELIVERIES,
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: 0,
      },
      resolveNonRetryableFailure: (error) => {
        if (error instanceof ZaloWebhookPayloadError) {
          return { reason: "invalid-event", message: error.message };
        }
        if (isZaloAuthenticationFailure(error)) {
          return { reason: "authentication-failed", message: formatErrorMessage(error) };
        }
        return null;
      },
      onLog: (message) => options.runtime.error?.(`zalo ingress: ${message}`),
    },
    createStoppedError: () => new Error("Zalo ingress stopped."),
    onError: (error) =>
      options.runtime.error?.(`zalo ingress drain failed: ${formatErrorMessage(error)}`),
  });

  return {
    accept: async (rawEvent: string) => {
      await monitor.admit(rawEvent);
    },
    start: monitor.start,
    stop: monitor.stop,
  };
}

export const zaloWebhookIngressRuntime = { createZaloWebhookIngress };
