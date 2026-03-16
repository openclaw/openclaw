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
  forward.set(originalName, gigaName);
  if (!reverse.has(gigaName)) {
    reverse.set(gigaName, originalName);
  } else if (reverse.get(gigaName) !== originalName) {
    log.warn(
      `GigaChat: tool name collision after sanitization: "${originalName}" and "${reverse.get(gigaName)}" both map to "${gigaName}"`,
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
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\u00A0/g, " ")
      .replace(/\u2026/g, "...")
  );
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
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // Invalid JSON that looks like an object - wrap it
      log.debug(`GigaChat: wrapping invalid JSON-like tool result for "${toolName ?? "unknown"}"`);
    }
  } else {
    log.debug(`GigaChat: wrapping non-object tool result for "${toolName ?? "unknown"}"`);
  }
  return JSON.stringify({ result: content });
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

async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries = MAX_RETRIES,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(extractGigaChatErrorMessage(err));
      if (attempt < maxRetries) {
        const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        log.warn(
          `GigaChat ${operationName} failed (attempt ${attempt}/${maxRetries}): ${extractGigaChatErrorMessage(lastError)}. ` +
            `Retrying in ${backoffMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw lastError;
}

// ── Stream function ─────────────────────────────────────────────────────────

export function createGigachatStreamFn(opts: GigachatStreamOptions): StreamFn {
  const envBaseUrl = process.env.GIGACHAT_BASE_URL?.trim();
  const effectiveBaseUrl =
    envBaseUrl || opts.baseUrl || "https://gigachat.devices.sberbank.ru/api/v1";

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

        // Build messages for GigaChat format
        const messages: Message[] = [];

        if (context.systemPrompt) {
          messages.push({ role: "system", content: sanitizeContent(context.systemPrompt) });
        }

        for (const msg of context.messages ?? []) {
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
            const toolCall = contentParts.find((c): c is ToolCall => c.type === "toolCall");

            if (toolCall && toolCall.name && functionsEnabled) {
              const gigaToolName = rememberToolNameMapping(
                toolNameToGiga,
                gigaToToolName,
                toolCall.name,
              );
              messages.push({
                role: "assistant",
                content: text ? sanitizeContent(text) : "",
                function_call: {
                  name: gigaToolName,
                  arguments: toolCall.arguments ?? {},
                },
              });
            } else if (text) {
              messages.push({ role: "assistant", content: sanitizeContent(text) });
            } else if (toolCall && !functionsEnabled) {
              messages.push({ role: "assistant", content: `[Called ${toolCall.name}]` });
            }
          } else if (msg.role === "toolResult" && functionsEnabled) {
            const toolName = msg.toolName ?? "unknown";
            const msgContent = msg.content;
            const resultContent = Array.isArray(msgContent)
              ? msgContent
                  .filter((c): c is TextContent => c.type === "text")
                  .map((c) => c.text)
                  .join("\n")
              : typeof msgContent === "string"
                ? msgContent
                : JSON.stringify(msgContent ?? {});
            const coercedContent = ensureJsonObjectStr(
              sanitizeContent(resultContent || "ok"),
              toolName,
            );
            const gigaToolName = rememberToolNameMapping(toolNameToGiga, gigaToToolName, toolName);
            messages.push({
              role: "function",
              content: coercedContent,
              name: gigaToolName,
            });
          }
        }

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

            functions.push({
              name: sanitizedName,
              description: tool.description ?? "",
              parameters: cleanedParams,
            });
          }
        }

        // Build auth config
        const apiKey = options?.apiKey ?? "";
        const isUserPassCredentials = apiKey.includes(":");

        const clientConfig: GigaChatClientConfig = {
          baseUrl: effectiveBaseUrl,
          // Explicitly set to undefined to prevent the library from adding profanity_check
          profanityCheck: undefined,
          timeout: 120,
        };

        // Configure TLS
        if (insecureTls) {
          clientConfig.httpsAgent = new https.Agent({ rejectUnauthorized: false });
        }

        // Set credentials based on auth mode
        if (isUserPassCredentials) {
          const { user, password } = parseGigachatBasicCredentials(apiKey);
          clientConfig.user = user;
          clientConfig.password = password;
          log.debug(`GigaChat auth: basic mode`);
        } else {
          clientConfig.credentials = apiKey;
          clientConfig.scope = opts.scope ?? "GIGACHAT_API_PERS";
          log.debug(`GigaChat auth: oauth scope=${clientConfig.scope}`);
        }

        const client = new GigaChat(clientConfig);

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

        log.debug(`GigaChat request: ${messages.length} messages, ${functions.length} functions`);

        // Use the library for auth, but our own SSE parsing (library's parseChunk is buggy)
        // Wrap token refresh in retry logic for transient failures
        await withRetry(() => client.updateToken(), "token refresh");

        const axiosClient = client._client;
        // Access the token (protected property, so we cast)
        const accessToken = (client as unknown as { _accessToken?: { access_token: string } })
          ._accessToken?.access_token;

        if (!accessToken) {
          throw new Error("GigaChat: failed to obtain access token after retries");
        }

        const requestId = randomUUID();
        log.debug(`GigaChat request ${requestId}: starting`);

        const response = await axiosClient.request({
          method: "POST",
          url: "/chat/completions",
          data: { ...chatRequest, stream: true },
          responseType: "stream",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "text/event-stream",
            "Cache-Control": "no-store",
            "X-Request-ID": requestId,
          },
          signal: options?.signal,
        });

        if (response.status !== 200) {
          let errorText = "unknown error";
          try {
            if (typeof response.data === "string") {
              errorText = response.data;
            } else if (response.data && typeof response.data.pipe === "function") {
              // It's a stream, try to read it
              const chunks: Buffer[] = [];
              for await (const chunk of response.data) {
                chunks.push(chunk);
              }
              errorText = Buffer.concat(chunks).toString();
            }
          } catch {
            errorText = `status ${response.status}`;
          }
          throw new Error(
            `GigaChat API error ${response.status} (${effectiveBaseUrl}/chat/completions): ${errorText}`,
          );
        }

        let accumulatedContent = "";
        const accumulatedToolCalls: ToolCall[] = [];
        let functionCallBuffer: { name: string; arguments: string } | null = null;
        let promptTokens = 0;
        let completionTokens = 0;

        // Our own SSE parsing that handles `: ` in JSON correctly
        let sseBuffer = "";
        for await (const chunk of response.data) {
          sseBuffer += chunk.toString();
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) {
              continue;
            }
            if (trimmed === "data: [DONE]") {
              continue;
            }
            if (trimmed.startsWith("data: ")) {
              // Fix: only split on first `: ` occurrence
              const jsonStr = trimmed.slice(6); // Remove "data: " prefix
              try {
                const parsed = JSON.parse(jsonStr) as ExtendedChatCompletionChunk;
                const choice = parsed.choices?.[0];

                if (choice?.delta?.content) {
                  accumulatedContent += choice.delta.content;
                }
                if (choice?.delta?.function_call) {
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
                if (parsed.usage) {
                  promptTokens = parsed.usage.prompt_tokens ?? 0;
                  completionTokens = parsed.usage.completion_tokens ?? 0;
                }
              } catch (e) {
                log.warn(`Failed to parse SSE chunk: ${String(e)}`);
              }
            }
          }
        }

        if (functionCallBuffer && functionCallBuffer.name) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            if (functionCallBuffer.arguments) {
              parsedArgs = JSON.parse(functionCallBuffer.arguments) as Record<string, unknown>;
            }
          } catch (parseErr) {
            const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            log.error(
              `GigaChat: failed to parse function arguments for "${functionCallBuffer.name}": ${errMsg}. ` +
                `Raw arguments: ${functionCallBuffer.arguments.slice(0, 500)}`,
            );
            // Return error instead of continuing with empty args
            throw new Error(
              `Failed to parse function call arguments for "${functionCallBuffer.name}": ${errMsg}`,
              { cause: parseErr },
            );
          }
          const clientName =
            gigaToToolName.get(functionCallBuffer.name) ??
            mapToolNameFromGigaChat(functionCallBuffer.name);
          accumulatedToolCalls.push({
            type: "toolCall",
            id: randomUUID(),
            name: clientName,
            arguments: parsedArgs,
          });
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
