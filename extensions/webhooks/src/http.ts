import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginRuntime } from "../api.js";
import {
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  readWebhookBodyOrReject,
  resolveRequestClientIp,
  resolveConfiguredSecretInputString,
  resolveWebhookTargetWithAuthOrReject,
  withResolvedWebhookRequestPipeline,
  WEBHOOK_IN_FLIGHT_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  type OpenClawConfig,
  type WebhookInFlightLimiter,
} from "../runtime-api.js";
import {
  collectRequestHeaders,
  extractPresentedSecret,
  hmacMatches,
  timingSafeEquals,
} from "./auth.js";
import type {
  ConfiguredWebhookAuth,
  ConfiguredWebhookAgentDispatchConfig,
  ConfiguredWebhookDeliveryConfig,
  ConfiguredWebhookEventConfig,
  ConfiguredWebhookIdempotencyConfig,
  ConfiguredWebhookTaskFlowTemplateConfig,
  WebhookSecretInput,
} from "./config.js";
import { executeDeliveryDispatch } from "./delivery.js";
import { executeAgentDispatch, type WebhookAgentCompletionDispatch } from "./dispatch.js";
import { extractEventType, extractIdempotencyKey } from "./events.js";
import {
  checkAndStoreDurableIdempotencyKey,
  createInMemoryIdempotencyRecords,
  type WebhookIdempotencyStore,
} from "./idempotency.js";
import { executeTaskFlowActionDispatch, executeTaskFlowTemplateDispatch } from "./taskflow.js";
import type { WebhookDispatchContext } from "./template.js";

type BoundTaskFlowRuntime = ReturnType<PluginRuntime["tasks"]["managedFlows"]["bindSession"]>;
type LoadChannelOutboundAdapter = PluginRuntime["channel"]["outbound"]["loadAdapter"];

export type ScheduleSessionTurn = (params: {
  sessionKey: string;
  message: string;
  agentId?: string;
  deliveryMode?: "none" | "announce";
  name?: string;
  tag?: string;
  delayMs: number;
  deleteAfterRun?: boolean;
}) => Promise<{ id: string; pluginId: string; sessionKey: string; kind: string } | undefined>;

export type WebhookLogger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

export type { WebhookAgentCompletionDispatch } from "./dispatch.js";
export type { WebhookDispatchContext } from "./template.js";
export { deliverWebhookCompletion } from "./delivery.js";

export type TaskFlowWebhookTarget = {
  routeId: string;
  path: string;
  dispatchMode?: "taskflow";
  auth?: ConfiguredWebhookAuth;
  secretInput: WebhookSecretInput;
  secretConfigPath: string;
  defaultControllerId: string;
  event?: ConfiguredWebhookEventConfig;
  events?: string[];
  idempotency?: ConfiguredWebhookIdempotencyConfig;
  prompt?: string;
  skills?: string[];
  taskflow?: ConfiguredWebhookTaskFlowTemplateConfig;
  taskFlow: BoundTaskFlowRuntime;
};

export type AckWebhookTarget = {
  routeId: string;
  path: string;
  dispatchMode: "ack";
  auth: ConfiguredWebhookAuth;
  secretConfigPath?: string;
  event?: ConfiguredWebhookEventConfig;
  events?: string[];
  idempotency?: ConfiguredWebhookIdempotencyConfig;
  prompt?: string;
  skills?: string[];
};

export type AgentWebhookTarget = {
  routeId: string;
  path: string;
  dispatchMode: "agent";
  auth: ConfiguredWebhookAuth;
  secretConfigPath?: string;
  event?: ConfiguredWebhookEventConfig;
  events?: string[];
  idempotency?: ConfiguredWebhookIdempotencyConfig;
  prompt?: string;
  skills?: string[];
  sessionKey: string;
  agent: ConfiguredWebhookAgentDispatchConfig;
};

export type DeliverWebhookTarget = {
  routeId: string;
  path: string;
  dispatchMode: "deliver";
  auth: ConfiguredWebhookAuth;
  secretConfigPath?: string;
  event?: ConfiguredWebhookEventConfig;
  events?: string[];
  idempotency?: ConfiguredWebhookIdempotencyConfig;
  prompt?: string;
  skills?: string[];
  delivery: ConfiguredWebhookDeliveryConfig;
};

export type WebhookTarget =
  | TaskFlowWebhookTarget
  | AckWebhookTarget
  | AgentWebhookTarget
  | DeliverWebhookTarget;

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function isTaskFlowTarget(target: WebhookTarget): target is TaskFlowWebhookTarget {
  return target.dispatchMode === undefined || target.dispatchMode === "taskflow";
}

export function isAgentTarget(target: WebhookTarget): target is AgentWebhookTarget {
  return target.dispatchMode === "agent";
}

export function isDeliverTarget(target: WebhookTarget): target is DeliverWebhookTarget {
  return target.dispatchMode === "deliver";
}

function targetAuth(target: WebhookTarget): ConfiguredWebhookAuth {
  if (target.auth) {
    return target.auth;
  }
  if (!isTaskFlowTarget(target)) {
    throw new Error("Ack webhook target is missing auth config.");
  }
  return {
    mode: "bearer",
    secret: target.secretInput,
    prefix: "Bearer",
    legacySharedHeader: true,
  };
}

function targetSecretConfigPath(target: WebhookTarget): string {
  return target.secretConfigPath ?? `plugins.entries.webhooks.routes.${target.routeId}.auth.secret`;
}

function parseJsonBody(rawBody: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(rawBody) };
  } catch {
    return { ok: false };
  }
}

