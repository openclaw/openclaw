import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginRuntime } from "../api.js";
import {
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  readWebhookBodyOrReject,
  resolveRequestClientIp,
  resolveConfiguredSecretInputString,
  withResolvedWebhookRequestPipeline,
  WEBHOOK_IN_FLIGHT_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  type OpenClawConfig,
  type WebhookInFlightLimiter,
} from "../runtime-api.js";
import {
  collectRequestHeaders,
  extractPresentedSecretFromHeaders,
  hmacMatches,
  timingSafeEquals,
  type WebhookHeaderMap,
} from "./auth.js";
import type {
  ConfiguredWebhookAuth,
  ConfiguredWebhookAgentDispatchConfig,
  ConfiguredWebhookDeliveryConfig,
  ConfiguredWebhookEventConfig,
  ConfiguredWebhookIdempotencyConfig,
  ConfiguredWebhookVerificationConfig,
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
import { normalizePathString, readTemplatePath } from "./template.js";

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
  info?: (message: string, details?: unknown) => void;
  warn?: (message: string, details?: unknown) => void;
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
  verification?: ConfiguredWebhookVerificationConfig;
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
  verification?: ConfiguredWebhookVerificationConfig;
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
  verification?: ConfiguredWebhookVerificationConfig;
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
  verification?: ConfiguredWebhookVerificationConfig;
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

export type WebhookEnvelope = {
  path: string;
  headers: WebhookHeaderMap;
  rawBody: string;
  remoteAddress?: string;
};

export type WebhookEnvelopeResult = {
  statusCode: number;
  body: unknown;
  contentType: "json" | "text";
};

function jsonResult(statusCode: number, body: unknown): WebhookEnvelopeResult {
  return { statusCode, body, contentType: "json" };
}

function textResult(statusCode: number, body: string): WebhookEnvelopeResult {
  return { statusCode, body, contentType: "text" };
}

function maybeCreateVerificationResult(params: {
  target: WebhookTarget;
  eventType?: string;
  body: unknown;
}): WebhookEnvelopeResult | undefined {
  const verification = params.target.verification;
  if (!verification) {
    return undefined;
  }
  if (verification.event && params.eventType !== verification.event) {
    return undefined;
  }
  const challenge = normalizePathString(readTemplatePath(params.body, verification.challengePath));
  if (!challenge) {
    return undefined;
  }
  return jsonResult(200, {
    [verification.responsePath]: challenge,
  });
}

async function resolveTargetSecret(params: {
  target: WebhookTarget;
  cfg: OpenClawConfig;
}): Promise<string | undefined> {
  const secretInput = targetAuth(params.target).secret;
  if (typeof secretInput === "string") {
    return secretInput;
  }
  const resolved = await resolveConfiguredSecretInputString({
    config: params.cfg,
    env: process.env,
    value: secretInput,
    path: targetSecretConfigPath(params.target),
  });
  return resolved.value;
}

async function isTargetAuthMatch(params: {
  target: WebhookTarget;
  headers: WebhookHeaderMap;
  rawBody: string;
  cfg: OpenClawConfig;
}): Promise<boolean> {
  const auth = targetAuth(params.target);
  const presentedSecret = extractPresentedSecretFromHeaders({ headers: params.headers, auth });
  if (presentedSecret.length === 0) {
    return false;
  }
  const resolvedSecret = await resolveTargetSecret({
    target: params.target,
    cfg: params.cfg,
  });
  if (!resolvedSecret) {
    return false;
  }
  if (auth.mode === "hmac-sha256") {
    return hmacMatches({
      rawBody: params.rawBody,
      secret: resolvedSecret,
      presentedSignature: presentedSecret,
    });
  }
  return timingSafeEquals(resolvedSecret, presentedSecret);
}

export async function handleWebhookEnvelope(params: {
  cfg: OpenClawConfig;
  targets: WebhookTarget[];
  envelope: WebhookEnvelope;
  idempotencyRecords: ReturnType<typeof createInMemoryIdempotencyRecords>;
  idempotencyStore?: WebhookIdempotencyStore;
  scheduleSessionTurn?: ScheduleSessionTurn;
  onAgentCompletionDispatch?: (dispatch: WebhookAgentCompletionDispatch) => void | Promise<void>;
  loadChannelOutboundAdapter?: LoadChannelOutboundAdapter;
  logger?: WebhookLogger;
}): Promise<WebhookEnvelopeResult> {
  let target: WebhookTarget | undefined;
  for (const candidate of params.targets) {
    if (
      await isTargetAuthMatch({
        target: candidate,
        headers: params.envelope.headers,
        rawBody: params.envelope.rawBody,
        cfg: params.cfg,
      })
    ) {
      target = candidate;
      break;
    }
  }
  if (!target) {
    return textResult(401, "unauthorized");
  }

  const parsedBody = parseJsonBody(params.envelope.rawBody);
  if (!parsedBody.ok) {
    return textResult(400, "invalid request body");
  }

  const eventType = extractEventType({
    headers: params.envelope.headers,
    body: parsedBody.value,
    config: target.event,
  });
  const verificationResult = maybeCreateVerificationResult({
    target,
    eventType,
    body: parsedBody.value,
  });
  if (verificationResult) {
    return verificationResult;
  }

  if (target.events?.length && (!eventType || !target.events.includes(eventType))) {
    return jsonResult(200, {
      ok: true,
      routeId: target.routeId,
      skipped: true,
      reason: "event_not_allowed",
      ...(eventType ? { eventType } : {}),
    });
  }

  const idempotencyKey = extractIdempotencyKey({
    headers: params.envelope.headers,
    body: parsedBody.value,
    config: target.idempotency,
  });
  if (target.idempotency) {
    const dedupe = await checkAndStoreDurableIdempotencyKey({
      store: params.idempotencyStore,
      records: params.idempotencyRecords,
      routeId: target.routeId,
      key: idempotencyKey,
      ttlMs: target.idempotency.ttlMs,
      nowMs: Date.now(),
    });
    if (dedupe.duplicate) {
      return jsonResult(200, {
        ok: true,
        routeId: target.routeId,
        duplicate: true,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    }
  }

  const dispatchContext: WebhookDispatchContext = {
    routeId: target.routeId,
    ...(eventType ? { eventType } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    body: parsedBody.value,
    rawBody: params.envelope.rawBody,
    headers: params.envelope.headers,
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
      return jsonResult(outcome.statusCode, outcome.body);
    }
    if (isDeliverTarget(target)) {
      const outcome = await executeDeliveryDispatch({
        target,
        context: dispatchContext,
        loadChannelOutboundAdapter: params.loadChannelOutboundAdapter,
        logger: params.logger,
        cfg: params.cfg,
      });
      return jsonResult(outcome.statusCode, outcome.body);
    }
    return jsonResult(200, {
      ok: true,
      routeId: target.routeId,
      result: {
        action: "ack",
        ...(eventType ? { eventType } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    });
  }

  if (target.taskflow || target.prompt) {
    const result = await executeTaskFlowTemplateDispatch({
      target,
      context: dispatchContext,
    });
    return jsonResult(202, {
      ok: true,
      routeId: target.routeId,
      result,
    });
  }

  const outcome = await executeTaskFlowActionDispatch({
    body: parsedBody.value,
    target,
    cfg: params.cfg,
  });
  return jsonResult(outcome.statusCode, outcome.body);
}

function writeEnvelopeResult(res: ServerResponse, result: WebhookEnvelopeResult): void {
  if (result.contentType === "json") {
    writeJson(res, result.statusCode, result.body);
    return;
  }
  res.statusCode = result.statusCode;
  res.end(String(result.body));
}

export function createTaskFlowWebhookRequestHandler(params: {
  cfg: OpenClawConfig;
  targetsByPath: Map<string, WebhookTarget[]>;
  resolveTargetsByPath?: () => Promise<Map<string, WebhookTarget[]>>;
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

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const targetsByPath = params.resolveTargetsByPath
      ? await params.resolveTargetsByPath()
      : params.targetsByPath;
    return await withResolvedWebhookRequestPipeline({
      req,
      res,
      targetsByPath,
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
      handle: async ({ path, targets }: { path: string; targets: WebhookTarget[] }) => {
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

        const result = await handleWebhookEnvelope({
          cfg: params.cfg,
          targets,
          envelope: {
            path,
            headers: collectRequestHeaders(req),
            rawBody: body.value,
            remoteAddress: req.socket.remoteAddress,
          },
          idempotencyRecords,
          idempotencyStore: params.idempotencyStore,
          scheduleSessionTurn: params.scheduleSessionTurn,
          onAgentCompletionDispatch: params.onAgentCompletionDispatch,
          loadChannelOutboundAdapter: params.loadChannelOutboundAdapter,
          logger: params.logger,
        });
        writeEnvelopeResult(res, result);
        return true;
      },
    });
  };
}
