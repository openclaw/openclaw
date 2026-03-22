import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, StopReason, TextContent, ToolCall } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { GigaChat, type GigaChatClientConfig } from "gigachat";
import type {
  Chat,
  ChatCompletionChunk,
  FunctionParameters,
  Function as GigaFunction,
  Message,
} from "gigachat/interfaces";

// Extended types for API fields not in library type definitions
interface ExtendedChatCompletionChunk extends ChatCompletionChunk {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}
import https from "node:https";
import { throwIfAborted } from "../infra/outbound/abort.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

export type GigachatAuthMode = "oauth" | "basic";
import {
  buildAssistantMessage as buildStreamAssistantMessage,
  buildStreamErrorAssistantMessage,
  buildUsageWithNoCost,
} from "./stream-message-shared.js";

const log = createSubsystemLogger("gigachat-stream");

export type GigachatStreamOptions = {
  baseUrl: string;
  authMode: GigachatAuthMode;
  insecureTls?: boolean;
  /** OAuth: the credentials key. Basic: "username:password". */
  scope?: string;
};

type HistoricalToolReplayEntry = {
  id?: string;
  toolName: string;
  gigaToolName: string;
  arguments: Record<string, unknown>;
  assistantContent: string;
};

function stripLeakedFunctionCallPrelude(text: string): string {
  return text.replace(/^\s*assistant\s+function\s+call(?:\s*([A-Za-z0-9_.:/-]+))?\s*\{\s*/i, "");
}

function resolveGigachatModelHeaders(model: {
  headers?: unknown;
}): Record<string, string> | undefined {
  if (!model.headers || typeof model.headers !== "object" || Array.isArray(model.headers)) {
    return undefined;
  }
  return model.headers as Record<string, string>;
}

function resolveHistoricalToolResultCallId(message: {
  toolCallId?: unknown;
  toolUseId?: unknown;
}): string | undefined {
  const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId.trim() : undefined;
  if (toolCallId) {
    return toolCallId;
  }
  const toolUseId = typeof message.toolUseId === "string" ? message.toolUseId.trim() : undefined;
  return toolUseId || undefined;
}

// ── Function name sanitization ──────────────────────────────────────────────
// GigaChat requires function names to be alphanumeric + underscore only.

const MAX_FUNCTION_NAME_LENGTH = 64;

export function sanitizeFunctionName(name: string): string {
  // Replace non-alphanumeric (except underscore) with underscore
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
  // Collapse multiple underscores
  sanitized = sanitized.replace(/_+/g, "_");
  // Remove leading/trailing underscores
  sanitized = sanitized.replace(/^_+|_+$/g, "");
  // Truncate to max length
  if (sanitized.length > MAX_FUNCTION_NAME_LENGTH) {
    sanitized = sanitized.slice(0, MAX_FUNCTION_NAME_LENGTH);
  }
  // Ensure not empty
  return sanitized || "func";
}

// ── Reserved tool name mapping ──────────────────────────────────────────────

const RESERVED_NAME_CLIENT_TO_GIGA: Record<string, string> = {
  web_search: "__gpt2giga_user_search_web",
};

const RESERVED_NAME_GIGA_TO_CLIENT: Record<string, string> = Object.fromEntries(
  Object.entries(RESERVED_NAME_CLIENT_TO_GIGA).map(([k, v]) => [v, k]),
);

export function mapToolNameToGigaChat(name: string): string {
  return RESERVED_NAME_CLIENT_TO_GIGA[name] ?? name;
}

export function mapToolNameFromGigaChat(name: string): string {
  return RESERVED_NAME_GIGA_TO_CLIENT[name] ?? name;
}

export function parseGigachatBasicCredentials(credentials: string): {
  user: string;
  password: string;
} {
  const separatorIndex = credentials.indexOf(":");
  if (separatorIndex < 0) {
    return { user: credentials, password: "" };
  }
  return {
    user: credentials.slice(0, separatorIndex),
    password: credentials.slice(separatorIndex + 1),
  };
}

function toGigaChatToolName(name: string): string {
  return sanitizeFunctionName(mapToolNameToGigaChat(name));
}

function rememberToolNameMapping(
  forward: Map<string, string>,
  reverse: Map<string, string>,
  originalName: string,
): string {
  const gigaName = toGigaChatToolName(originalName);
  const existingOriginalName = reverse.get(gigaName);
  forward.set(originalName, gigaName);
  if (!existingOriginalName) {
    reverse.set(gigaName, originalName);
  } else if (existingOriginalName !== originalName) {
    throw new Error(
      `GigaChat tool name collision after sanitization: "${originalName}" and "${existingOriginalName}" both map to "${gigaName}"`,
    );
  }
  return gigaName;
}

// ── Schema cleaning ─────────────────────────────────────────────────────────
// GigaChat doesn't support many JSON Schema features. We track modifications
// to help debug issues with tool definitions.

type SchemaModifications = {
  enumsTruncated: string[];
  nestedObjectsFlattened: string[];
  arrayItemsSimplified: string[];
  constraintsRemoved: string[];
};

const GIGACHAT_UNSUPPORTED_SCHEMA_KEYS = new Set([
  "patternProperties",
  "additionalProperties",
  "$ref",
  "$schema",
  "$id",
  "$defs",
  "definitions",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentEncoding",
  "contentMediaType",
  "format",
  "default",
  "examples",
  "deprecated",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "pattern",
  "uniqueItems",
  "const",
]);

export function cleanSchemaForGigaChat(
  schema: unknown,
  depth = 0,
  path = "",
  modifications?: SchemaModifications,
): unknown {
  if (schema === null || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((s, i) => cleanSchemaForGigaChat(s, depth, `${path}[${i}]`, modifications));
  }

  const schemaObj = schema as Record<string, unknown>;

  // Handle nullable types: type: ["string", "null"] -> type: "string"
  if (Array.isArray(schemaObj.type)) {
    const types = schemaObj.type as string[];
    const nonNullType = types.find((t) => t !== "null") ?? "string";
    const newSchema = { ...schemaObj, type: nonNullType };
    return cleanSchemaForGigaChat(newSchema, depth, path, modifications);
  }

  // At depth > 0, convert type:"object" to type:"string" (gpt2giga behavior)
  if (depth > 0 && schemaObj.type === "object") {
    modifications?.nestedObjectsFlattened.push(path || "root");
    const desc = typeof schemaObj.description === "string" ? schemaObj.description : "";
    return {
      type: "string",
      description: desc ? `${desc} (JSON object)` : "JSON object",
    };
  }

  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schemaObj)) {
    if (GIGACHAT_UNSUPPORTED_SCHEMA_KEYS.has(key)) {
      // Track constraint removals for important keys
      if (["minimum", "maximum", "minLength", "maxLength", "pattern"].includes(key)) {
        modifications?.constraintsRemoved.push(`${path}.${key}`);
      }
      continue;
    }
    if (key === "type" && Array.isArray(value)) {
      const types = value as string[];
      cleaned[key] = types.find((t) => t !== "null") ?? "string";
      continue;
    }
    if (key === "required" && Array.isArray(value) && value.length === 0) {
      continue;
    }
    if (key === "enum" && Array.isArray(value) && value.length > 20) {
      modifications?.enumsTruncated.push(`${path} (${value.length} → 20)`);
      cleaned[key] = value.slice(0, 20);
      continue;
    }
    if (key === "items" && typeof value === "object" && value !== null) {
      modifications?.arrayItemsSimplified.push(path || "root");
      cleaned[key] = { type: "string" };
      continue;
    }
    if (key === "properties" && typeof value === "object" && value !== null) {
      const props = value as Record<string, unknown>;
      const cleanedProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(props)) {
        const propPath = path ? `${path}.${propName}` : propName;
        cleanedProps[propName] = cleanSchemaForGigaChat(
          propSchema,
          depth + 1,
          propPath,
          modifications,
        );
      }
      cleaned[key] = cleanedProps;
      continue;
    }
    cleaned[key] = cleanSchemaForGigaChat(value, depth, path, modifications);
  }

  // Ensure type: "object" has properties
  if (depth === 0 && cleaned.type === "object" && !("properties" in cleaned)) {
    cleaned.properties = {};
  }

  return cleaned;
}

