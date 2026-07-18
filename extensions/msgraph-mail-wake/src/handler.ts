// Microsoft Graph Mail Wake HTTP handler: validationToken handshake,
// fail-closed notification validation, bounded replay protection, and generic
// SDK webhook guards (rate limit, single-flight, bounded body reads).
//
// Response semantics: validation failures ack 202 (Graph must not redeliver
// poison); transient wake failures answer 500 so Graph redelivers — nothing
// is recorded as completed until a wake is actually scheduled.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginLogger } from "../api.js";
import {
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
  resolveRequestClientIp,
  safeEqualSecret,
  withResolvedWebhookRequestPipeline,
  WEBHOOK_IN_FLIGHT_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  type OpenClawConfig,
  type WebhookInFlightLimiter,
} from "../runtime-api.js";
import { createGraphWakeDedupe, type GraphWakeDedupe } from "./dedupe.js";
import {
  changeTypeMatchesSubscription,
  parseGraphNotificationBatch,
  parseOutlookMessageNotificationResource,
  resourceMatchesSubscription,
  type GraphChangeNotification,
  type GraphLifecycleEvent,
} from "./notifications.js";
import { describeErrorRedacted, redactHandle, sha256Hex } from "./redact.js";
import type { GraphLifecycleHandlingResult, GraphWakeSubscriptionRecord } from "./subscriptions.js";
import type { GraphWakePoster } from "./wake.js";

const MAX_BODY_BYTES = 64 * 1024;
const BODY_READ_TIMEOUT_MS = 15_000;
/** Transient failures: work was not completed and Graph should retry. */
const TRANSIENT_BLOCK_REASONS = new Set<GraphWakeBlockReason>([
  "host_poster_rejected",
  "lifecycle_handling_failed",
]);

export type GraphWakeBlockReason =
  | "invalid_graph_notification"
  | "unknown_subscription"
  | "client_state_mismatch"
  | "notification_resource_not_approved"
  | "notification_change_type_not_approved"
  | "host_poster_rejected"
  | "lifecycle_handling_failed";

export type GraphWakeNotificationStatus =
  | "wake_scheduled"
  | "duplicate"
  | "coalesced"
  | "lifecycle_ack"
  | "blocked";

