import type { IncomingMessage } from "node:http";
import { truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import { z } from "zod";
import { extensionSupportRequired, versionNotSupported } from "./a2a-errors.js";
import {
  A2A_EXTENSIONS_HEADER,
  A2A_VERSION_HEADER,
  isSupportedA2aVersion,
  normalizeA2aVersion,
  parseServiceParameterHeader,
} from "./a2a-model.js";
import type { A2aChannelConfig } from "./types.js";

const A2A_CONTEXT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const A2A_MESSAGE_MAX_BYTES = 64 * 1024;
const A2A_TRUNCATION_MARKER = `\n[message truncated at ${A2A_MESSAGE_MAX_BYTES} bytes]`;

export type { A2aMessage, A2aPart, A2aTask, A2aTaskState } from "./a2a-model.js";
export {
  A2A_JSON_RPC_ERROR_CODES,
  A2aProtocolError,
  contentTypeNotSupported,
  extendedCardNotConfigured,
  invalidParams,
  methodNotFound,
  pushNotificationsUnsupported,
  taskNotCancelable,
  taskNotFound,
  unsupportedOperation,
  versionNotSupported,
  type A2aErrorReason,
} from "./a2a-errors.js";

export const A2aRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().finite(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const A2aMetadataSchema = z.record(z.string(), z.unknown());

/**
 * A2A 1.0 `Part` (spec §4.4). Exactly one of `text` / `raw` / `url` / `data`
 * carries the payload; the member name is the discriminator, so 1.0 has no
 * `kind` field. `raw` is base64 inline file content, `url` a file reference.
 */
export const A2aPartSchema = z
  .object({
    text: z.string().optional(),
    raw: z.string().optional(),
    url: z.string().optional(),
    data: z.unknown().optional(),
    metadata: A2aMetadataSchema.optional(),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
  })
  .refine(
    (part) =>
      part.text !== undefined ||
      part.raw !== undefined ||
      part.url !== undefined ||
      part.data !== undefined,
    { message: "part must contain one of text, raw, url, or data" },
  );

const A2aMessageSchema = z.object({
  messageId: z.string().min(1).optional(),
  contextId: z.string().regex(A2A_CONTEXT_PATTERN).optional(),
  taskId: z.string().min(1).optional(),
  role: z.enum(["ROLE_USER", "ROLE_AGENT", "user", "agent"]),
  parts: z.array(z.unknown()),
  metadata: A2aMetadataSchema.optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(z.string()).optional(),
});

const A2aPushNotificationAuthenticationSchema = z.object({
  scheme: z.string().min(1),
  credentials: z.string().optional(),
});

/** `TaskPushNotificationConfig`; `id` is assigned by the server when omitted. */
export const A2aPushNotificationConfigSchema = z.object({
  tenant: z.string().optional(),
  id: z.string().min(1).optional(),
  taskId: z.string().min(1),
  url: z
    .string()
    .url()
    .regex(/^https?:\/\//, "A2A push notification URLs must use HTTP or HTTPS"),
  token: z.string().optional(),
  authentication: A2aPushNotificationAuthenticationSchema.optional(),
});

export const A2aSendMessageParamsSchema = z.object({
  message: A2aMessageSchema,
  configuration: z
    .object({
      acceptedOutputModes: z.array(z.string()).optional(),
      historyLength: z.number().int().nonnegative().optional(),
      returnImmediately: z.boolean().optional(),
      taskPushNotificationConfig: A2aPushNotificationConfigSchema.partial({
        taskId: true,
      }).optional(),
    })
    .optional(),
  tenant: z.string().optional(),
  metadata: A2aMetadataSchema.optional(),
});

export const A2aTaskRequestParamsSchema = z.object({
  id: z.string().min(1),
  historyLength: z.number().int().nonnegative().optional(),
  tenant: z.string().optional(),
});

export const A2aSubscribeToTaskParamsSchema = z.object({
  id: z.string().min(1),
  tenant: z.string().optional(),
});

const A2aTaskStateSchema = z.enum([
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
]);

export const A2aListTasksParamsSchema = z.object({
  tenant: z.string().optional(),
  contextId: z.string().optional(),
  status: A2aTaskStateSchema.optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  historyLength: z.number().int().nonnegative().optional(),
  statusTimestampAfter: z.string().optional(),
  includeArtifacts: z.boolean().optional(),
});

export const A2aCancelTaskParamsSchema = z.object({
  tenant: z.string().optional(),
  id: z.string().min(1),
  metadata: A2aMetadataSchema.optional(),
});

export const A2aGetTaskPushNotificationConfigParamsSchema = z.object({
  tenant: z.string().optional(),
  taskId: z.string().min(1),
  id: z.string().min(1),
});

export const A2aListTaskPushNotificationConfigsParamsSchema = z.object({
  tenant: z.string().optional(),
  taskId: z.string().min(1),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});

export const A2aDeleteTaskPushNotificationConfigParamsSchema =
  A2aGetTaskPushNotificationConfigParamsSchema;

export type A2aCanonicalMethod =
  | "SendMessage"
  | "SendStreamingMessage"
  | "GetTask"
  | "ListTasks"
  | "CancelTask"
  | "SubscribeToTask"
  | "CreateTaskPushNotificationConfig"
  | "GetTaskPushNotificationConfig"
  | "ListTaskPushNotificationConfigs"
  | "DeleteTaskPushNotificationConfig"
  | "GetExtendedAgentCard";

/** Agent Card capabilities that gate a method (spec §3.3.4). */
export type A2aCapabilityKey = "streaming" | "pushNotifications" | "extendedAgentCard";

export type A2aResolvedMethod = {
  method: A2aCanonicalMethod;
  /** Capability that must be enabled for this method to be served. */
  capability?: A2aCapabilityKey;
  /** Methods delivered as a Server-Sent Events stream instead of one response. */
  streaming?: boolean;
};

const A2A_CANONICAL_METHODS: Readonly<Record<string, A2aResolvedMethod>> = {
  SendMessage: { method: "SendMessage" },
  SendStreamingMessage: {
    method: "SendStreamingMessage",
    capability: "streaming",
    streaming: true,
  },
  GetTask: { method: "GetTask" },
  ListTasks: { method: "ListTasks" },
  CancelTask: { method: "CancelTask" },
  SubscribeToTask: { method: "SubscribeToTask", capability: "streaming", streaming: true },
  CreateTaskPushNotificationConfig: {
    method: "CreateTaskPushNotificationConfig",
    capability: "pushNotifications",
  },
  GetTaskPushNotificationConfig: {
    method: "GetTaskPushNotificationConfig",
    capability: "pushNotifications",
  },
  ListTaskPushNotificationConfigs: {
    method: "ListTaskPushNotificationConfigs",
    capability: "pushNotifications",
  },
  DeleteTaskPushNotificationConfig: {
    method: "DeleteTaskPushNotificationConfig",
    capability: "pushNotifications",
  },
  GetExtendedAgentCard: { method: "GetExtendedAgentCard", capability: "extendedAgentCard" },
};

// Hermes-generation A2A 0.3 peers use dotted or legacy-suffixed RPC names. Only
// these explicitly mapped interoperability aliases are accepted so an unexpected
// method still surfaces as -32601 rather than silently doing the wrong thing.
const A2A_METHOD_ALIASES: Readonly<Record<string, A2aCanonicalMethod>> = {
  "message/send": "SendMessage",
  "message/stream": "SendStreamingMessage",
  "tasks/get": "GetTask",
  "tasks/list": "ListTasks",
  "tasks/cancel": "CancelTask",
  "tasks/resubscribe": "SubscribeToTask",
  // 0.2-era name still sent by some clients; resolving it alongside
  // `tasks/resubscribe` costs nothing and keeps both generations working.
  "tasks/subscribe": "SubscribeToTask",
  "tasks/pushNotificationConfig/set": "CreateTaskPushNotificationConfig",
  SetTaskPushNotificationConfig: "CreateTaskPushNotificationConfig",
  "tasks/pushNotificationConfig/get": "GetTaskPushNotificationConfig",
  "tasks/pushNotificationConfig/list": "ListTaskPushNotificationConfigs",
  ListTaskPushNotificationConfig: "ListTaskPushNotificationConfigs",
  "tasks/pushNotificationConfig/delete": "DeleteTaskPushNotificationConfig",
  "agent/getAuthenticatedExtendedCard": "GetExtendedAgentCard",
};

export function resolveA2aRpcMethod(method: string): A2aResolvedMethod | undefined {
  if (Object.hasOwn(A2A_CANONICAL_METHODS, method)) {
    return A2A_CANONICAL_METHODS[method];
  }
  const alias = Object.hasOwn(A2A_METHOD_ALIASES, method) ? A2A_METHOD_ALIASES[method] : undefined;
  return alias === undefined ? undefined : A2A_CANONICAL_METHODS[alias];
}

export function isA2aStreamingMethod(method: string): boolean {
  return resolveA2aRpcMethod(method)?.streaming === true;
}

const A2aInboundPartSchema = z.object({
  text: z.string().optional(),
  data: z.unknown().optional(),
});

/**
 * Flatten a message's parts into the text handed to the agent.
 *
 * Only text and structured data become prompt content: inline `raw` bytes and
 * `url` file references have no textual form, so a file-only message is rejected
 * downstream rather than silently turned into an empty prompt.
 */
export function extractA2aMessageText(parts: unknown[]): string | undefined {
  const textParts: string[] = [];
  for (const candidate of parts) {
    const parsed = A2aInboundPartSchema.safeParse(candidate);
    if (!parsed.success) {
      continue;
    }
    if (parsed.data.text !== undefined) {
      textParts.push(parsed.data.text);
    } else if (Object.hasOwn(parsed.data, "data") && parsed.data.data !== undefined) {
      textParts.push(JSON.stringify(parsed.data.data));
    }
  }

  const text = textParts.join("\n");
  if (!text.trim()) {
    return undefined;
  }
  if (Buffer.byteLength(text) <= A2A_MESSAGE_MAX_BYTES) {
    return text;
  }

  const prefixBytes = A2A_MESSAGE_MAX_BYTES - Buffer.byteLength(A2A_TRUNCATION_MARKER);
  // Preserve TextDecoder's leading-BOM removal for truncated messages.
  return truncateUtf8Prefix(text, prefixBytes).replace(/^\uFEFF/, "") + A2A_TRUNCATION_MARKER;
}

/** Describe non-text parts so the agent still learns what it was handed. */
export function describeA2aMessageParts(parts: unknown[]): string[] {
  const described: string[] = [];
  for (const candidate of parts) {
    const parsed = A2aPartSchema.safeParse(candidate);
    if (!parsed.success) {
      continue;
    }
    const part = parsed.data;
    if (part.text !== undefined) {
      continue;
    }
    if (part.url !== undefined) {
      described.push(`[file: ${part.filename ?? part.url}]`);
    } else if (part.raw !== undefined) {
      described.push(`[file: ${part.filename ?? "inline"}]`);
    }
  }
  return described;
}

/** Strip parameters (`;charset=...`) and case, the way media types compare. */
function normalizeMediaType(value: string): string {
  return value.split(";")[0]!.trim().toLowerCase();
}

/**
 * Find the first file part whose media type the agent does not accept (§3.1.1).
 *
 * `text` and `data` parts carry no media type — one is inherently textual, the
 * other is structured JSON — so only `raw` and `url` parts are checked against
 * the card's advertised `inputModes`. Operator modes may use a subtype
 * wildcard ("type" followed by slash-star) or a catch-all star-star.
 */
export function findUnsupportedA2aPartMediaType(
  parts: unknown[],
  inputModes: readonly string[],
): string | undefined {
  const accepted = new Set(inputModes.map(normalizeMediaType));
  if (accepted.size === 0) {
    return undefined;
  }
  for (const candidate of parts) {
    const parsed = A2aPartSchema.safeParse(candidate);
    if (!parsed.success || !parsed.data.mediaType) {
      continue;
    }
    const mediaType = normalizeMediaType(parsed.data.mediaType);
    const [type] = mediaType.split("/");
    if (accepted.has(mediaType) || accepted.has(`${type}/*`) || accepted.has("*/*")) {
      continue;
    }
    return parsed.data.mediaType;
  }
  return undefined;
}

export function assertSupportedVersion(request: IncomingMessage): void {
  const version = normalizeA2aVersion(
    Array.isArray(request.headers[A2A_VERSION_HEADER])
      ? request.headers[A2A_VERSION_HEADER]?.[0]
      : request.headers[A2A_VERSION_HEADER],
  );
  if (isSupportedA2aVersion(version)) {
    return;
  }
  throw versionNotSupported(`A2A version ${version} is not supported; this agent serves 1.0`);
}

/** Echo the extensions the agent actually activated for this request. */
export function activatedExtensions(
  request: IncomingMessage,
  a2aConfig: A2aChannelConfig,
): string[] {
  const requested = parseServiceParameterHeader(request.headers[A2A_EXTENSIONS_HEADER]);
  if (requested.length === 0) {
    return [];
  }
  const declared = new Set((a2aConfig.extensions ?? []).map((entry) => entry.uri));
  return requested.filter((uri) => declared.has(uri));
}

/**
 * Refuse requests that skip an extension the card marks `required` (§4.6).
 *
 * A required extension changes how the agent interprets the request, so serving
 * the call anyway would answer a different question than the peer asked. The
 * opt-in is per request, so the check has to run on every call rather than once
 * at startup.
 */
export function assertRequiredExtensions(
  request: IncomingMessage,
  a2aConfig: A2aChannelConfig,
): void {
  const activated = new Set(activatedExtensions(request, a2aConfig));
  const missing = (a2aConfig.extensions ?? [])
    .filter((entry) => entry.required === true && !activated.has(entry.uri))
    .map((entry) => entry.uri);
  if (missing.length > 0) {
    throw extensionSupportRequired(missing);
  }
}
