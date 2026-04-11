import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {Api, AssistantMessage, Model} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const log = createSubsystemLogger("providers/volcengine");

type CacheState = {
  responseId?: string;
  expiredAt: number;
  /** Hash of tools + instructions to detect changes that invalidate the cache. */
  contentHash?: string;
  /** Number of input items seen in the last request (to detect compaction). */
  lastInputLength?: number;
};
const sessionCaches = new Map<string, CacheState>();

function evictStaleCaches(): void {
  const now = Date.now();
  for (const [key, state] of sessionCaches) {
    if (now >= state.expiredAt) {
      sessionCaches.delete(key);
    }
  }
}

function getOrCreateSessionCache(key: string, ttlMs: number): CacheState {
  evictStaleCaches();
  let state = sessionCaches.get(key);
  if (!state) {
    state = { expiredAt: Date.now() + ttlMs };
    sessionCaches.set(key, state);
  } else {
    state.expiredAt = Date.now() + ttlMs;
  }
  return state;
}

/**
 * Stream event shape from pi-ai's `streamOpenAIResponses`:
 * - done:  `{ type: "done", reason, message: output }`
 * - error: `{ type: "error", reason, error: output }`
 * where `output` carries `responseId`, `errorMessage`, `stopReason`, etc.
 */
type StreamEvent = {
  type: string;
  reason?: string;
  message?: { responseId?: string };
  error?: { errorMessage?: string; stopReason?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function buildZeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function computeContentHash(tools: unknown, instructions: unknown): string {
  const toolsPart = Array.isArray(tools) ? JSON.stringify(tools) : "";
  const instrPart = typeof instructions === "string" ? instructions : "";
  return hashString(`${toolsPart}|${instrPart}`);
}

function isInvalidResponseIdError(errorMessage: unknown): boolean {
  if (typeof errorMessage !== "string") {
    return false;
  }
  // the error message pattern is refer to https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/providers/openai-responses-shared.ts#L480-L489
  return (
    errorMessage.toLowerCase().includes("400 previous response with id") ||
    errorMessage.toLowerCase().includes("error code 400: previous response with id")
  );
}

export type CacheConfig = {
  enable: boolean;
  ttlSec: number;
  thinking?: boolean;
};

export function resolveCacheConfig(
  extraParams: Record<string, unknown> | undefined,
): CacheConfig | undefined {
  if (!extraParams) {
    return undefined;
  }

  const cache = extraParams.cache;
  if (!isRecord(cache) || cache.enable !== true) {
    return undefined;
  }

  const ttlSec = resolvePositiveInt(cache.ttlSec) ?? 3600;
  const thinking = typeof cache.thinking === "boolean" ? cache.thinking : undefined;

  return { enable: true, ttlSec, thinking };
}

function resolvePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function isResponseMessageItem(
  item: unknown,
): item is { type?: string; role?: string } & Record<string, unknown> {
  if (!isRecord(item)) {
    return false;
  }
  if (typeof item.type === "string") {
    return true;
  }
  return typeof item.role === "string";
}

export function filterSessionCacheInput(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input;
  }

  const originalCount = input.length;
  const trimmed: Array<unknown> = [];
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (!isResponseMessageItem(item)) {
      break;
    }

    if (item.type === "function_call_output") {
      trimmed.unshift(item);
      continue;
    }

    if (item.role === "assistant") {
      break;
    }

    if (item.role === "user") {
      trimmed.unshift(item);
      continue;
    }
    break;
  }

  const result = trimmed.length > 0 ? trimmed : input;
  log.debug(`Filter ${originalCount - result.length} cached messages`);
  return result;
}

export function injectInstructionsIntoInput(params: {
  input: unknown;
  instructions: unknown;
}): unknown {
  if (!params.instructions || typeof params.instructions !== "string") {
    return params.input;
  }
  if (!Array.isArray(params.input)) {
    return params.input;
  }
  return [
    {
      type: "message",
      role: "system",
      content: params.instructions,
    },
    ...params.input,
  ];
}

export function resolveCacheKey(params: {
  baseUrl: string;
  modelId: string;
  context: {
    systemPrompt?: string;
    messages: Array<{ timestamp?: number }>;
    tools?: Array<{ name?: string }>;
  };
  options?: { sessionId?: unknown };
}): string {
  const prefix = `${params.baseUrl}/${params.modelId}`;
  const sessionId =
    typeof params.options?.sessionId === "string" && params.options.sessionId.trim()
      ? params.options.sessionId.trim()
      : undefined;
  if (sessionId) {
    return `${prefix}:${sessionId}`;
  }

  const firstTimestamp =
    typeof params.context.messages?.[0]?.timestamp === "number"
      ? params.context.messages[0]?.timestamp
      : 0;
  const systemPrompt =
    typeof params.context.systemPrompt === "string" ? params.context.systemPrompt : "";
  const toolNames = Array.isArray(params.context.tools)
    ? params.context.tools.map((tool) => tool?.name ?? "").join("|")
    : "";
  return `${prefix}:${hashString(`${firstTimestamp}|${systemPrompt}|${toolNames}`)}`;
}