function buildIdempotencyKey(notification: GraphChangeNotification): string {
  // Prefer Graph's top-level unique changeNotification id. Older/basic payloads
  // may omit it, so fall back to the resource identity scoped by subscription
  // and change type.
  const material = notification.notificationId
    ? `notification|${notification.subscriptionId}|${notification.notificationId}`
    : `fallback|${notification.subscriptionId}|${notification.resource}|${notification.changeType}`;
  return sha256Hex(material).slice(0, 32);
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function createGraphWakeRequestHandler(params: {
  cfg: OpenClawConfig;
  path: string;
  dedupe?: GraphWakeDedupe;
  lookupSubscription: (subscriptionId: string) => GraphWakeSubscriptionRecord | undefined;
  poster: GraphWakePoster;
  onLifecycleEvent: (params: {
    record: GraphWakeSubscriptionRecord;
    lifecycleEvent: GraphLifecycleEvent;
  }) => Promise<GraphLifecycleHandlingResult>;
  logger?: PluginLogger;
  inFlightLimiter?: WebhookInFlightLimiter;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const dedupe = params.dedupe ?? createGraphWakeDedupe();
  const rateLimiter = createFixedWindowRateLimiter({
    windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
    maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
    maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
  });
  const inFlightLimiter =
    params.inFlightLimiter ??
    createWebhookInFlightLimiter({
      maxInFlightPerKey: WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey,
      maxTrackedKeys: WEBHOOK_IN_FLIGHT_DEFAULTS.maxTrackedKeys,
    });
  // Single target bucket: the pipeline supplies method guards, rate limiting,
  // and single-flight; authorization is per-notification clientState below.
  const targetsByPath = new Map<string, [string]>([[params.path, [params.path]]]);

  const processChangeNotification = async (
    notification: GraphChangeNotification,
  ): Promise<Record<string, unknown>> => {
    const record = params.lookupSubscription(notification.subscriptionId);
    if (!record) {
      return { status: "blocked", reason: "unknown_subscription" satisfies GraphWakeBlockReason };
    }
    if (!safeEqualSecret(record.clientState, notification.clientState)) {
      return {
        status: "blocked",
        reason: "client_state_mismatch" satisfies GraphWakeBlockReason,
      };
    }
    const parsedResource = parseOutlookMessageNotificationResource(notification.resource);
    if (
      !parsedResource ||
      !resourceMatchesSubscription({
        subscriptionResource: record.resource,
        notificationResource: notification.resource,
      })
    ) {
      return {
        status: "blocked",
        reason: "notification_resource_not_approved" satisfies GraphWakeBlockReason,
      };
    }
    if (
      !changeTypeMatchesSubscription({
        subscriptionChangeType: record.changeType,
        changeType: notification.changeType,
      })
    ) {
      return {
        status: "blocked",
        reason: "notification_change_type_not_approved" satisfies GraphWakeBlockReason,
      };
    }

    const idempotencyKey = buildIdempotencyKey(notification);
    const claim = dedupe.claim(idempotencyKey);
    if (claim.kind === "duplicate") {
      return {
        status: "duplicate",
        idempotencyKey,
        ...(claim.wakeId ? { wakeId: claim.wakeId } : {}),
      };
    }
    if (claim.kind === "shared") {
      const outcome = await claim.completion;
      if (outcome) {
        return {
          status: "coalesced",
          idempotencyKey,
          ...(outcome.wakeId ? { wakeId: outcome.wakeId } : {}),
        };
      }
      return {
        status: "blocked",
        reason: "host_poster_rejected" satisfies GraphWakeBlockReason,
        idempotencyKey,
        hostStatus: "leader_failed",
      };
    }

    try {
      const postResult = await params.poster.postWake({
        record,
        messageId: parsedResource.messageId,
        notification,
        idempotencyKey,
      });
      if (!postResult.accepted) {
        claim.fail();
        return {
          status: "blocked",
          reason: "host_poster_rejected" satisfies GraphWakeBlockReason,
          idempotencyKey,
          ...(postResult.status ? { hostStatus: postResult.status } : {}),
        };
      }
      claim.complete(postResult.wakeId ? { wakeId: postResult.wakeId } : {});
      params.logger?.info?.(
        `[msgraph-mail-wake] wake scheduled for mailbox "${redactHandle(record.user)}" (subscription "${redactHandle(record.subscriptionId)}")`,
      );
      return {
        status: "wake_scheduled",
        idempotencyKey,
        ...(postResult.wakeId ? { wakeId: postResult.wakeId } : {}),
      };
    } catch (err) {
      claim.fail();
      params.logger?.error?.(
        `[msgraph-mail-wake] wake poster threw (subscription "${redactHandle(record.subscriptionId)}"): ${describeErrorRedacted(err)}`,
      );
      return {
        status: "blocked",
        reason: "host_poster_rejected" satisfies GraphWakeBlockReason,
        idempotencyKey,
        hostStatus: "poster_threw",
      };
    }
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    return await withResolvedWebhookRequestPipeline({
      req,
      res,
      targetsByPath,
      allowMethods: ["POST"],
      // The Graph validation handshake carries no JSON content type, so the
      // pipeline cannot enforce it; the notification path validates the body
      // itself below.
      requireJsonContentType: false,
      rateLimiter,
      rateLimitKey: (() => {
        const clientIp =
          resolveRequestClientIp(
            req,
            params.cfg.gateway?.trustedProxies,
            params.cfg.gateway?.allowRealIpFallback === true,
          ) ??
          req.socket.remoteAddress ??
          "unknown";
        return `${params.path}:${clientIp}`;
      })(),
      inFlightLimiter,
      handle: async () => {
        const url = new URL(req.url ?? "/", "http://localhost");

        // Graph subscription validation handshake: echo the token as
        // text/plain. This request legitimately arrives with no clientState.
        const validationToken = url.searchParams.get("validationToken");
        if (validationToken !== null) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(validationToken);
          params.logger?.info?.("[msgraph-mail-wake] answered Graph validation handshake");
          return true;
        }

        const body = await readJsonWebhookBodyOrReject({
          req,
          res,
          maxBytes: MAX_BODY_BYTES,
          timeoutMs: BODY_READ_TIMEOUT_MS,
          emptyObjectOnEmpty: false,
          invalidJsonMessage: "invalid request body",
        });
        if (!body.ok) {
          return true;
        }

        const parsed = parseGraphNotificationBatch(body.value);
        if (!parsed.ok) {
          writeJson(res, 202, {
            ok: false,
            results: [{ status: "blocked", reason: parsed.reason }],
          });
          return true;
        }

        const results: Record<string, unknown>[] = Array.from(
          { length: parsed.batch.invalidNotifications },
          () => ({
            status: "blocked",
            reason: "invalid_graph_notification" satisfies GraphWakeBlockReason,
          }),
        );
        // A lifecycle notification and a final change for the same subscription
        // can share one Graph batch. Finish valid change work against the old
        // authenticated identity before subscriptionRemoved installs its
        // replacement. On a batch retry, completed change work deduplicates.
        results.push(
          ...(await Promise.all(parsed.batch.notifications.map(processChangeNotification))),
        );
        for (const lifecycleNotification of parsed.batch.lifecycleNotifications) {
          const record = params.lookupSubscription(lifecycleNotification.subscriptionId);
          if (!record) {
            results.push({ status: "blocked", reason: "unknown_subscription" });
            continue;
          }
          if (!safeEqualSecret(record.clientState, lifecycleNotification.clientState)) {
            results.push({ status: "blocked", reason: "client_state_mismatch" });
            continue;
          }
          params.logger?.warn?.(
            `[msgraph-mail-wake] lifecycle_event_received; event="${lifecycleNotification.lifecycleEvent}"; subscription="${redactHandle(record.subscriptionId)}"`,
          );
          try {
            const lifecycleResult = await params.onLifecycleEvent({
              record,
              lifecycleEvent: lifecycleNotification.lifecycleEvent,
            });
            if (!lifecycleResult.ok) {
              results.push({
                status: "blocked",
                reason: "lifecycle_handling_failed",
                lifecycleEvent: lifecycleNotification.lifecycleEvent,
                hostStatus: lifecycleResult.code,
              });
              continue;
            }
            results.push({
              status: "lifecycle_ack",
              lifecycleEvent: lifecycleNotification.lifecycleEvent,
              action: lifecycleResult.action,
            });
          } catch (err) {
            params.logger?.error?.(
              `[msgraph-mail-wake] lifecycle_handler_threw; subscription="${redactHandle(record.subscriptionId)}"; error=${describeErrorRedacted(err)}`,
            );
            results.push({
              status: "blocked",
              reason: "lifecycle_handling_failed",
              lifecycleEvent: lifecycleNotification.lifecycleEvent,
              hostStatus: "lifecycle_handler_threw",
            });
          }
        }
        const ok = results.every((result) => result.status !== "blocked");
        const transient = results.some(
          (result) =>
            typeof result.reason === "string" &&
            TRANSIENT_BLOCK_REASONS.has(result.reason as GraphWakeBlockReason),
        );
        if (transient) {
          // 500 so Graph redelivers unfinished work. Its failed key records no
          // completion; successful siblings remain completed and dedupe on the
          // batch retry. Validation failures stay 202 below because retrying a
          // poison notification would loop forever.
          writeJson(res, 500, { ok: false, results });
          return true;
        }
        writeJson(res, 202, { ok, results });
        return true;
      },
    });
  };
}
