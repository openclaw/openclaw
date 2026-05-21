import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
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
import type {
  ConfiguredWebhookAuth,
  ConfiguredWebhookAgentDispatchConfig,
  ConfiguredWebhookDeliveryConfig,
  ConfiguredWebhookEventConfig,
  ConfiguredWebhookIdempotencyConfig,
  ConfiguredWebhookTaskFlowTemplateConfig,
  WebhookSecretInput,
} from "./config.js";

type BoundTaskFlowRuntime = ReturnType<PluginRuntime["tasks"]["managedFlows"]["bindSession"]>;
type LoadChannelOutboundAdapter = PluginRuntime["channel"]["outbound"]["loadAdapter"];

type ScheduleSessionTurn = (params: {
  sessionKey: string;
  message: string;
  agentId?: string;
  deliveryMode?: "none" | "announce";
  name?: string;
  tag?: string;
  delayMs: number;
  deleteAfterRun?: boolean;
}) => Promise<{ id: string; pluginId: string; sessionKey: string; kind: string } | undefined>;

type WebhookIdempotencyStore = {
  registerIfAbsent: (
    key: string,
    value: {
      routeId: string;
      idempotencyKey: string;
      firstSeenAt: number;
    },
    opts?: { ttlMs?: number },
  ) => Promise<boolean>;
};

type WebhookLogger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function normalizeJsonForState(value: unknown): JsonValue {
  const seen = new WeakSet<object>();
  const normalize = (entry: unknown): JsonValue => {
    if (entry === null) {
      return null;
    }
    if (typeof entry === "string" || typeof entry === "boolean") {
      return entry;
    }
    if (typeof entry === "number") {
      return Number.isFinite(entry) ? entry : String(entry);
    }
    if (typeof entry === "bigint") {
      return entry.toString();
    }
    if (Array.isArray(entry)) {
      return entry.map(normalize);
    }
    if (typeof entry === "object") {
      if (seen.has(entry)) {
        return "[Circular]";
      }
      seen.add(entry);
      try {
        const record: Record<string, JsonValue> = {};
        for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
          record[key] = normalize((entry as Record<string, unknown>)[key]);
        }
        return record;
      } finally {
        seen.delete(entry);
      }
    }
    return null;
  };
  return normalize(value);
}

function jsonStringifyStable(value: unknown, maxChars?: number): string {
  const rendered = JSON.stringify(normalizeJsonForState(value), null, 2) ?? "null";
  return maxChars ? truncateTemplateString(rendered, maxChars) : rendered;
}

function truncateTemplateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function toTemplateString(value: unknown, maxChars?: number): string {
  if (value === null) {
    return "";
  }
  if (typeof value === "string") {
    return maxChars ? truncateTemplateString(value, maxChars) : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === undefined) {
    return "";
  }
  return jsonStringifyStable(value, maxChars);
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const nullableStringSchema = z.string().trim().min(1).nullable().optional();

const createFlowRequestSchema = z
  .object({
    action: z.literal("create_flow"),
    controllerId: z.string().trim().min(1).optional(),
    goal: z.string().trim().min(1),
    status: z.enum(["queued", "running", "waiting", "blocked"]).optional(),
    notifyPolicy: z.enum(["done_only", "state_changes", "silent"]).optional(),
    currentStep: nullableStringSchema,
    stateJson: jsonValueSchema.nullable().optional(),
    waitJson: jsonValueSchema.nullable().optional(),
  })
  .strict();

const getFlowRequestSchema = z
  .object({ action: z.literal("get_flow"), flowId: z.string().trim().min(1) })
  .strict();
const listFlowsRequestSchema = z.object({ action: z.literal("list_flows") }).strict();
const findLatestFlowRequestSchema = z.object({ action: z.literal("find_latest_flow") }).strict();
const resolveFlowRequestSchema = z
  .object({ action: z.literal("resolve_flow"), token: z.string().trim().min(1) })
  .strict();
const getTaskSummaryRequestSchema = z
  .object({ action: z.literal("get_task_summary"), flowId: z.string().trim().min(1) })
  .strict();

const setWaitingRequestSchema = z
  .object({
    action: z.literal("set_waiting"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    currentStep: nullableStringSchema,
    stateJson: jsonValueSchema.nullable().optional(),
    waitJson: jsonValueSchema.nullable().optional(),
    blockedTaskId: nullableStringSchema,
    blockedSummary: nullableStringSchema,
  })
  .strict();

const resumeFlowRequestSchema = z
  .object({
    action: z.literal("resume_flow"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    status: z.enum(["queued", "running"]).optional(),
    currentStep: nullableStringSchema,
    stateJson: jsonValueSchema.nullable().optional(),
  })
  .strict();

const finishFlowRequestSchema = z
  .object({
    action: z.literal("finish_flow"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    stateJson: jsonValueSchema.nullable().optional(),
  })
  .strict();

const failFlowRequestSchema = z
  .object({
    action: z.literal("fail_flow"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    stateJson: jsonValueSchema.nullable().optional(),
    blockedTaskId: nullableStringSchema,
    blockedSummary: nullableStringSchema,
  })
  .strict();

const requestCancelRequestSchema = z
  .object({
    action: z.literal("request_cancel"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

const cancelFlowRequestSchema = z
  .object({
    action: z.literal("cancel_flow"),
    flowId: z.string().trim().min(1),
  })
  .strict();

const runTaskRequestSchema = z
  .object({
    action: z.literal("run_task"),
    flowId: z.string().trim().min(1),
    runtime: z.enum(["subagent", "acp"]),
    sourceId: z.string().trim().min(1).optional(),
    childSessionKey: z.string().trim().min(1).optional(),
    parentTaskId: z.string().trim().min(1).optional(),
    agentId: z.string().trim().min(1).optional(),
    runId: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
    task: z.string().trim().min(1),
    preferMetadata: z.boolean().optional(),
    notifyPolicy: z.enum(["done_only", "state_changes", "silent"]).optional(),
    status: z.enum(["queued", "running"]).optional(),
    startedAt: z.number().int().nonnegative().optional(),
    lastEventAt: z.number().int().nonnegative().optional(),
    progressSummary: nullableStringSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.status !== "running" &&
      (value.startedAt !== undefined ||
        value.lastEventAt !== undefined ||
        value.progressSummary !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "status must be running when startedAt, lastEventAt, or progressSummary is provided",
        path: ["status"],
      });
    }
  });

const webhookActionSchema = z.discriminatedUnion("action", [
  createFlowRequestSchema,
  getFlowRequestSchema,
  listFlowsRequestSchema,
  findLatestFlowRequestSchema,
  resolveFlowRequestSchema,
  getTaskSummaryRequestSchema,
  setWaitingRequestSchema,
  resumeFlowRequestSchema,
  finishFlowRequestSchema,
  failFlowRequestSchema,
  requestCancelRequestSchema,
  cancelFlowRequestSchema,
  runTaskRequestSchema,
]);

type WebhookAction = z.infer<typeof webhookActionSchema>;

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

type FlowView = {
  flowId: string;
  syncMode: "task_mirrored" | "managed";
  controllerId?: string;
  revision: number;
  status: string;
  notifyPolicy: string;
  goal: string;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
  stateJson?: JsonValue;
  waitJson?: JsonValue;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};

type TaskView = {
  taskId: string;
  runtime: string;
  sourceId?: string;
  scopeKind: string;
  childSessionKey?: string;
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  status: string;
  deliveryStatus: string;
  notifyPolicy: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: string;
};

type WebhookDispatchContext = {
  routeId: string;
  eventType?: string;
  idempotencyKey?: string;
  body: unknown;
  rawBody: string;
  headers: Record<string, string>;
};

const DEFAULT_EVENT_HEADERS = [
  "x-github-event",
  "x-gitlab-event",
  "x-event-type",
  "x-webhook-event",
] as const;

const DEFAULT_EVENT_PAYLOAD_PATHS = ["event_type", "event.type", "event.action", "type"] as const;

const DEFAULT_IDEMPOTENCY_HEADERS = [
  "x-github-delivery",
  "x-request-id",
  "x-webhook-id",
  "x-delivery-id",
] as const;

const DEFAULT_IDEMPOTENCY_PAYLOAD_PATHS = [
  "delivery.id",
  "event.id",
  "webhook.id",
  "request.id",
] as const;

function pickOptionalFields<T extends object, TKey extends keyof T & string>(
  source: T,
  keys: readonly TKey[],
): Partial<Pick<T, TKey>> {
  const result: Partial<Pick<T, TKey>> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function pickOptionalTruthyStringFields<T extends object, TKey extends keyof T & string>(
  source: T,
  keys: readonly TKey[],
): Partial<Pick<T, TKey>> {
  const result: Partial<Pick<T, TKey>> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value) {
      result[key] = value as T[TKey];
    }
  }
  return result;
}

function toFlowView(flow: FlowView): FlowView {
  return {
    flowId: flow.flowId,
    syncMode: flow.syncMode,
    ...pickOptionalTruthyStringFields(flow, [
      "controllerId",
      "currentStep",
      "blockedTaskId",
      "blockedSummary",
    ]),
    revision: flow.revision,
    status: flow.status,
    notifyPolicy: flow.notifyPolicy,
    goal: flow.goal,
    ...pickOptionalFields(flow, ["stateJson", "waitJson", "cancelRequestedAt"]),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    ...pickOptionalFields(flow, ["endedAt"]),
  };
}

function toTaskView(task: TaskView): TaskView {
  return {
    taskId: task.taskId,
    runtime: task.runtime,
    ...pickOptionalTruthyStringFields(task, [
      "sourceId",
      "childSessionKey",
      "parentFlowId",
      "parentTaskId",
      "agentId",
      "runId",
      "label",
      "error",
      "progressSummary",
      "terminalSummary",
      "terminalOutcome",
    ]),
    scopeKind: task.scopeKind,
    task: task.task,
    status: task.status,
    deliveryStatus: task.deliveryStatus,
    notifyPolicy: task.notifyPolicy,
    createdAt: task.createdAt,
    ...pickOptionalFields(task, ["startedAt", "endedAt", "lastEventAt", "cleanupAfter"]),
  };
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function collectRequestHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[normalizeLowercaseStringOrEmpty(name)] = firstHeaderValue(value).trim();
  }
  return headers;
}

function getHeader(req: IncomingMessage, name: string): string {
  return firstHeaderValue(req.headers[normalizeLowercaseStringOrEmpty(name)]).trim();
}

function extractBearerSecret(req: IncomingMessage, prefix: string): string {
  const authHeader = firstHeaderValue(req.headers.authorization);
  const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
  const normalizedAuthHeader = normalizeLowercaseStringOrEmpty(authHeader);
  const tokenPrefix = `${normalizedPrefix} `;
  if (normalizedPrefix.length > 0 && normalizedAuthHeader.startsWith(tokenPrefix)) {
    return authHeader.slice(prefix.length + 1).trim();
  }
  return "";
}

function extractPresentedSecret(params: {
  req: IncomingMessage;
  auth: ConfiguredWebhookAuth;
}): string {
  const { req, auth } = params;
  if (auth.mode === "bearer") {
    const bearerSecret = extractBearerSecret(req, auth.prefix);
    if (bearerSecret || !auth.legacySharedHeader) {
      return bearerSecret;
    }
    return getHeader(req, "x-openclaw-webhook-secret");
  }
  const value = getHeader(req, auth.header);
  if (!auth.prefix) {
    return value;
  }
  return value.startsWith(auth.prefix) ? value.slice(auth.prefix.length).trim() : "";
}

function timingSafeEquals(left: string, right: string): boolean {
  // Reuse the shared helper so webhook auth semantics stay aligned across plugins.
  return safeEqualSecret(left, right);
}

function timingSafeAsciiEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  const maxLength = Math.max(leftBuffer.length, rightBuffer.length);
  const paddedLeft = Buffer.alloc(maxLength);
  const paddedRight = Buffer.alloc(maxLength);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);
  const equal = timingSafeEqual(paddedLeft, paddedRight);
  return leftBuffer.length === rightBuffer.length && equal;
}

function isTaskFlowTarget(target: WebhookTarget): target is TaskFlowWebhookTarget {
  return target.dispatchMode === undefined || target.dispatchMode === "taskflow";
}

function isAgentTarget(target: WebhookTarget): target is AgentWebhookTarget {
  return target.dispatchMode === "agent";
}

function isDeliverTarget(target: WebhookTarget): target is DeliverWebhookTarget {
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

const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function readPayloadPath(value: unknown, path: string | undefined): unknown {
  if (!path) {
    return undefined;
  }
  let current = value;
  for (const rawSegment of path.split(".")) {
    const segment = rawSegment.trim();
    if (!segment || BLOCKED_PATH_SEGMENTS.has(segment)) {
      return undefined;
    }
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function readTemplatePath(value: unknown, path: string): unknown {
  if (!path) {
    return undefined;
  }
  let current = value;
  for (const rawSegment of path.split(".")) {
    const segment = rawSegment.trim();
    if (!segment || BLOCKED_PATH_SEGMENTS.has(segment)) {
      return undefined;
    }
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function normalizePathString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function extractEventType(params: {
  req: IncomingMessage;
  body: unknown;
  config: ConfiguredWebhookEventConfig | undefined;
}): string | undefined {
  const fromHeader = params.config?.header ? getHeader(params.req, params.config.header) : "";
  if (fromHeader) {
    return fromHeader;
  }
  const fromPayload = normalizePathString(readPayloadPath(params.body, params.config?.payloadPath));
  if (fromPayload) {
    return fromPayload;
  }
  for (const header of DEFAULT_EVENT_HEADERS) {
    const value = getHeader(params.req, header);
    if (value) {
      return value;
    }
  }
  for (const path of DEFAULT_EVENT_PAYLOAD_PATHS) {
    const value = normalizePathString(readPayloadPath(params.body, path));
    if (value) {
      return value;
    }
  }
  return undefined;
}

function extractIdempotencyKey(params: {
  req: IncomingMessage;
  body: unknown;
  config: ConfiguredWebhookIdempotencyConfig | undefined;
}): string | undefined {
  const fromHeader = params.config?.header ? getHeader(params.req, params.config.header) : "";
  if (fromHeader) {
    return fromHeader;
  }
  const fromPayload = normalizePathString(readPayloadPath(params.body, params.config?.payloadPath));
  if (fromPayload) {
    return fromPayload;
  }
  if (!params.config) {
    return undefined;
  }
  for (const header of DEFAULT_IDEMPOTENCY_HEADERS) {
    const value = getHeader(params.req, header);
    if (value) {
      return value;
    }
  }
  for (const path of DEFAULT_IDEMPOTENCY_PAYLOAD_PATHS) {
    const value = normalizePathString(readPayloadPath(params.body, path));
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeTemplateOutput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function sanitizeSchedulerToken(value: string | undefined): string | undefined {
  const normalized = normalizeTemplateOutput(value);
  if (!normalized) {
    return undefined;
  }
  const safe = normalized.replace(/:/g, "-").replace(/\s+/g, "-").slice(0, 96);
  return safe || undefined;
}

function renderDeliveryField(
  value: string | number | undefined,
  context: WebhookDispatchContext,
): string | number | undefined {
  if (typeof value === "string") {
    return renderTemplate(value, context).trim();
  }
  return value;
}

function renderTemplateExpression(params: {
  match: string;
  rawExpression: string;
  context: WebhookDispatchContext;
  keepMissingLiteral: boolean;
}): string {
  const expression = params.rawExpression.trim();
  if (!expression) {
    return params.keepMissingLiteral ? params.match : "";
  }
  if (expression === "__raw__") {
    return jsonStringifyStable(params.context.body, 4000);
  }
  if (expression.startsWith("json ")) {
    const path = expression.slice(5).trim();
    const value = resolveTemplateValue(path, params.context);
    if (value === undefined && params.keepMissingLiteral) {
      return params.match;
    }
    if (value === undefined) {
      return "";
    }
    return jsonStringifyStable(value);
  }
  const value = resolveTemplateValue(expression, params.context);
  if (value === undefined && params.keepMissingLiteral) {
    return params.match;
  }
  return toTemplateString(value, params.keepMissingLiteral ? 2000 : undefined);
}

function renderTemplate(template: string, context: WebhookDispatchContext): string {
  return template.replace(
    /\{\{\s*([^}]+?)\s*\}\}|\{([^{}\n]+)\}/g,
    (
      match: string,
      doubleBraceExpression: string | undefined,
      singleBraceExpression: string | undefined,
    ) =>
      renderTemplateExpression({
        match,
        rawExpression: doubleBraceExpression ?? singleBraceExpression ?? "",
        context,
        keepMissingLiteral: singleBraceExpression !== undefined,
      }),
  );
}

function renderOptionalTemplate(
  template: string | undefined,
  context: WebhookDispatchContext,
): string | undefined {
  return template ? normalizeTemplateOutput(renderTemplate(template, context)) : undefined;
}

function resolveTemplateValue(path: string, context: WebhookDispatchContext): unknown {
  switch (path) {
    case "body":
    case "payload":
      return context.body;
    case "rawBody":
      return context.rawBody;
    case "event":
    case "eventType":
      return context.eventType;
    case "route":
    case "routeId":
      return context.routeId;
    case "idempotency":
    case "idempotencyKey":
      return context.idempotencyKey;
    default:
      break;
  }
  if (path.startsWith("body.")) {
    return readTemplatePath(context.body, path.slice("body.".length));
  }
  if (path.startsWith("payload.")) {
    return readTemplatePath(context.body, path.slice("payload.".length));
  }
  if (path.startsWith("headers.")) {
    return context.headers[path.slice("headers.".length).toLowerCase()];
  }
  if (path.startsWith("header.")) {
    return context.headers[path.slice("header.".length).toLowerCase()];
  }
  if (path.startsWith("event.")) {
    const eventMetadata = readTemplatePath({ type: context.eventType }, path.slice("event.".length));
    return eventMetadata !== undefined ? eventMetadata : readTemplatePath(context.body, path);
  }
  return readTemplatePath(context.body, path);
}

function buildDefaultWebhookPrompt(context: WebhookDispatchContext): string {
  const lines = [
    `Webhook route: ${context.routeId}`,
    context.eventType ? `Event: ${context.eventType}` : undefined,
    context.idempotencyKey ? `Delivery id: ${context.idempotencyKey}` : undefined,
    "",
    "Payload:",
    jsonStringifyStable(context.body),
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

function applySkillHint(text: string, skills: string[] | undefined): string {
  if (!skills?.length) {
    return text;
  }
  return `${text}\n\nUse these OpenClaw skills when useful: ${skills.join(", ")}`;
}

type IdempotencyRecord = {
  expiresAt: number;
};

function pruneExpiredIdempotencyRecords(
  records: Map<string, IdempotencyRecord>,
  nowMs: number,
): void {
  for (const [key, record] of records) {
    if (record.expiresAt <= nowMs) {
      records.delete(key);
    }
  }
}

function checkAndStoreIdempotencyKey(params: {
  records: Map<string, IdempotencyRecord>;
  routeId: string;
  key: string | undefined;
  ttlMs: number;
  nowMs: number;
}): { duplicate: boolean } {
  const key = params.key?.trim();
  if (!key) {
    return { duplicate: false };
  }
  pruneExpiredIdempotencyRecords(params.records, params.nowMs);
  const storageKey = `${params.routeId}:${key}`;
  const existing = params.records.get(storageKey);
  if (existing && existing.expiresAt > params.nowMs) {
    return { duplicate: true };
  }
  params.records.set(storageKey, {
    expiresAt: params.nowMs + params.ttlMs,
  });
  return { duplicate: false };
}

async function checkAndStoreDurableIdempotencyKey(params: {
  store: WebhookIdempotencyStore | undefined;
  records: Map<string, IdempotencyRecord>;
  routeId: string;
  key: string | undefined;
  ttlMs: number;
  nowMs: number;
}): Promise<{ duplicate: boolean }> {
  const key = params.key?.trim();
  if (!key) {
    return { duplicate: false };
  }
  const storageKey = `${params.routeId}:${key}`;
  pruneExpiredIdempotencyRecords(params.records, params.nowMs);
  const existing = params.records.get(storageKey);
  if (existing && existing.expiresAt > params.nowMs) {
    return { duplicate: true };
  }
  if (params.store) {
    try {
      const inserted = await params.store.registerIfAbsent(
        storageKey,
        {
          routeId: params.routeId,
          idempotencyKey: key,
          firstSeenAt: params.nowMs,
        },
        { ttlMs: params.ttlMs },
      );
      if (!inserted) {
        return { duplicate: true };
      }
    } catch {
      return checkAndStoreIdempotencyKey(params);
    }
  }
  params.records.set(storageKey, {
    expiresAt: params.nowMs + params.ttlMs,
  });
  return { duplicate: false };
}

function hmacMatches(params: {
  rawBody: string;
  secret: string;
  presentedSignature: string;
}): boolean {
  const expected = createHmac("sha256", params.secret).update(params.rawBody).digest("hex");
  return timingSafeAsciiEquals(
    normalizeLowercaseStringOrEmpty(expected),
    normalizeLowercaseStringOrEmpty(params.presentedSignature),
  );
}

function formatZodError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  if (!firstIssue) {
    return "invalid request";
  }
  const path = firstIssue.path.length > 0 ? `${firstIssue.path.join(".")}: ` : "";
  return `${path}${firstIssue.message}`;
}

function mapMutationResult(
  result:
    | {
        applied: true;
        flow: FlowView;
      }
    | {
        applied: false;
        code: string;
        current?: FlowView;
      },
): unknown {
  return result;
}

function mapFlowMutationResult(
  result:
    | {
        applied: true;
        flow: Parameters<typeof toFlowView>[0];
      }
    | {
        applied: false;
        code: string;
        current?: Parameters<typeof toFlowView>[0];
      },
): unknown {
  return mapMutationResult(
    result.applied
      ? { applied: true, flow: toFlowView(result.flow) }
      : {
          applied: false,
          code: result.code,
          ...(result.current ? { current: toFlowView(result.current) } : {}),
        },
  );
}

function mapMutationStatus(result: {
  applied: boolean;
  code?: "not_found" | "not_managed" | "revision_conflict";
}): { statusCode: number; code?: string; error?: string } {
  if (result.applied) {
    return { statusCode: 200 };
  }
  switch (result.code) {
    case "not_found":
      return {
        statusCode: 404,
        code: "not_found",
        error: "TaskFlow not found.",
      };
    case "not_managed":
      return {
        statusCode: 409,
        code: "not_managed",
        error: "TaskFlow is not managed by this webhook surface.",
      };
    case "revision_conflict":
      return {
        statusCode: 409,
        code: "revision_conflict",
        error: "TaskFlow changed since the caller's expected revision.",
      };
    default:
      return {
        statusCode: 409,
        code: "mutation_rejected",
        error: "TaskFlow mutation was rejected.",
      };
  }
}

function mapRunTaskStatus(result: { created: boolean; found: boolean; reason?: string }): {
  statusCode: number;
  code?: string;
  error?: string;
} {
  if (result.created) {
    return { statusCode: 200 };
  }
  if (!result.found) {
    return {
      statusCode: 404,
      code: "not_found",
      error: "TaskFlow not found.",
    };
  }
  if (result.reason === "Flow cancellation has already been requested.") {
    return {
      statusCode: 409,
      code: "cancel_requested",
      error: result.reason,
    };
  }
  if (result.reason === "Flow does not accept managed child tasks.") {
    return {
      statusCode: 409,
      code: "not_managed",
      error: result.reason,
    };
  }
  if (result.reason?.startsWith("Flow is already ")) {
    return {
      statusCode: 409,
      code: "terminal",
      error: result.reason,
    };
  }
  return {
    statusCode: 409,
    code: "task_not_created",
    error: result.reason ?? "TaskFlow task was not created.",
  };
}

function mapCancelStatus(result: { found: boolean; cancelled: boolean; reason?: string }): {
  statusCode: number;
  code?: string;
  error?: string;
} {
  if (result.cancelled) {
    return { statusCode: 200 };
  }
  if (!result.found) {
    return {
      statusCode: 404,
      code: "not_found",
      error: "TaskFlow not found.",
    };
  }
  if (result.reason === "One or more child tasks are still active.") {
    return {
      statusCode: 202,
      code: "cancel_pending",
      error: result.reason,
    };
  }
  if (result.reason === "Flow changed while cancellation was in progress.") {
    return {
      statusCode: 409,
      code: "revision_conflict",
      error: result.reason,
    };
  }
  if (result.reason?.startsWith("Flow is already ")) {
    return {
      statusCode: 409,
      code: "terminal",
      error: result.reason,
    };
  }
  return {
    statusCode: 409,
    code: "cancel_rejected",
    error: result.reason ?? "TaskFlow cancellation was rejected.",
  };
}

function describeWebhookOutcome(params: { action: WebhookAction; result: unknown }): {
  statusCode: number;
  code?: string;
  error?: string;
} {
  switch (params.action.action) {
    case "set_waiting":
    case "resume_flow":
    case "finish_flow":
    case "fail_flow":
    case "request_cancel":
      return mapMutationStatus(
        params.result as {
          applied: boolean;
          code?: "not_found" | "not_managed" | "revision_conflict";
        },
      );
    case "cancel_flow":
      return mapCancelStatus(
        params.result as {
          found: boolean;
          cancelled: boolean;
          reason?: string;
        },
      );
    case "run_task":
      return mapRunTaskStatus(
        params.result as {
          created: boolean;
          found: boolean;
          reason?: string;
        },
      );
    default:
      return { statusCode: 200 };
  }
}

async function executeWebhookAction(params: {
  action: WebhookAction;
  target: TaskFlowWebhookTarget;
  cfg: OpenClawConfig;
}): Promise<unknown> {
  const { action, target } = params;
  switch (action.action) {
    case "create_flow": {
      const flow = target.taskFlow.createManaged({
        controllerId: action.controllerId ?? target.defaultControllerId,
        goal: action.goal,
        status: action.status,
        notifyPolicy: action.notifyPolicy,
        currentStep: action.currentStep ?? undefined,
        stateJson: action.stateJson,
        waitJson: action.waitJson,
      });
      return { flow: toFlowView(flow) };
    }
    case "get_flow": {
      const flow = target.taskFlow.get(action.flowId);
      return { flow: flow ? toFlowView(flow) : null };
    }
    case "list_flows":
      return { flows: target.taskFlow.list().map(toFlowView) };
    case "find_latest_flow": {
      const flow = target.taskFlow.findLatest();
      return { flow: flow ? toFlowView(flow) : null };
    }
    case "resolve_flow": {
      const flow = target.taskFlow.resolve(action.token);
      return { flow: flow ? toFlowView(flow) : null };
    }
    case "get_task_summary":
      return { summary: target.taskFlow.getTaskSummary(action.flowId) ?? null };
    case "set_waiting": {
      const result = target.taskFlow.setWaiting({
        flowId: action.flowId,
        expectedRevision: action.expectedRevision,
        currentStep: action.currentStep,
        stateJson: action.stateJson,
        waitJson: action.waitJson,
        blockedTaskId: action.blockedTaskId,
        blockedSummary: action.blockedSummary,
      });
      return mapFlowMutationResult(result);
    }
    case "resume_flow": {
      const result = target.taskFlow.resume({
        flowId: action.flowId,
        expectedRevision: action.expectedRevision,
        status: action.status,
        currentStep: action.currentStep,
        stateJson: action.stateJson,
      });
      return mapFlowMutationResult(result);
    }
    case "finish_flow": {
      const result = target.taskFlow.finish({
        flowId: action.flowId,
        expectedRevision: action.expectedRevision,
        stateJson: action.stateJson,
      });
      return mapFlowMutationResult(result);
    }
    case "fail_flow": {
      const result = target.taskFlow.fail({
        flowId: action.flowId,
        expectedRevision: action.expectedRevision,
        stateJson: action.stateJson,
        blockedTaskId: action.blockedTaskId,
        blockedSummary: action.blockedSummary,
      });
      return mapFlowMutationResult(result);
    }
    case "request_cancel": {
      const result = target.taskFlow.requestCancel({
        flowId: action.flowId,
        expectedRevision: action.expectedRevision,
      });
      return mapFlowMutationResult(result);
    }
    case "cancel_flow": {
      const result = await target.taskFlow.cancel({
        flowId: action.flowId,
        cfg: params.cfg,
      });
      return {
        found: result.found,
        cancelled: result.cancelled,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.flow ? { flow: toFlowView(result.flow) } : {}),
        ...(result.tasks ? { tasks: result.tasks.map(toTaskView) } : {}),
      };
    }
    case "run_task": {
      const result = target.taskFlow.runTask({
        flowId: action.flowId,
        runtime: action.runtime,
        sourceId: action.sourceId,
        childSessionKey: action.childSessionKey,
        parentTaskId: action.parentTaskId,
        agentId: action.agentId,
        runId: action.runId,
        label: action.label,
        task: action.task,
        preferMetadata: action.preferMetadata,
        notifyPolicy: action.notifyPolicy,
        status: action.status,
        startedAt: action.startedAt,
        lastEventAt: action.lastEventAt,
        progressSummary: action.progressSummary,
      });
      if (result.created) {
        return {
          created: true,
          flow: toFlowView(result.flow),
          task: toTaskView(result.task),
        };
      }
      return {
        found: result.found,
        created: false,
        reason: result.reason,
        ...(result.flow ? { flow: toFlowView(result.flow) } : {}),
      };
    }
  }
  throw new Error("Unsupported webhook action");
}

async function executeTaskFlowTemplateDispatch(params: {
  target: TaskFlowWebhookTarget;
  context: WebhookDispatchContext;
}): Promise<unknown> {
  const { target, context } = params;
  const taskflow = target.taskflow ?? {};
  const goal =
    renderOptionalTemplate(taskflow.goalTemplate, context) ??
    renderOptionalTemplate(target.prompt, context) ??
    buildDefaultWebhookPrompt(context);
  const flow = target.taskFlow.createManaged({
    controllerId: target.defaultControllerId,
    goal: applySkillHint(goal, target.skills),
    status: taskflow.status,
    notifyPolicy: taskflow.notifyPolicy,
    currentStep: taskflow.currentStep,
    stateJson: {
      source: "webhooks",
      routeId: target.routeId,
      ...(context.eventType ? { eventType: context.eventType } : {}),
      ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
      payload: normalizeJsonForState(context.body),
    },
  });

  const runTask = taskflow.runTask;
  if (!runTask || runTask.enabled === false) {
    return {
      action: "taskflow_dispatch",
      flow: toFlowView(flow),
    };
  }

  const renderedTask =
    renderOptionalTemplate(runTask.taskTemplate, context) ??
    renderOptionalTemplate(target.prompt, context) ??
    buildDefaultWebhookPrompt(context);
  const runId =
    renderOptionalTemplate(runTask.runIdTemplate, context) ??
    context.idempotencyKey ??
    `${target.routeId}:${flow.flowId}`;
  const result = target.taskFlow.runTask({
    flowId: flow.flowId,
    runtime: runTask.runtime,
    sourceId: runTask.sourceId,
    childSessionKey: runTask.childSessionKey,
    parentTaskId: runTask.parentTaskId,
    agentId: runTask.agentId,
    runId,
    label: renderOptionalTemplate(runTask.labelTemplate, context),
    task: applySkillHint(renderedTask, target.skills),
    preferMetadata: runTask.preferMetadata,
    notifyPolicy: runTask.notifyPolicy,
    status: runTask.status,
  });

  return result.created
    ? {
        action: "taskflow_dispatch",
        flow: toFlowView(result.flow),
        task: toTaskView(result.task),
      }
    : {
        action: "taskflow_dispatch",
        flow: toFlowView(flow),
        taskCreated: false,
        reason: result.reason,
      };
}

async function executeAgentDispatch(params: {
  target: AgentWebhookTarget;
  context: WebhookDispatchContext;
  scheduleSessionTurn?: ScheduleSessionTurn;
}): Promise<{ statusCode: number; body: unknown }> {
  const { target, context } = params;
  const message =
    renderOptionalTemplate(target.agent.messageTemplate, context) ??
    renderOptionalTemplate(target.prompt, context) ??
    buildDefaultWebhookPrompt(context);
  const scheduler = params.scheduleSessionTurn;
  const name = renderOptionalTemplate(target.agent.nameTemplate, context);
  const tag = sanitizeSchedulerToken(renderOptionalTemplate(target.agent.tagTemplate, context));
  if (!scheduler) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "agent_dispatch_unavailable",
        error: "Agent dispatch is unavailable in this Gateway runtime.",
      },
    };
  }
  const handle = await scheduler({
    sessionKey: target.sessionKey,
    message: applySkillHint(message, target.skills),
    deliveryMode: target.agent.deliveryMode,
    delayMs: target.agent.delayMs,
    deleteAfterRun: true,
    ...(target.agent.agentId ? { agentId: target.agent.agentId } : {}),
    ...(name ? { name } : {}),
    ...(tag ? { tag } : {}),
  });
  if (!handle) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "agent_dispatch_rejected",
        error: "Agent dispatch was not scheduled.",
      },
    };
  }
  return {
    statusCode: 202,
    body: {
      ok: true,
      routeId: target.routeId,
      result: {
        action: "agent_dispatch",
        sessionKey: handle.sessionKey,
        jobId: handle.id,
      },
    },
  };
}

async function executeDeliveryDispatch(params: {
  target: DeliverWebhookTarget;
  context: WebhookDispatchContext;
  loadChannelOutboundAdapter?: LoadChannelOutboundAdapter;
  logger?: WebhookLogger;
  cfg: OpenClawConfig;
}): Promise<{ statusCode: number; body: unknown }> {
  const { target, context } = params;
  const defaultText =
    renderOptionalTemplate(target.prompt, context) ?? buildDefaultWebhookPrompt(context);
  if (target.delivery.mode === "log") {
    params.logger?.info?.("[webhooks] delivery event", {
      routeId: target.routeId,
      eventType: context.eventType,
      idempotencyKey: context.idempotencyKey,
      text: defaultText,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        routeId: target.routeId,
        result: {
          action: "deliver",
          mode: "log",
          ...(context.eventType ? { eventType: context.eventType } : {}),
          ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
        },
      },
    };
  }

  const loadAdapter = params.loadChannelOutboundAdapter;
  if (!loadAdapter) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "delivery_unavailable",
        error: "Channel delivery is unavailable in this Gateway runtime.",
      },
    };
  }
  const adapter = await loadAdapter(target.delivery.channel);
  if (!adapter?.sendText) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "channel_unavailable",
        error: `Channel ${target.delivery.channel} is not available for text delivery.`,
      },
    };
  }
  const deliveryTo = renderDeliveryField(target.delivery.to, context);
  const deliveryAccountId = renderDeliveryField(target.delivery.accountId, context);
  const deliveryThreadId = renderDeliveryField(target.delivery.threadId, context);
  const normalizedDeliveryTo =
    typeof deliveryTo === "string" && deliveryTo.trim() ? deliveryTo.trim() : undefined;
  if (!normalizedDeliveryTo && !adapter.resolveTarget) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "invalid_delivery_target",
        error:
          "Delivery target is required because the channel does not provide default target resolution.",
      },
    };
  }
  const resolvedTarget = adapter.resolveTarget?.({
    cfg: params.cfg,
    ...(normalizedDeliveryTo ? { to: normalizedDeliveryTo } : {}),
    ...(typeof deliveryAccountId === "string" && deliveryAccountId.trim()
      ? { accountId: deliveryAccountId }
      : {}),
    mode: "explicit",
  });
  if (resolvedTarget?.ok === false) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "invalid_delivery_target",
        error: resolvedTarget.error.message,
      },
    };
  }
  const text =
    renderOptionalTemplate(target.delivery.textTemplate, context) ??
    renderOptionalTemplate(target.prompt, context) ??
    buildDefaultWebhookPrompt(context);
  let result;
  try {
    const outboundTo = resolvedTarget?.ok === true ? resolvedTarget.to : normalizedDeliveryTo;
    if (!outboundTo) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          routeId: target.routeId,
          code: "invalid_delivery_target",
          error: "Delivery target resolved to an empty value.",
        },
      };
    }
    result = await adapter.sendText({
      cfg: params.cfg,
      to: outboundTo,
      text,
      ...(typeof deliveryAccountId === "string" && deliveryAccountId.trim()
        ? { accountId: deliveryAccountId }
        : {}),
      ...(deliveryThreadId !== undefined && deliveryThreadId !== ""
        ? { threadId: deliveryThreadId }
        : {}),
      ...(target.delivery.silent !== undefined ? { silent: target.delivery.silent } : {}),
    });
  } catch (error) {
    return {
      statusCode: 502,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "delivery_failed",
        error: error instanceof Error ? error.message : "Channel delivery failed.",
      },
    };
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      routeId: target.routeId,
      result: {
        action: "deliver",
        mode: "channel",
        channel: result.channel ?? target.delivery.channel,
        messageId: result.messageId,
        ...(context.eventType ? { eventType: context.eventType } : {}),
        ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
      },
    },
  };
}