export function createVolcengineCacheWrapper(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return undefined;
  }

  const cacheConfig = resolveCacheConfig(extraParams);
  if (!cacheConfig) {
    return baseStreamFn;
  }

  const cacheTtlSeconds = cacheConfig.ttlSec;
  const thinkingBody: Record<string, unknown> | undefined =
    cacheConfig.thinking === true
      ? { type: "enabled" }
      : cacheConfig.thinking === false
        ? { type: "disabled" }
        : undefined;

  return (model, context, options) => {
    // Only the response api support session cache in Volcengine.
    if ((model as { api?: unknown }).api !== "openai-responses") {
      return baseStreamFn(model, context, options);
    }

    const sessionKey = resolveCacheKey({
      baseUrl: String((model as { baseUrl?: string }).baseUrl ?? ""),
      modelId: String(model.id ?? ""),
      context: context as {
        systemPrompt?: string;
        messages: Array<{ timestamp?: number }>;
        tools?: Array<{ name?: string }>;
      },
      options: options as { sessionId?: unknown } | undefined,
    });
    const state = getOrCreateSessionCache(sessionKey, cacheTtlSeconds * 1000);

    const originalOnPayload = options?.onPayload;
    const nextOptions = {
      ...options,
      // Async is safe here: pi-ai's streamOpenAIResponses awaits onPayload before sending the request
      onPayload: async (payload: unknown, pModel: Model<Api>) => {
        const originalResult = await originalOnPayload?.(payload, pModel);
        const target = isRecord(originalResult) ? originalResult : payload;
        if (!isRecord(target)) {
          return originalResult;
        }

        // Detect tools/instructions changes — invalidate cache if they differ
        const currentContentHash = computeContentHash(target.tools, target.instructions);
        if (state.responseId && state.contentHash && state.contentHash !== currentContentHash) {
          log.info("Tools or instructions changed, invalidating session cache");
          state.responseId = undefined;
        }
        state.contentHash = currentContentHash;

        // Detect compaction — if input length decreased significantly, the upstream
        // likely ran a compaction pass and the cached response context is stale.
        const currentInputLength = Array.isArray(target.input) ? target.input.length : 0;
        if (
          state.responseId &&
          state.lastInputLength !== undefined &&
          currentInputLength > 0 &&
          currentInputLength < state.lastInputLength
        ) {
          log.info(
            `Input length decreased (${state.lastInputLength} -> ${currentInputLength}), likely compaction — invalidating session cache`,
          );
          state.responseId = undefined;
        }
        state.lastInputLength = currentInputLength;

        const isContinuation = Boolean(state.responseId);
        if (isContinuation && target.previous_response_id === undefined) {
          target.previous_response_id = state.responseId;
          // The Ark session cache doesn't support instructions or tools in non-first request, and accept the new messages.
          delete target.instructions;
          delete target.tools;
          if (target.input !== undefined) {
            target.input = filterSessionCacheInput(target.input);
          }
        }

        if (!isContinuation && target.instructions !== undefined) {
          target.input = injectInstructionsIntoInput({
            input: target.input,
            instructions: target.instructions,
          });
          delete target.instructions;
        }

        target.caching = { type: "enabled" };
        target.store = true;
        if (thinkingBody) {
          target.thinking = thinkingBody;
        }

        if (target.caching !== undefined && target.text != null) {
          delete target.caching;
        }

        if (target.caching !== undefined) {
          target.expire_at = Math.floor(Date.now() / 1000) + cacheTtlSeconds;
        }
        return target;
      },
    };

    const pipeStream = async (
      output: ReturnType<typeof createAssistantMessageEventStream>,
      allowRetry: boolean,
    ) => {
      const stream = await Promise.resolve(baseStreamFn(model, context, nextOptions));
      for await (const event of stream) {
        const typed = event as StreamEvent;

        if (
          typed.type === "error" &&
          allowRetry &&
          isInvalidResponseIdError(typed.error?.errorMessage)
        ) {
          // Stale previous_response_id — discard this stream and retry without cache state
          state.responseId = undefined;
          log.warn(
            `Retry the request since meet invalid response id error, detail: ${typed.error?.errorMessage}"`,
          );
          return pipeStream(output, false);
        }

        if (typed.type === "done" && typed.message?.responseId) {
          state.responseId = typed.message.responseId;
        }
        output.push(event);
      }

      const finalMessage = await stream.result();
      output.end(finalMessage);
    };

    const output = createAssistantMessageEventStream();
    void pipeStream(output, true).catch((err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorPayload: AssistantMessage & { errorMessage: string } = {
        role: "assistant",
        content: [],
        stopReason: "error",
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: buildZeroUsage(),
        timestamp: Date.now(),
        errorMessage,
      };
      output.push({
        type: "error",
        reason: "error",
        error: errorPayload,
      });
      output.end(errorPayload);
    });

    return output;
  };
}