function logSchemaModifications(toolName: string, mods: SchemaModifications): void {
  const parts: string[] = [];
  if (mods.enumsTruncated.length > 0) {
    parts.push(`enums truncated: ${mods.enumsTruncated.join(", ")}`);
  }
  if (mods.nestedObjectsFlattened.length > 0) {
    parts.push(`nested objects → strings: ${mods.nestedObjectsFlattened.join(", ")}`);
  }
  if (mods.arrayItemsSimplified.length > 0) {
    parts.push(`array items → strings: ${mods.arrayItemsSimplified.join(", ")}`);
  }
  if (mods.constraintsRemoved.length > 0) {
    parts.push(`constraints removed: ${mods.constraintsRemoved.join(", ")}`);
  }
  if (parts.length > 0) {
    log.debug(`GigaChat schema cleaning for "${toolName}": ${parts.join("; ")}`);
  }
}

// ── Content sanitization ────────────────────────────────────────────────────

function sanitizeContent(content: string | null | undefined): string {
  if (!content) {
    return "";
  }
  return (
    content
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
  );
}

function extractToolResultTextContent(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content ?? {});
}

function formatToolResultReplayText(toolName: string | undefined, content: unknown): string {
  const replayContent = extractToolResultTextContent(content) || "ok";
  return `[Tool Result: ${toolName?.trim() || "unknown"}]\n${replayContent}`;
}

