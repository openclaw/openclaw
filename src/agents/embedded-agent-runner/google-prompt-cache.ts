import {
  sortPromptCacheToolsByName,
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "@openclaw/ai/internal/shared";
import { mergeTransportHeaders, sanitizeTransportPayloadText } from "@openclaw/ai/transports";
import { stableStringify } from "@openclaw/normalization-core";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  parseDateStringTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { omitNullRequestHeaders } from "../../../packages/llm-core/src/utils/request-headers.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import { normalizeGoogleApiBaseUrl } from "../../infra/google-api-base-url.js";
import { cancelUnreadResponseBody } from "../../infra/http-body.js";
import { streamWithPayloadPatch } from "../../llm/providers/stream-wrappers/stream-payload-utils.js";
import type { Model } from "../../llm/types.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../../secrets/sentinel.js";
import { readProviderJsonObjectResponse } from "../provider-http-errors.js";
import { resolveProviderRequestHeaders } from "../provider-request-config.js";
import { buildGuardedModelFetch } from "../provider-transport-fetch.js";
import { swapSecretSentinelsForEgress } from "../provider-transport-secret-egress.js";
import type { StreamFn } from "../runtime/index.js";
import { log } from "./logger.js";
import {
  isGooglePromptCacheEligible,
  resolveCacheRetention,
  resolveExplicitCachedContent,
} from "./prompt-cache-retention.js";
import { prependRuntimeContextForModel } from "./run/runtime-context-prompt.js";

const GOOGLE_PROMPT_CACHE_CUSTOM_TYPE = "openclaw.google-prompt-cache";
// CachedContent metadata responses are tiny (name + expireTime); cap the read so
// a buggy/hostile Google endpoint cannot stream an unbounded body into memory.
const GOOGLE_PROMPT_CACHE_RESPONSE_MAX_BYTES = 1024 * 1024;
const GOOGLE_PROMPT_CACHE_RETRY_BACKOFF_MS = 10 * 60_000;
const GOOGLE_PROMPT_CACHE_SHORT_REFRESH_WINDOW_MS = 30_000;
const GOOGLE_PROMPT_CACHE_LONG_REFRESH_WINDOW_MS = 5 * 60_000;

type CacheRetention = "short" | "long";
type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

type GooglePromptCacheSessionManager = {
  appendCustomEntryAsync(customType: string, data?: unknown): Promise<void>;
  getEntries(): CustomEntryLike[];
};

type GooglePromptCacheEntry = {
  timestamp: number;
  provider: string;
  modelId: string;
  modelApi?: string | null;
  baseUrl: string;
  systemPromptDigest: string;
  cacheConfigDigest?: string;
  cacheRetention: CacheRetention;
} & (
  | {
      status: "ready";
      cachedContent: string;
      expireTime: string;
    }
  | {
      status: "failed";
      retryAfter: number;
      statusCode?: number;
      errorMessage?: string;
    }
);

type PrepareGooglePromptCacheStreamFnParams = {
  apiKey?: string;
  extraParams?: Record<string, unknown>;
  model: Model;
  modelId: string;
  provider: string;
  sessionManager: GooglePromptCacheSessionManager;
  signal?: AbortSignal;
  streamFn: StreamFn | undefined;
};

function stringifyGooglePromptCacheKeyPart(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function readLatestGooglePromptCacheEntry(
  sessionManager: GooglePromptCacheSessionManager,
  matchKey: string,
): GooglePromptCacheEntry | null {
  try {
    const entries = sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry?.type !== "custom" || entry?.customType !== GOOGLE_PROMPT_CACHE_CUSTOM_TYPE) {
        continue;
      }
      const data = entry.data;
      if (!data || typeof data !== "object") {
        continue;
      }
      const cacheData = data as Record<string, unknown>;
      const candidateKey = stableStringify({
        provider: stringifyGooglePromptCacheKeyPart(cacheData.provider),
        modelId: stringifyGooglePromptCacheKeyPart(cacheData.modelId),
        modelApi:
          typeof cacheData.modelApi === "string" || cacheData.modelApi == null
            ? cacheData.modelApi
            : null,
        baseUrl: stringifyGooglePromptCacheKeyPart(cacheData.baseUrl),
        systemPromptDigest: stringifyGooglePromptCacheKeyPart(cacheData.systemPromptDigest),
        cacheConfigDigest:
          typeof cacheData.cacheConfigDigest === "string" ? cacheData.cacheConfigDigest : undefined,
      });
      if (candidateKey === matchKey) {
        return data as GooglePromptCacheEntry;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function appendGooglePromptCacheEntry(
  sessionManager: GooglePromptCacheSessionManager,
  entry: GooglePromptCacheEntry,
): Promise<void> {
  try {
    await sessionManager.appendCustomEntryAsync(GOOGLE_PROMPT_CACHE_CUSTOM_TYPE, entry);
  } catch (err) {
    if (err instanceof SessionTranscriptWriterClaimReboundError) {
      throw err;
    }
    // ignore persistence failures
  }
}

function readFutureExpireTime(
  value: unknown,
  now: number,
): { value: string; timestamp: number } | null {
  const timestamp = parseDateStringTimestampMs(value);
  return typeof value === "string" && isFutureDateTimestampMs(timestamp, { nowMs: now })
    ? { value, timestamp }
    : null;
}

function readGooglePromptCacheName(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("cachedContents/")) {
    return null;
  }
  const id = value.slice("cachedContents/".length);
  if (!id || id === "." || id === "..") {
    return null;
  }
  try {
    return encodeURIComponent(id) === id ? value : null;
  } catch {
    return null;
  }
}

function mapManagedGoogleToolChoice(
  choice: unknown,
): { mode: "AUTO" | "NONE" | "ANY"; allowedFunctionNames?: string[] } | undefined {
  if (!choice) {
    return undefined;
  }
  if (typeof choice === "object" && (choice as { type?: unknown }).type === "function") {
    const functionName = (choice as { function?: { name?: unknown } }).function?.name;
    return typeof functionName === "string"
      ? { mode: "ANY", allowedFunctionNames: [functionName] }
      : { mode: "ANY" };
  }
  switch (choice) {
    case "none":
      return { mode: "NONE" };
    case "any":
    case "required":
      return { mode: "ANY" };
    default:
      return { mode: "AUTO" };
  }
}

export async function prepareGooglePromptCacheStreamFn(
  params: PrepareGooglePromptCacheStreamFnParams,
): Promise<StreamFn | undefined> {
  if (
    !params.streamFn ||
    resolveExplicitCachedContent(params.extraParams) ||
    !isGooglePromptCacheEligible({ modelApi: params.model.api, modelId: params.modelId })
  ) {
    return undefined;
  }
  const resolvedRetention = resolveCacheRetention(
    params.extraParams,
    params.provider,
    params.model.api,
    params.modelId,
  );
  if (resolvedRetention !== "short" && resolvedRetention !== "long") {
    return undefined;
  }
  const apiKey = params.apiKey?.trim();
  if (!apiKey) {
    return undefined;
  }

  const inner = params.streamFn;
  return async (model, context, options) => {
    const split = splitSystemPromptCacheBoundary(context.systemPrompt ?? "");
    const systemPrompt = sanitizeTransportPayloadText(
      stripSystemPromptCacheBoundary(split?.stablePrefix ?? ""),
    );
    if (!split || !systemPrompt.trim()) {
      return inner(model, context, options);
    }
    const tools = context.tools?.length
      ? [
          {
            functionDeclarations: sortPromptCacheToolsByName(context.tools).map((tool) => ({
              name: tool.name,
              description: tool.description,
              parametersJsonSchema: tool.parameters,
            })),
          },
        ]
      : undefined;
    const toolChoice = tools
      ? mapManagedGoogleToolChoice((options as { toolChoice?: unknown } | undefined)?.toolChoice)
      : undefined;
    const toolConfig = toolChoice ? { functionCallingConfig: toolChoice } : undefined;
    const authProvider = params.model.provider;
    const sentinel = looksLikeSecretSentinel(apiKey);
    const resolvedApiKey = sentinel ? resolveSecretSentinel(apiKey) : apiKey;
    if (resolvedApiKey === undefined) {
      throw new Error(
        `Secret sentinel ${apiKey} is not registered in this process; refusing Google prompt-cache auth`,
      );
    }
    const token = resolvedApiKey.startsWith("{")
      ? safeParseJsonRecord(resolvedApiKey)?.token
      : undefined;
    const parsedAuthHeaders: Record<string, string> = {
      ...(typeof token === "string" && token
        ? { Authorization: `Bearer ${token}` }
        : { "x-goog-api-key": resolvedApiKey }),
      "Content-Type": "application/json",
    };
    const authHeaders: Record<string, string> =
      !sentinel && !isSecretValueRegisteredForRedaction(apiKey)
        ? parsedAuthHeaders
        : Object.fromEntries(
            Object.entries(parsedAuthHeaders).map(([name, value]) => {
              const isCredentialHeader =
                name.toLowerCase() === "authorization" || name.toLowerCase() === "x-goog-api-key";
              return [
                name,
                isCredentialHeader
                  ? mintSecretSentinel(value, { label: `model-auth:${authProvider}` })
                  : value,
              ];
            }),
          );
    const callerHeaders = mergeTransportHeaders(params.model.headers, options?.headers);
    const headers =
      omitNullRequestHeaders(
        resolveProviderRequestHeaders({
          provider: params.model.provider,
          api: params.model.api,
          baseUrl: normalizeGoogleApiBaseUrl(params.model.baseUrl),
          capability: "llm",
          transport: "http",
          defaultHeaders: authHeaders,
          callerHeaders,
          precedence: "caller-wins",
        }) ??
          mergeTransportHeaders(authHeaders, callerHeaders) ??
          authHeaders,
      ) ?? {};
    const configuredModel = params.model;
    const provider = params.provider;
    const sessionManager = params.sessionManager;
    const signal = params.signal;
    const cachedContent = await (async (): Promise<string | null> => {
      const baseUrl = normalizeGoogleApiBaseUrl(configuredModel.baseUrl);
      const now = asDateTimestampMs(Date.now());
      if (now === undefined) {
        return null;
      }
      const scopeHeaders =
        swapSecretSentinelsForEgress({ url: baseUrl, headers }).headers ?? new Headers(headers);
      const cacheIdentity = {
        provider,
        modelId: configuredModel.id,
        modelApi: configuredModel.api,
        baseUrl,
        systemPromptDigest: sha256Hex(systemPrompt),
        cacheConfigDigest: sha256Hex(
          stableStringify({
            tools,
            toolConfig,
            headers: Object.fromEntries(scopeHeaders),
          }),
        ),
      };
      const latestEntry = readLatestGooglePromptCacheEntry(
        sessionManager,
        stableStringify(cacheIdentity),
      );
      const entryMetadata = {
        timestamp: now,
        ...cacheIdentity,
        cacheRetention: resolvedRetention,
      };

      if (
        latestEntry?.status === "failed" &&
        isFutureDateTimestampMs(latestEntry.retryAfter, { nowMs: now })
      ) {
        return null;
      }

      const fetchImpl = buildGuardedModelFetch(configuredModel);
      const refreshWindowMs =
        resolvedRetention === "long"
          ? GOOGLE_PROMPT_CACHE_LONG_REFRESH_WINDOW_MS
          : GOOGLE_PROMPT_CACHE_SHORT_REFRESH_WINDOW_MS;
      const existingCachedContent =
        latestEntry?.status === "ready"
          ? readGooglePromptCacheName(latestEntry.cachedContent)
          : null;
      const expiry =
        latestEntry?.status === "ready" && existingCachedContent
          ? readFutureExpireTime(latestEntry.expireTime, now)
          : null;
      if (expiry && expiry.timestamp - now > refreshWindowMs) {
        return existingCachedContent;
      }
      const reusableCachedContent = expiry ? existingCachedContent : null;
      const refreshing = Boolean(reusableCachedContent);
      const ttl = resolvedRetention === "long" ? "3600s" : "300s";
      let url: string;
      let body: string;
      if (reusableCachedContent) {
        url = `${baseUrl}/${reusableCachedContent}?updateMask=ttl`;
        body = JSON.stringify({ ttl });
      } else {
        const modelId = configuredModel.id;
        url = `${baseUrl}/cachedContents`;
        body = JSON.stringify({
          model: modelId.startsWith("models/") ? modelId : `models/${modelId}`,
          ttl,
          systemInstruction: { parts: [{ text: systemPrompt }] },
          ...(tools ? { tools } : {}),
          ...(toolConfig ? { toolConfig } : {}),
        });
      }
      let result: { cachedContent: string; expireTime: string } | null = null;
      let response: Response | undefined;
      try {
        response = await fetchImpl(url, {
          method: refreshing ? "PATCH" : "POST",
          headers,
          body,
          signal,
        });
        if (!response.ok) {
          throw new Error(`Google prompt cache request failed (${response.status})`);
        }
        const payload = await readProviderJsonObjectResponse(response, "Google prompt cache", {
          maxBytes: GOOGLE_PROMPT_CACHE_RESPONSE_MAX_BYTES,
          onOverflow: ({ size, maxBytes }) =>
            new Error(
              `Google prompt cache response too large: ${size} bytes (limit: ${maxBytes} bytes)`,
            ),
          requestHeaders: headers,
        });
        const responseExpiry = readFutureExpireTime(payload.expireTime, now);
        const responseCachedContent = refreshing
          ? reusableCachedContent
          : readGooglePromptCacheName(payload.name);
        if (!responseCachedContent || !responseExpiry) {
          throw new Error("Google prompt cache response is invalid");
        }
        result = { cachedContent: responseCachedContent, expireTime: responseExpiry.value };
      } catch {
        signal?.throwIfAborted();
      } finally {
        await cancelUnreadResponseBody(response);
      }
      if (result) {
        await appendGooglePromptCacheEntry(sessionManager, {
          status: "ready",
          ...entryMetadata,
          ...result,
        });
      } else if (!reusableCachedContent) {
        // Failed refreshes keep their still-valid resource; only creation failures back off.
        await appendGooglePromptCacheEntry(sessionManager, {
          status: "failed",
          ...entryMetadata,
          retryAfter:
            resolveExpiresAtMsFromDurationMs(GOOGLE_PROMPT_CACHE_RETRY_BACKOFF_MS, {
              nowMs: now,
            }) ?? 0,
        });
      }
      return result?.cachedContent ?? reusableCachedContent;
    })();
    if (!cachedContent) {
      log.debug(
        `google prompt cache unavailable for ${params.provider}/${params.modelId}; continuing without cachedContent`,
      );
      return inner(model, context, options);
    }

    return streamWithPayloadPatch(
      inner,
      model,
      {
        ...context,
        systemPrompt: undefined,
        tools: undefined,
        // Only a ready cache owns the stable system instructions. Keep fallback
        // requests intact, and never persist this per-request suffix projection.
        messages: prependRuntimeContextForModel(
          context.messages,
          sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(split.dynamicSuffix)),
        ),
      },
      // A provider cache resource belongs to its credential scope; inference
      // must not rotate to another project's API key while referencing it.
      { ...options, headers },
      (payload) => {
        payload.cachedContent = cachedContent;
      },
    );
  };
}