export function createTaskFlowWebhookRequestHandler(params: {
  cfg: OpenClawConfig;
  targetsByPath: Map<string, WebhookTarget[]>;
  inFlightLimiter?: WebhookInFlightLimiter;
  idempotencyStore?: WebhookIdempotencyStore;
  scheduleSessionTurn?: ScheduleSessionTurn;
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
  const idempotencyRecords = new Map<string, IdempotencyRecord>();
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

        const parsed = webhookActionSchema.safeParse(parsedBody.value);
        if (!parsed.success) {
          writeJson(res, 400, {
            ok: false,
            code: "invalid_request",
            error: formatZodError(parsed.error),
          });
          return true;
        }

        const result = await executeWebhookAction({
          action: parsed.data,
          target,
          cfg: params.cfg,
        });
        const outcome = describeWebhookOutcome({
          action: parsed.data,
          result,
        });
        writeJson(
          res,
          outcome.statusCode,
          outcome.statusCode < 400
            ? {
                ok: true,
                routeId: target.routeId,
                ...(outcome.code ? { code: outcome.code } : {}),
                result,
              }
            : {
                ok: false,
                routeId: target.routeId,
                code: outcome.code ?? "request_rejected",
                error: outcome.error ?? "request rejected",
                result,
              },
        );
        return true;
      },
    });
  };
}