function tryParseJsonObjectString(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? trimmed : null;
  } catch {
    return null;
  }
}

function resolveSchemaType(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const type = (schema as Record<string, unknown>).type;
  if (typeof type === "string") {
    return type;
  }
  if (Array.isArray(type)) {
    return type.find((value): value is string => typeof value === "string" && value !== "null");
  }
  return undefined;
}

function tryParseJsonValue(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function rehydrateGigaChatArgumentValue(value: unknown, schema: unknown): unknown {
  const schemaType = resolveSchemaType(schema);
  const schemaObj =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : undefined;

  if (schemaType === "object" || (!schemaType && schemaObj?.properties)) {
    let objectValue = value;
    if (typeof objectValue === "string") {
      const parsed = tryParseJsonValue(objectValue);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return value;
      }
      objectValue = parsed;
    }
    if (!objectValue || typeof objectValue !== "object" || Array.isArray(objectValue)) {
      return objectValue;
    }

    const properties =
      schemaObj?.properties &&
      typeof schemaObj.properties === "object" &&
      !Array.isArray(schemaObj.properties)
        ? (schemaObj.properties as Record<string, unknown>)
        : undefined;
    if (!properties) {
      return objectValue;
    }

    const nextObject = { ...(objectValue as Record<string, unknown>) };
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in nextObject) {
        nextObject[key] = rehydrateGigaChatArgumentValue(nextObject[key], propertySchema);
      }
    }
    return nextObject;
  }

  if (schemaType === "array") {
    let arrayValue = value;
    if (typeof arrayValue === "string") {
      const parsed = tryParseJsonValue(arrayValue);
      if (!Array.isArray(parsed)) {
        return value;
      }
      arrayValue = parsed;
    }
    if (!Array.isArray(arrayValue)) {
      return arrayValue;
    }

    const itemSchema = schemaObj?.items;
    if (!itemSchema) {
      return arrayValue;
    }
    return arrayValue.map((item) => rehydrateGigaChatArgumentValue(item, itemSchema));
  }

  return value;
}

function rehydrateGigaChatArguments(
  args: Record<string, unknown>,
  schema: unknown,
): Record<string, unknown> {
  const schemaObj =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : undefined;
  const properties =
    schemaObj?.properties &&
    typeof schemaObj.properties === "object" &&
    !Array.isArray(schemaObj.properties)
      ? (schemaObj.properties as Record<string, unknown>)
      : undefined;
  if (!properties) {
    return args;
  }

  const nextArgs = { ...args };
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (key in nextArgs) {
      nextArgs[key] = rehydrateGigaChatArgumentValue(nextArgs[key], propertySchema);
    }
  }
  return nextArgs;
}

/**
 * Coerce tool result content to a JSON object string (gpt2giga compatibility).
 * GigaChat expects tool results to be JSON objects. If the content is already
 * a valid JSON object, it's returned as-is. Otherwise, it's wrapped in
 * `{"result": "..."}`.
 *
 * This behavior is intentionally consistent with gpt2giga proxy.
 */
export function ensureJsonObjectStr(content: string, toolName?: string): string {
  const parsedOriginal = tryParseJsonObjectString(content);
  if (parsedOriginal) {
    return parsedOriginal;
  }

  const sanitized = sanitizeContent(content);
  const parsedSanitized = sanitized === content ? null : tryParseJsonObjectString(sanitized);
  if (parsedSanitized) {
    return parsedSanitized;
  }

  if (!content.trim().startsWith("{") || !content.trim().endsWith("}")) {
    log.debug(`GigaChat: wrapping non-object tool result for "${toolName ?? "unknown"}"`);
  } else {
    log.debug(`GigaChat: wrapping invalid JSON-like tool result for "${toolName ?? "unknown"}"`);
  }
  return JSON.stringify({ result: sanitized });
}

// ── Error message extraction ─────────────────────────────────────────────────
// GigaChat library exceptions pass `response.data` (an object) to the Error
// constructor, so `.message` ends up as "[object Object]". We dig into
// `.response.data` for the real details.

