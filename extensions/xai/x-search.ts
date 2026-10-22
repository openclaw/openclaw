import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import {
  jsonResult,
  normalizeToIsoDate,
  readCache,
  readStringArrayParam,
  readStringParam,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveXaiResponsesEndpoint } from "./src/responses-tool-shared.js";
import {
  isXaiToolEnabled,
  resolveXaiToolApiKeyWithAuth,
  type XaiToolAuthContext,
} from "./src/tool-auth-shared.js";
import {
  resolveNormalizedXaiToolModel,
  resolvePositiveIntegerToolConfig,
} from "./src/tool-config-shared.js";
import { resolveEffectiveXSearchConfig } from "./src/x-search-config.js";
import {
  buildXaiXSearchPayload,
  requestXaiXSearch,
  XAI_DEFAULT_X_SEARCH_MODEL,
  type XaiXSearchOptions,
} from "./src/x-search-shared.js";
import {
  buildMissingXSearchApiKeyPayload,
  createXSearchToolDefinition,
  X_SEARCH_HANDLE_LIMIT,
} from "./x-search-tool-shared.js";

class PluginToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

const X_SEARCH_CACHE_KEY = Symbol.for("openclaw.xai.x-search.cache");

type XSearchCacheEntry = {
  expiresAt: number;
  insertedAt: number;
  value: Record<string, unknown>;
};

const X_SEARCH_CACHE = resolveGlobalMap<string, XSearchCacheEntry>(X_SEARCH_CACHE_KEY);

function normalizeOptionalIsoDate(value: string | undefined, label: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new PluginToolInputError(`${label} must use YYYY-MM-DD`);
  }
  if (!normalizeToIsoDate(trimmed)) {
    throw new PluginToolInputError(`${label} must be a valid calendar date`);
  }
  return trimmed;
}

export function createXSearchTool(options?: {
  config?: unknown;
  runtimeConfig?: Record<string, unknown> | null;
  auth?: XaiToolAuthContext;
}) {
  const xSearchConfig = resolveEffectiveXSearchConfig(options?.config as never);
  const runtimeConfig = options?.runtimeConfig ?? getRuntimeConfigSnapshot();
  if (
    !isXaiToolEnabled({
      enabled: typeof xSearchConfig?.enabled === "boolean" ? xSearchConfig.enabled : undefined,
      runtimeConfig: (runtimeConfig ?? undefined) as never,
      sourceConfig: options?.config as never,
      auth: options?.auth,
    })
  ) {
    return null;
  }

  return createXSearchToolDefinition(async (_toolCallId, args, signal) => {
    signal?.throwIfAborted();
    const apiKey = await resolveXaiToolApiKeyWithAuth({
      sourceConfig: options?.config as never,
      runtimeConfig: (runtimeConfig ?? undefined) as never,
      auth: options?.auth,
    });
    if (!apiKey) {
      return jsonResult(buildMissingXSearchApiKeyPayload());
    }

    const query = readStringParam(args, "query", { required: true });
    const allowedXHandles = readStringArrayParam(args, "allowed_x_handles");
    const excludedXHandles = readStringArrayParam(args, "excluded_x_handles");
    if (allowedXHandles && excludedXHandles) {
      throw new PluginToolInputError(
        "allowed_x_handles and excluded_x_handles cannot be used together",
      );
    }
    for (const [label, handles] of [
      ["allowed_x_handles", allowedXHandles],
      ["excluded_x_handles", excludedXHandles],
    ] as const) {
      if (handles && handles.length > X_SEARCH_HANDLE_LIMIT) {
        throw new PluginToolInputError(
          `${label} cannot contain more than ${X_SEARCH_HANDLE_LIMIT} handles`,
        );
      }
    }
    const fromDate = normalizeOptionalIsoDate(readStringParam(args, "from_date"), "from_date");
    const toDate = normalizeOptionalIsoDate(readStringParam(args, "to_date"), "to_date");
    if (fromDate && toDate && fromDate > toDate) {
      throw new PluginToolInputError("from_date must be on or before to_date");
    }

    const xSearchOptions: XaiXSearchOptions = {
      query,
      allowedXHandles,
      excludedXHandles,
      fromDate,
      toDate,
      enableImageUnderstanding: args.enable_image_understanding === true,
      enableVideoUnderstanding: args.enable_video_understanding === true,
    };
    const model = resolveNormalizedXaiToolModel({
      config: xSearchConfig,
      defaultModel: XAI_DEFAULT_X_SEARCH_MODEL,
    });
    const endpoint = resolveXaiResponsesEndpoint(xSearchConfig?.baseUrl);
    const inlineCitations = xSearchConfig?.inlineCitations === true;
    const maxTurns = resolvePositiveIntegerToolConfig(xSearchConfig, "maxTurns");
    const cacheKey = JSON.stringify([
      "x_search",
      sha256Hex(apiKey),
      model,
      endpoint,
      query,
      inlineCitations,
      maxTurns ?? null,
      xSearchOptions.allowedXHandles ?? null,
      xSearchOptions.excludedXHandles ?? null,
      xSearchOptions.fromDate ?? null,
      xSearchOptions.toDate ?? null,
      xSearchOptions.enableImageUnderstanding ?? false,
      xSearchOptions.enableVideoUnderstanding ?? false,
    ]);
    const cacheTtlMs = resolveCacheTtlMs(xSearchConfig?.cacheTtlMinutes, 15);
    const cached = readCache(X_SEARCH_CACHE, cacheKey, cacheTtlMs);
    if (cached) {
      return jsonResult({ ...cached.value, cached: true });
    }

    const startedAt = Date.now();
    const result = await requestXaiXSearch({
      apiKey,
      endpoint,
      model,
      timeoutSeconds: resolveTimeoutSeconds(xSearchConfig?.timeoutSeconds, 30),
      inlineCitations,
      maxTurns,
      options: xSearchOptions,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    const payload = buildXaiXSearchPayload({
      query,
      model,
      tookMs: Date.now() - startedAt,
      ...result,
      options: xSearchOptions,
    });
    writeCache(X_SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
    return jsonResult(payload);
  });
}