function writeInvalidJsonBody(res: ServerResponse): void {
  res.statusCode = 400;
  res.end("invalid request body");
}

export function createTaskFlowWebhookRequestHandler(params: {
  cfg: OpenClawConfig;
  targetsByPath: Map<string, WebhookTarget[]>;
  inFlightLimiter?: WebhookInFlightLimiter;
  idempotencyStore?: WebhookIdempotencyStore;
  scheduleSessionTurn?: ScheduleSessionTurn;
  onAgentCompletionDispatch?: (dispatch: WebhookAgentCompletionDispatch) => void | Promise<void>;
  loadChannelOutboundAdapter?: LoadChannelOutboundAdapter;
  logger?: WebhookLogger;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
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
  const idempotencyRecords = createInMemoryIdempotencyRecords();
  const resolveTargetSecret = async (target: WebhookTarget): Promise<string | undefined> => {
    const secretInput = targetAuth(target).secret;
    if (typeof secretInput === "string") {
      return secretInput;
    }
    const resolved = await resolveConfiguredSecretInputString({
      config: params.cfg,
      env: process.env,
      value: secretInput,
      path: targetSecretConfigPath(target),
    });
    return resolved.value;
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    return await withResolvedWebhookRequestPipeline({
      req,
      res,
      targetsByPath: params.targetsByPath,
      allowMethods: ["POST"],
      requireJsonContentType: true,
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
        return `${new URL(req.url ?? "/", "http://localhost").pathname}:${clientIp}`;
      })(),
      inFlightLimiter,
      handle: async ({ targets }: { path: string; targets: WebhookTarget[] }) => {
        const body = await readWebhookBodyOrReject({
          req,
          res,
          maxBytes: 256 * 1024,
          timeoutMs: 15_000,
          invalidBodyMessage: "invalid request body",
        });
        if (!body.ok) {
          return true;
        }

        const target = await resolveWebhookTargetWithAuthOrReject({
          targets,
          res,
          isMatch: async (candidate: WebhookTarget) => {
            const auth = targetAuth(candidate);
            const presentedSecret = extractPresentedSecret({ req, auth });
            if (presentedSecret.length === 0) {
              return false;
            }
            const resolvedSecret = await resolveTargetSecret(candidate);
            if (!resolvedSecret) {
              return false;
            }
            if (auth.mode === "hmac-sha256") {
              return hmacMatches({
                rawBody: body.value,
                secret: resolvedSecret,
                presentedSignature: presentedSecret,
              });
            }
            return timingSafeEquals(resolvedSecret, presentedSecret);
          },
        });
        if (!target) {
          return true;
        }

        const parsedBody = parseJsonBody(body.value);
        if (!parsedBody.ok) {
          writeInvalidJsonBody(res);
          return true;
        }

        const eventType = extractEventType({
          req,
          body: parsedBody.value,
          config: target.event,
        });
        if (target.events?.length && (!eventType || !target.events.includes(eventType))) {
          writeJson(res, 200, {
            ok: true,
            routeId: target.routeId,
            skipped: true,
            reason: "event_not_allowed",
            ...(eventType ? { eventType } : {}),
          });
          return true;
        }

        const idempotencyKey = extractIdempotencyKey({
          req,
          body: parsedBody.value,
          config: target.idempotency,
        });
        if (target.idempotency) {
          const dedupe = await checkAndStoreDurableIdempotencyKey({
            store: params.idempotencyStore,
            records: idempotencyRecords,
            routeId: target.routeId,
            key: idempotencyKey,
            ttlMs: target.idempotency.ttlMs,
            nowMs: Date.now(),
          });
          if (dedupe.duplicate) {
            writeJson(res, 200, {
              ok: true,
              routeId: target.routeId,
              duplicate: true,
              ...(idempotencyKey ? { idempotencyKey } : {}),
            });
            return true;
          }
        }

        const dispatchContext: WebhookDispatchContext = {
          routeId: target.routeId,
          ...(eventType ? { eventType } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          body: parsedBody.value,
          rawBody: body.value,
          headers: collectRequestHeaders(req),
        };

        if (!isTaskFlowTarget(target)) {
          if (isAgentTarget(target)) {
            const outcome = await executeAgentDispatch({
              target,
              context: dispatchContext,
              scheduleSessionTurn: params.scheduleSessionTurn,
              onAgentCompletionDispatch: params.onAgentCompletionDispatch,
              logger: params.logger,
            });
            writeJson(res, outcome.statusCode, outcome.body);
            return true;
          }
          if (isDeliverTarget(target)) {
            const outcome = await executeDeliveryDispatch({
              target,
              context: dispatchContext,
              loadChannelOutboundAdapter: params.loadChannelOutboundAdapter,
              logger: params.logger,
              cfg: params.cfg,
            });
            writeJson(res, outcome.statusCode, outcome.body);
            return true;
          }
          writeJson(res, 200, {
            ok: true,
            routeId: target.routeId,
            result: {
              action: "ack",
              ...(eventType ? { eventType } : {}),
              ...(idempotencyKey ? { idempotencyKey } : {}),
            },
          });
          return true;
        }

        if (target.taskflow || target.prompt) {
          const result = await executeTaskFlowTemplateDispatch({
            target,
            context: dispatchContext,
          });
          writeJson(res, 202, {
            ok: true,
            routeId: target.routeId,
            result,
          });
          return true;
        }

        const outcome = await executeTaskFlowActionDispatch({
          body: parsedBody.value,
          target,
          cfg: params.cfg,
        });
        writeJson(res, outcome.statusCode, outcome.body);
        return true;
      },
    });
  };
}