export function extractGigaChatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Check for Axios/GigaChat errors that carry response data
    const errWithResponse = err as Error & {
      response?: {
        status?: number;
        data?: unknown;
        statusText?: string;
        config?: { baseURL?: string; url?: string };
      };
      config?: { baseURL?: string; url?: string };
    };
    const respData = errWithResponse.response?.data;
    // Build URL suffix for error context (Axios errors have config on err.config,
    // GigaChat library exceptions store AxiosResponse so config is on err.response.config)
    const cfg = errWithResponse.config ?? errWithResponse.response?.config;
    const url = [cfg?.baseURL, cfg?.url]
      .filter(Boolean)
      .join("")
      .replace(/([^:])\/\//g, "$1/");
    const urlSuffix = url ? ` (${url})` : "";

    if (respData && typeof respData === "object") {
      const data = respData as Record<string, unknown>;
      // GigaChat API error shapes: { message: "..." }, { error: { message: "..." } }, { detail: "..." }
      const detail =
        typeof data.message === "string"
          ? data.message
          : typeof data.detail === "string"
            ? data.detail
            : typeof data.error === "object" &&
                data.error !== null &&
                typeof (data.error as Record<string, unknown>).message === "string"
              ? ((data.error as Record<string, unknown>).message as string)
              : typeof data.error === "string"
                ? data.error
                : null;
      if (detail) {
        const status = errWithResponse.response?.status;
        return status ? `GigaChat API ${status}${urlSuffix}: ${detail}` : detail;
      }
      // Fallback: stringify the response data
      try {
        const status = errWithResponse.response?.status;
        const json = JSON.stringify(respData);
        return status ? `GigaChat API ${status}${urlSuffix}: ${json}` : json;
      } catch {
        // circular or unserializable
      }
    }
    // If .message is "[object Object]", try to recover from response status
    if (err.message === "[object Object]") {
      const status = errWithResponse.response?.status;
      const statusText = errWithResponse.response?.statusText;
      if (status) {
        return `GigaChat API error ${status}${urlSuffix}${statusText ? `: ${statusText}` : ""}`;
      }
      return `${err.name || "Error"} (no details available)`;
    }
    return err.message;
  }
  if (typeof err === "object" && err !== null) {
    const errObj = err as Record<string, unknown>;
    if (typeof errObj.message === "string") {
      return errObj.message;
    }
    if (typeof errObj.error === "string") {
      return errObj.error;
    }
    if (typeof errObj.detail === "string") {
      return errObj.detail;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

// ── Retry helper ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

function raceWithAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      const err = new Error("Operation aborted");
      err.name = "AbortError";
      reject(err);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function sleepWithAbortSignal(ms: number, signal?: AbortSignal): Promise<void> {
  await raceWithAbortSignal(
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
    signal,
  );
}

async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries = MAX_RETRIES,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      throwIfAborted(signal);
      // The GigaChat SDK does not accept an AbortSignal for token refresh, so
      // we race the refresh promise against the turn abort to stop waiting.
      return await raceWithAbortSignal(operation(), signal);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(extractGigaChatErrorMessage(err));
      if (lastError.name === "AbortError") {
        throw lastError;
      }
      if (attempt < maxRetries) {
        const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        log.warn(
          `GigaChat ${operationName} failed (attempt ${attempt}/${maxRetries}): ${extractGigaChatErrorMessage(lastError)}. ` +
            `Retrying in ${backoffMs}ms...`,
        );
        await sleepWithAbortSignal(backoffMs, signal);
      }
    }
  }
  throw lastError;
}

type GigachatAccessToken = {
  access_token?: string;
};

type GigachatTransportResponse = {
  status: number;
  data: AsyncIterable<string | Uint8Array> | string | { pipe?: unknown };
};

type GigachatRuntimeClient = GigaChat & {
  _client: {
    request: (config: {
      method: "POST";
      url: string;
      data: Chat & { stream: true };
      responseType: "stream";
      headers: Record<string, string>;
      signal?: AbortSignal;
    }) => Promise<GigachatTransportResponse>;
  };
  _accessToken?: GigachatAccessToken;
  updateToken: () => Promise<void>;
  resetToken?: () => void;
};

function getGigachatAccessToken(client: GigachatRuntimeClient): string | undefined {
  return client._accessToken?.access_token?.trim() || undefined;
}

async function ensureGigachatAccessToken(
  client: GigachatRuntimeClient,
  signal?: AbortSignal,
): Promise<string> {
  const accessToken = getGigachatAccessToken(client);
  if (accessToken) {
    return accessToken;
  }

  await withRetry(() => client.updateToken(), "token refresh", MAX_RETRIES, signal);

  const refreshedToken = getGigachatAccessToken(client);
  if (!refreshedToken) {
    throw new Error("GigaChat: failed to obtain access token after retries");
  }
  return refreshedToken;
}

function resetGigachatAccessToken(client: GigachatRuntimeClient): void {
  if (typeof client.resetToken === "function") {
    client.resetToken();
    return;
  }
  delete client._accessToken;
}

async function readGigachatErrorText(
  responseData: GigachatTransportResponse["data"],
  status: number,
): Promise<string> {
  try {
    if (typeof responseData === "string") {
      return responseData;
    }
    if (responseData && typeof responseData === "object" && "pipe" in responseData) {
      const chunks: Buffer[] = [];
      for await (const chunk of responseData as AsyncIterable<string | Uint8Array>) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString();
    }
  } catch {
    return `status ${status}`;
  }

  return "unknown error";
}

// ── Stream function ─────────────────────────────────────────────────────────

export function createGigachatStreamFn(opts: GigachatStreamOptions): StreamFn {
  const configuredBaseUrl = opts.baseUrl.trim();
  const envBaseUrl = process.env.GIGACHAT_BASE_URL?.trim();
  const effectiveBaseUrl =
    configuredBaseUrl || envBaseUrl || "https://gigachat.devices.sberbank.ru/api/v1";

  const envVerifySsl = process.env.GIGACHAT_VERIFY_SSL_CERTS?.trim().toLowerCase();
  const insecureTls = opts.insecureTls ?? (envVerifySsl === "false" || envVerifySsl === "0");

  // Security warning for insecure TLS
  if (insecureTls) {
    log.warn(
      "⚠️  SECURITY WARNING: TLS certificate verification is DISABLED for GigaChat. " +
        "This makes the connection vulnerable to man-in-the-middle attacks. " +
        "Only use this in controlled environments with trusted networks.",
    );
  }

  let cachedClient: GigachatRuntimeClient | null = null;
  let cachedApiKey: string | null = null;

  const buildClientConfig = (apiKey: string): GigaChatClientConfig => {
    const clientConfig: GigaChatClientConfig = {
      baseUrl: effectiveBaseUrl,
      // Explicitly set to undefined to prevent the library from adding profanity_check
      profanityCheck: undefined,
      timeout: 120,
    };
    const configuredScope = opts.scope?.trim();

    if (insecureTls) {
      clientConfig.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }

    if (opts.authMode === "basic") {
      const { user, password } = parseGigachatBasicCredentials(apiKey);
      clientConfig.user = user;
      clientConfig.password = password;
      if (configuredScope) {
        clientConfig.scope = configuredScope;
      }
      log.debug(
        `GigaChat auth: basic mode${clientConfig.scope ? ` scope=${clientConfig.scope}` : ""}`,
      );
    } else {
      clientConfig.credentials = apiKey;
      if (configuredScope) {
        clientConfig.scope = configuredScope;
      }
      log.debug(
        `GigaChat auth: oauth${clientConfig.scope ? ` scope=${clientConfig.scope}` : " (sdk default scope)"}`,
      );
    }

    return clientConfig;
  };

  const getClientForApiKey = (apiKey: string): GigachatRuntimeClient => {
    if (cachedClient && cachedApiKey === apiKey) {
      return cachedClient;
    }

    cachedClient = new GigaChat(buildClientConfig(apiKey)) as GigachatRuntimeClient;
    cachedApiKey = apiKey;
    return cachedClient;
  };

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      log.debug(
        `GigaChat stream: model=${model.id} baseUrl=${effectiveBaseUrl} authMode=${opts.authMode}`,
      );

      try {
        const disableFunctions = process.env.GIGACHAT_DISABLE_FUNCTIONS?.trim().toLowerCase();
        const functionsEnabled = disableFunctions !== "1" && disableFunctions !== "true";
        const toolNameToGiga = new Map<string, string>();
        const gigaToToolName = new Map<string, string>();
        const gigaToolSchemas = new Map<string, unknown>();
        const pendingHistoricalToolCalls: HistoricalToolReplayEntry[] = [];

        // Build messages for GigaChat format
        const messages: Message[] = [];

        const pushHistoricalToolCall = (toolCall: HistoricalToolReplayEntry) => {
          messages.push({
            role: "assistant",
            content: toolCall.assistantContent,
            function_call: {
              name: toolCall.gigaToolName,
              arguments: toolCall.arguments,
            },
          });
        };

        const takePendingHistoricalToolCall = (params: {
          toolCallId?: string;
          toolName?: string;
        }): HistoricalToolReplayEntry | undefined => {
          if (pendingHistoricalToolCalls.length === 0) {
            return undefined;
          }

          let matchIndex = -1;
          if (params.toolCallId) {
            matchIndex = pendingHistoricalToolCalls.findIndex(
              (toolCall) => toolCall.id === params.toolCallId,
            );
          }
          if (matchIndex < 0 && params.toolName) {
            matchIndex = pendingHistoricalToolCalls.findIndex(
              (toolCall) => toolCall.toolName === params.toolName,
            );
          }
          if (matchIndex < 0) {
            matchIndex = 0;
          }
          const [toolCall] = pendingHistoricalToolCalls.splice(matchIndex, 1);
          return toolCall;
        };

        const flushPendingHistoricalToolCall = (params: {
          toolCallId?: string;
          toolName?: string;
        }): HistoricalToolReplayEntry | undefined => {
          const toolCall = takePendingHistoricalToolCall(params);
          if (toolCall) {
            pushHistoricalToolCall(toolCall);
          }
          return toolCall;
        };

        const flushPendingHistoricalToolCalls = () => {
          while (pendingHistoricalToolCalls.length > 0) {
            const nextToolCall = pendingHistoricalToolCalls.shift();
            if (nextToolCall) {
              pushHistoricalToolCall(nextToolCall);
            }
          }
        };

        if (context.systemPrompt) {
          messages.push({ role: "system", content: sanitizeContent(context.systemPrompt) });
        }

        for (const msg of context.messages ?? []) {
          if (pendingHistoricalToolCalls.length > 0 && msg.role !== "toolResult") {
            flushPendingHistoricalToolCalls();
          }

          if (msg.role === "user") {
            const content = msg.content;
            if (typeof content === "string") {
              messages.push({ role: "user", content: sanitizeContent(content) });
            } else if (Array.isArray(content)) {
              const textParts = content
                .filter((c): c is TextContent => c.type === "text")
                .map((c) => c.text);
              if (textParts.length > 0) {
                messages.push({ role: "user", content: sanitizeContent(textParts.join("\n")) });
              }
            }
          } else if (msg.role === "assistant") {
            const contentParts = msg.content ?? [];
            const text = contentParts
              .filter((c): c is TextContent => c.type === "text")
              .map((c) => c.text)
              .join("");
            const toolCalls = contentParts.filter((c): c is ToolCall => c.type === "toolCall");

            if (toolCalls.length > 0 && functionsEnabled) {
              for (const [index, toolCall] of toolCalls.entries()) {
                if (!toolCall.name) {
                  continue;
                }
                const gigaToolName = rememberToolNameMapping(
                  toolNameToGiga,
                  gigaToToolName,
                  toolCall.name,
                );
                pendingHistoricalToolCalls.push({
                  id: toolCall.id,
                  toolName: toolCall.name,
                  gigaToolName,
                  arguments: toolCall.arguments ?? {},
                  assistantContent: index === 0 && text ? sanitizeContent(text) : "",
                });
              }
            } else if (toolCalls.length > 0 && !functionsEnabled) {
              const downgradedToolCalls = toolCalls
                .map((toolCall) => `[Called ${toolCall.name}]`)
                .join(" ");
              messages.push({
                role: "assistant",
                content: sanitizeContent(
                  text ? `${text}\n\n${downgradedToolCalls}` : downgradedToolCalls,
                ),
              });
            } else if (text) {
              messages.push({ role: "assistant", content: sanitizeContent(text) });
            }
          } else if (msg.role === "toolResult") {
            const toolName = msg.toolName ?? "unknown";
            if (functionsEnabled) {
              const resultContent = extractToolResultTextContent(msg.content);
              const coercedContent = ensureJsonObjectStr(resultContent || "ok", toolName);
              const historicalToolCall = flushPendingHistoricalToolCall({
                toolCallId: resolveHistoricalToolResultCallId(msg),
                toolName,
              });
              const gigaToolName =
                historicalToolCall?.gigaToolName ??
                rememberToolNameMapping(toolNameToGiga, gigaToToolName, toolName);
              messages.push({
                role: "function",
                content: coercedContent,
                name: gigaToolName,
              });
            } else {
              messages.push({
                role: "user",
                content: sanitizeContent(formatToolResultReplayText(toolName, msg.content)),
              });
            }
          }
        }
        flushPendingHistoricalToolCalls();

        // Build functions with schema cleaning and name sanitization
        const functions: GigaFunction[] = [];
        if (functionsEnabled) {
          for (const tool of context.tools ?? []) {
            if (!tool.parameters) {
              log.debug(`GigaChat: skipping tool "${tool.name}" (no parameters)`);
              continue;
            }
            // Track schema modifications for debugging
            const modifications: SchemaModifications = {
              enumsTruncated: [],
              nestedObjectsFlattened: [],
              arrayItemsSimplified: [],
              constraintsRemoved: [],
            };
            const cleanedParams = cleanSchemaForGigaChat(
              tool.parameters,
              0,
              "",
              modifications,
            ) as FunctionParameters;
            logSchemaModifications(tool.name, modifications);

            // Sanitize function name and map reserved names
            const sanitizedName = rememberToolNameMapping(
              toolNameToGiga,
              gigaToToolName,
              tool.name,
            );
            if (sanitizedName !== tool.name) {
              log.debug(`GigaChat: sanitized function name "${tool.name}" → "${sanitizedName}"`);
            }
            gigaToolSchemas.set(sanitizedName, tool.parameters);

            functions.push({
              name: sanitizedName,
              description: tool.description ?? "",
              parameters: cleanedParams,
            });
          }
        }

        // Build auth config
        const apiKey = options?.apiKey ?? "";
        const client = getClientForApiKey(apiKey);

        // Build chat request - explicitly omit profanity_check
        const chatRequest: Chat = {
          model: model.id,
          messages,
        };

        if (functions.length > 0 && functionsEnabled) {
          chatRequest.functions = functions;
          chatRequest.function_call = "auto";
        }
        if (typeof options?.maxTokens === "number") {
          chatRequest.max_tokens = options.maxTokens;
        }
        if (typeof options?.temperature === "number" && options.temperature > 0) {
          chatRequest.temperature = options.temperature;
        } else {
          chatRequest.top_p = 0;
        }
        const outboundPayload = { ...chatRequest, stream: true };
        const requestPayload = (options?.onPayload?.(outboundPayload, model) ??
          outboundPayload) as Chat & { stream: true };

        log.debug(`GigaChat request: ${messages.length} messages, ${functions.length} functions`);

        const requestId = randomUUID();
        log.debug(`GigaChat request ${requestId}: starting`);

        const axiosClient = client._client;
        const sendChatCompletionsRequest = async (): Promise<GigachatTransportResponse> => {
          const accessToken = await ensureGigachatAccessToken(client, options?.signal);
          return axiosClient.request({
            method: "POST",
            url: "/chat/completions",
            data: requestPayload,
            responseType: "stream",
            headers: {
              ...resolveGigachatModelHeaders(model),
              ...options?.headers,
              Authorization: `Bearer ${accessToken}`,
              Accept: "text/event-stream",
              "Cache-Control": "no-store",
              "X-Request-ID": requestId,
            },
            signal: options?.signal,
          });
        };

        let response = await sendChatCompletionsRequest();
        if (response.status === 401) {
          log.warn(
            `GigaChat request ${requestId}: received 401 from chat endpoint, refreshing token and retrying`,
          );
          resetGigachatAccessToken(client);
          await ensureGigachatAccessToken(client, options?.signal);
          response = await sendChatCompletionsRequest();
        }

        if (response.status !== 200) {
          const errorText = await readGigachatErrorText(response.data, response.status);
          throw new Error(
            `GigaChat API error ${response.status} (${effectiveBaseUrl}/chat/completions): ${errorText}`,
          );
        }

        let accumulatedContent = "";
        const accumulatedToolCalls: ToolCall[] = [];
        const resolvedFunctionCalls: Array<{ name: string; arguments: string }> = [];
        let functionCallBuffer: { name: string; arguments: string } | null = null;
        let promptTokens = 0;
        let completionTokens = 0;

        // Assemble streamed JSON payloads across split UTF-8 chunks and across
        // multi-line `data:` frames, while still tolerating the line-oriented
        // mock streams used throughout our tests.
        let sseBuffer = "";
        const sseDecoder = new TextDecoder();
        const pendingSseDataLines: string[] = [];
        const flushFunctionCallBuffer = () => {
          if (!functionCallBuffer?.name) {
            functionCallBuffer = null;
            return;
          }
          resolvedFunctionCalls.push(functionCallBuffer);
          functionCallBuffer = null;
        };
        const consumeParsedSseChunk = (parsed: ExtendedChatCompletionChunk) => {
          const choice = parsed.choices?.[0];

          if (choice?.delta?.content) {
            accumulatedContent += choice.delta.content;
          }
          if (choice?.delta?.function_call) {
            if (choice.delta.function_call.name && functionCallBuffer?.arguments) {
              // A new tool name after arguments indicates the previous streamed
              // function call is complete and a new call has begun.
              flushFunctionCallBuffer();
            }
            if (!functionCallBuffer) {
              functionCallBuffer = { name: "", arguments: "" };
            }
            if (choice.delta.function_call.name) {
              functionCallBuffer.name += choice.delta.function_call.name;
            }
            if (choice.delta.function_call.arguments) {
              const args = choice.delta.function_call.arguments;
              functionCallBuffer.arguments +=
                typeof args === "string" ? args : JSON.stringify(args);
            }
          }
          if (choice?.finish_reason === "function_call") {
            flushFunctionCallBuffer();
          }
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens ?? 0;
            completionTokens = parsed.usage.completion_tokens ?? 0;
          }
        };
        const flushPendingSseEvent = (force: boolean) => {
          if (pendingSseDataLines.length === 0) {
            return;
          }
          const payload = pendingSseDataLines.join("\n");
          if (payload.trim() === "[DONE]") {
            pendingSseDataLines.length = 0;
            return;
          }
          try {
            consumeParsedSseChunk(JSON.parse(payload) as ExtendedChatCompletionChunk);
            pendingSseDataLines.length = 0;
          } catch (e) {
            if (force) {
              log.warn(`Failed to parse SSE chunk: ${String(e)}`);
              pendingSseDataLines.length = 0;
            }
          }
        };
        const consumeSseLine = (rawLine: string) => {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (line.trim().length === 0) {
            flushPendingSseEvent(true);
            return;
          }
          if (line.startsWith(":") || !line.startsWith("data:")) {
            return;
          }
          let payload = line.slice(5);
          if (payload.startsWith(" ")) {
            payload = payload.slice(1);
          }
          pendingSseDataLines.push(payload);
          flushPendingSseEvent(false);
        };
        for await (const chunk of response.data as AsyncIterable<string | Uint8Array>) {
          if (typeof chunk === "string") {
            sseBuffer += sseDecoder.decode();
            sseBuffer += chunk;
          } else {
            sseBuffer += sseDecoder.decode(chunk, { stream: true });
          }
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() ?? "";

          for (const line of lines) {
            consumeSseLine(line);
          }
        }
        sseBuffer += sseDecoder.decode();
        if (sseBuffer.length > 0) {
          consumeSseLine(sseBuffer);
        }
        flushPendingSseEvent(true);

        flushFunctionCallBuffer();
        if (resolvedFunctionCalls.length > 0) {
          accumulatedContent = stripLeakedFunctionCallPrelude(accumulatedContent);
          for (const resolvedFunctionCall of resolvedFunctionCalls) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              if (resolvedFunctionCall.arguments) {
                parsedArgs = JSON.parse(resolvedFunctionCall.arguments) as Record<string, unknown>;
              }
            } catch (parseErr) {
              const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
              log.error(
                `GigaChat: failed to parse function arguments for "${resolvedFunctionCall.name}": ${errMsg}. ` +
                  `Raw arguments: ${resolvedFunctionCall.arguments.slice(0, 500)}`,
              );
              // Return error instead of continuing with empty args
              throw new Error(
                `Failed to parse function call arguments for "${resolvedFunctionCall.name}": ${errMsg}`,
                { cause: parseErr },
              );
            }
            const clientName =
              gigaToToolName.get(resolvedFunctionCall.name) ??
              mapToolNameFromGigaChat(resolvedFunctionCall.name);
            parsedArgs = rehydrateGigaChatArguments(
              parsedArgs,
              gigaToolSchemas.get(resolvedFunctionCall.name),
            );
            accumulatedToolCalls.push({
              type: "toolCall",
              id: randomUUID(),
              name: clientName,
              arguments: parsedArgs,
            });
          }
        }

        const content: AssistantMessage["content"] = [];
        if (accumulatedContent) {
          content.push({ type: "text", text: accumulatedContent });
        }
        for (const tc of accumulatedToolCalls) {
          content.push(tc);
        }

        const stopReason: StopReason = accumulatedToolCalls.length > 0 ? "toolUse" : "stop";

        // Warn if usage info is missing (common in streaming mode)
        if (promptTokens === 0 && completionTokens === 0) {
          log.debug(
            `GigaChat request ${requestId}: no usage information returned (streaming mode may not include token counts)`,
          );
        }

        const assistantMessage = buildStreamAssistantMessage({
          model: { api: model.api, provider: model.provider, id: model.id },
          content,
          stopReason,
          usage: buildUsageWithNoCost({
            input: promptTokens,
            output: completionTokens,
            totalTokens: promptTokens + completionTokens,
          }),
        });

        stream.push({
          type: "done",
          reason: stopReason === "toolUse" ? "toolUse" : "stop",
          message: assistantMessage,
        });
      } catch (err) {
        const errorMessage = extractGigaChatErrorMessage(err);
        log.error(`GigaChat error: ${errorMessage}`);
        stream.push({
          type: "error",
          reason: "error",
          error: buildStreamErrorAssistantMessage({
            model,
            errorMessage,
          }),
        });
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
