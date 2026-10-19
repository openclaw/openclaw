import { createHash } from "node:crypto";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { LiveModelCatalogHttpError } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  isCloudModelRef,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-onboard";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isHostedOllamaCloud,
  OLLAMA_CLOUD_DEFAULT_MODELS,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_COST,
  OLLAMA_LOCAL_CONTEXT_TOKENS,
  resolveOllamaCloudDefaultModel,
  resolveOllamaOutputBudget,
} from "./defaults.js";
import {
  buildOllamaThinkingLevelMap,
  readOllamaThinkingMapValue,
  supportsOllamaCloudFullThinkingEffort,
} from "./model-reasoning.js";
import { readProviderBaseUrl } from "./provider-base-url.js";

export type OllamaTagModel = {
  name: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  remote_host?: string;
  remote_model?: string;
  capabilities?: string[];
  details?: {
    context_length?: number;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
};

export type OllamaTagsResponse = {
  models?: OllamaTagModel[];
};

type OllamaRunningModel = {
  name?: unknown;
  model?: unknown;
};

type OllamaModelRow = OllamaTagModel | OllamaRunningModel;

export type OllamaModelWithContext = OllamaTagModel &
  OllamaModelShowInfo & { capabilitiesFromList?: boolean };

const OLLAMA_SHOW_CONCURRENCY = 8;
const OLLAMA_CONTEXT_ENRICH_LIMIT = 200;
const OLLAMA_SHOW_TIMEOUT_MS = 3000;
const OLLAMA_TAGS_TIMEOUT_MS = 5000;
const MAX_OLLAMA_DISCOVERY_PROBES = OLLAMA_CONTEXT_ENRICH_LIMIT * 4;
const MAX_OLLAMA_SHOW_CACHE_ENTRIES = 256;
const ollamaModelShowInfoCache = new Map<string, Promise<OllamaModelShowInfo>>();
const OLLAMA_ALWAYS_BLOCKED_HOSTNAMES = new Set(["metadata.google.internal"]);

export function buildOllamaBaseUrlSsrFPolicy(baseUrl: string) {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = URL.parse(trimmed);
  if (
    !parsed ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    OLLAMA_ALWAYS_BLOCKED_HOSTNAMES.has(parsed.hostname)
  ) {
    return undefined;
  }
  return {
    hostnameAllowlist: [parsed.hostname],
    allowPrivateNetwork: true,
  };
}

export function resolveOllamaApiBase(configuredBaseUrl?: string): string {
  if (!configuredBaseUrl) {
    return OLLAMA_DEFAULT_BASE_URL;
  }
  const trimmed = configuredBaseUrl.replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/i, "");
}

export type OllamaModelShowInfo = {
  contextWindow?: number;
  capabilities?: string[];
  thinkingLevelMap?: ModelDefinitionConfig["thinkingLevelMap"];
  parameterCount?: number;
  /** Distinguishes a failed request from a successful response that omitted capabilities. */
  showInspectionFailed?: boolean;
};

export const mergeOllamaModelShowInfo = (
  model: OllamaModelWithContext,
  info: OllamaModelShowInfo,
): OllamaModelWithContext => {
  const incomplete =
    info.capabilities === undefined &&
    model.capabilities !== undefined &&
    isOllamaRemoteModel(model) &&
    !isOllamaEmbeddingOnlyModel(model);
  const parameterCount =
    info.parameterCount ??
    model.parameterCount ??
    parseOllamaParameterSize(model.details?.parameter_size);
  return {
    ...model,
    ...info,
    ...(parameterCount !== undefined ? { parameterCount } : {}),
    contextWindow: info.contextWindow ?? model.contextWindow ?? model.details?.context_length,
    capabilities: incomplete
      ? [
          ...new Set([
            ...(model.capabilities ?? []),
            ...(info.showInspectionFailed ? [] : ["tools"]),
            ...(isReasoningModelHeuristic(model.name) ? ["thinking"] : []),
          ]),
        ]
      : (info.capabilities ?? model.capabilities),
    ...(incomplete ? { capabilitiesFromList: true } : {}),
  };
};

const OLLAMA_FAILED_SHOW_INFO: OllamaModelShowInfo = Object.freeze({
  showInspectionFailed: true,
});

type OllamaModelRequestOptions = {
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  discoveryMode?: "strict";
};

type OllamaModelShowRequestOptions = OllamaModelRequestOptions & {
  auditContext?: string;
};

export function throwIfOllamaRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toErrorObject(signal.reason, "Ollama request aborted");
  }
}

function buildOllamaModelShowCacheKey(
  apiBase: string,
  model: Pick<OllamaTagModel, "name" | "digest" | "modified_at">,
  apiKey?: string,
): string | undefined {
  const version = model.digest?.trim() || model.modified_at?.trim();
  if (!version) {
    return undefined;
  }
  const authScope = apiKey ? createHash("sha256").update(apiKey).digest("hex") : "anonymous";
  return `${resolveOllamaApiBase(apiBase)}|${model.name}|${version}|${authScope}`;
}

function setOllamaModelShowCacheEntry(key: string, value: Promise<OllamaModelShowInfo>): void {
  pruneMapToMaxSize(ollamaModelShowInfoCache, MAX_OLLAMA_SHOW_CACHE_ENTRIES - 1);
  ollamaModelShowInfoCache.set(key, value);
}

export function hasOllamaModelShowInfo(info: OllamaModelShowInfo): boolean {
  return (
    info.parameterCount !== undefined ||
    info.contextWindow !== undefined ||
    (info.capabilities?.length ?? 0) > 0 ||
    info.thinkingLevelMap !== undefined
  );
}

function parseOllamaParameterSize(value: unknown): number | undefined {
  const match =
    typeof value === "string" ? value.trim().match(/^(\d+(?:\.\d+)?)\s*([KMBT])$/i) : undefined;
  const magnitude = match?.[1];
  const unit = match?.[2];
  if (!magnitude || !unit) {
    return undefined;
  }
  const exponent = "KMBT".indexOf(unit.toUpperCase()) + 1;
  const count = Math.round(Number(magnitude) * 1000 ** exponent);
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

function parseOllamaNumCtxParameter(parameters: unknown): number | undefined {
  if (typeof parameters !== "string" || !parameters.trim()) {
    return undefined;
  }

  let lastValue: number | undefined;
  for (const rawLine of parameters.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^num_ctx\s+(-?\d+)\b/);
    if (!match) {
      continue;
    }
    const rawValue = match[1];
    if (!rawValue) {
      continue;
    }
    const parsed = Number.parseInt(rawValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      lastValue = parsed;
    }
  }
  return lastValue;
}

export async function readOllamaModelShowInfo(
  apiBase: string,
  modelName: string,
  opts?: OllamaModelShowRequestOptions,
): Promise<OllamaModelShowInfo> {
  const normalizedApiBase = resolveOllamaApiBase(apiBase);
  const auditContext = opts?.auditContext ?? "ollama-provider-models.show";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts?.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: `${normalizedApiBase}/api/show`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({ model: modelName }),
    },
    // Guard-owned timeoutMs also bounds DNS/proxy preflight; init.signal does not.
    timeoutMs: Math.min(opts?.timeoutMs ?? OLLAMA_SHOW_TIMEOUT_MS, OLLAMA_SHOW_TIMEOUT_MS),
    ...(opts?.signal ? { signal: opts.signal } : {}),
    policy: buildOllamaBaseUrlSsrFPolicy(normalizedApiBase),
    auditContext,
  });
  try {
    if (!response.ok) {
      // Capture can retain a cloned tee branch, so cancellation must not delay
      // the guard's bounded dispatcher release.
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`Ollama model inspection failed with HTTP ${response.status}`);
    }
    const data = await readProviderJsonResponse<{
      model_info?: Record<string, unknown>;
      details?: OllamaTagModel["details"];
      capabilities?: unknown;
      parameters?: unknown;
      thinking?: unknown;
    }>(response, auditContext);

    let contextWindow: number | undefined;
    if (data.model_info) {
      for (const [key, value] of Object.entries(data.model_info)) {
        if (
          key.endsWith(".context_length") &&
          typeof value === "number" &&
          Number.isFinite(value)
        ) {
          const ctx = Math.floor(value);
          if (ctx > 0) {
            contextWindow = ctx;
            break;
          }
        }
      }
    }

    const paramCtx = parseOllamaNumCtxParameter(data.parameters);
    if (paramCtx !== undefined && (contextWindow === undefined || paramCtx > contextWindow)) {
      contextWindow = paramCtx;
    }

    const capabilities = Array.isArray(data.capabilities)
      ? (data.capabilities as unknown[]).filter(
          (capability): capability is string => typeof capability === "string",
        )
      : undefined;

    const rawParameterCount = data.model_info?.["general.parameter_count"];
    const parameterCount =
      typeof rawParameterCount === "number" &&
      Number.isSafeInteger(rawParameterCount) &&
      rawParameterCount > 0
        ? rawParameterCount
        : parseOllamaParameterSize(data.details?.parameter_size);
    const thinkingLevelMap = await buildOllamaThinkingLevelMap(modelName, data.thinking);
    return {
      contextWindow,
      capabilities,
      ...(parameterCount !== undefined ? { parameterCount } : {}),
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    };
  } finally {
    await release();
  }
}

export async function queryOllamaModelShowInfo(
  apiBase: string,
  modelName: string,
  opts?: OllamaModelRequestOptions,
): Promise<OllamaModelShowInfo> {
  try {
    return await readOllamaModelShowInfo(apiBase, modelName, opts);
  } catch {
    throwIfOllamaRequestAborted(opts?.signal);
    return OLLAMA_FAILED_SHOW_INFO;
  }
}

async function queryOllamaModelShowInfoCached(
  apiBase: string,
  model: Pick<OllamaTagModel, "name" | "digest" | "modified_at">,
  opts?: OllamaModelRequestOptions,
): Promise<OllamaModelShowInfo> {
  const normalizedApiBase = resolveOllamaApiBase(apiBase);
  const cacheKey = buildOllamaModelShowCacheKey(normalizedApiBase, model, opts?.apiKey);
  // Caller-owned deadlines and cancellation must not affect a shared catalog probe.
  if (!cacheKey || opts?.timeoutMs !== undefined || opts?.signal) {
    return await queryOllamaModelShowInfo(normalizedApiBase, model.name, opts);
  }

  const cached = ollamaModelShowInfoCache.get(cacheKey);
  if (cached) {
    return await cached;
  }

  const pending = queryOllamaModelShowInfo(normalizedApiBase, model.name, opts).then((result) => {
    if (!hasOllamaModelShowInfo(result)) {
      ollamaModelShowInfoCache.delete(cacheKey);
    }
    return result;
  });
  setOllamaModelShowCacheEntry(cacheKey, pending);
  return await pending;
}

/** @deprecated Use queryOllamaModelShowInfo instead. */
export async function queryOllamaContextWindow(
  apiBase: string,
  modelName: string,
): Promise<number | undefined> {
  return (await queryOllamaModelShowInfo(apiBase, modelName)).contextWindow;
}

export async function enrichOllamaModelsWithContext(
  apiBase: string,
  models: OllamaTagModel[],
  opts?: OllamaModelRequestOptions,
): Promise<OllamaModelWithContext[]> {
  const enriched: OllamaModelWithContext[] = [];
  for (let index = 0; index < models.length; index += OLLAMA_SHOW_CONCURRENCY) {
    throwIfOllamaRequestAborted(opts?.signal);
    const batch = models.slice(index, index + OLLAMA_SHOW_CONCURRENCY);
    const probes = batch.map(async (model) => {
      const showInfo = await queryOllamaModelShowInfoCached(apiBase, model, opts);
      return mergeOllamaModelShowInfo(model, showInfo);
    });
    try {
      enriched.push(...(await Promise.all(probes)));
    } catch (error) {
      // A canceled probe must join sibling HTTP cleanup before the node becomes idle.
      await Promise.allSettled(probes);
      throw error;
    }
  }
  return enriched;
}

export async function enrichOllamaCompletionModels(
  apiBase: string,
  models: OllamaTagModel[],
  opts?: OllamaModelRequestOptions & { requireCompletionCapability?: boolean },
): Promise<OllamaModelWithContext[]> {
  const completionModels: OllamaModelWithContext[] = [];
  const probeLimit = Math.min(models.length, MAX_OLLAMA_DISCOVERY_PROBES);
  for (
    let index = 0;
    index < probeLimit && completionModels.length < OLLAMA_CONTEXT_ENRICH_LIMIT;
    index += OLLAMA_SHOW_CONCURRENCY
  ) {
    throwIfOllamaRequestAborted(opts?.signal);
    const batch = await enrichOllamaModelsWithContext(
      apiBase,
      models.slice(index, Math.min(index + OLLAMA_SHOW_CONCURRENCY, probeLimit)),
      opts,
    );
    for (const model of batch) {
      const canComplete = model.capabilities?.includes("completion");
      if (
        isOllamaEmbeddingOnlyModel(model) ||
        (!canComplete &&
          (opts?.requireCompletionCapability ||
            (model.capabilities && !model.capabilitiesFromList)))
      ) {
        continue;
      }
      completionModels.push(model);
      if (completionModels.length === OLLAMA_CONTEXT_ENRICH_LIMIT) {
        break;
      }
    }
  }
  return completionModels;
}

export function isOllamaCloudModel(modelName: string | undefined): boolean {
  return isCloudModelRef(modelName);
}

export function isOllamaEmbeddingOnlyModel(model: OllamaTagModel): boolean {
  // Advertised tools do not turn an embedding-only row into a chat model.
  return (
    model.capabilities?.includes("embedding") === true && !model.capabilities.includes("completion")
  );
}

export function isOllamaRemoteModel(model: OllamaTagModel): boolean {
  // Remote stubs can identify only the upstream model, without a host or cloud suffix.
  return (
    Boolean(model.remote_host?.trim() || model.remote_model?.trim()) ||
    isOllamaCloudModel(model.name)
  );
}

export function isReasoningModelHeuristic(modelId: string): boolean {
  return /r1|reasoning|think|reason/i.test(modelId);
}

export function buildOllamaModelDefinition(
  modelId: string,
  contextWindow?: number,
  capabilities?: string[],
  opts?: OllamaModelShowInfo & { remote?: boolean },
): ModelDefinitionConfig {
  const cloudModel = resolveOllamaCloudDefaultModel(modelId);
  const resolvedContext =
    contextWindow ?? cloudModel?.contextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW;
  return {
    id: modelId,
    name: modelId,
    reasoning: opts?.thinkingLevelMap
      ? Object.values(opts.thinkingLevelMap).some((value) =>
          Boolean(readOllamaThinkingMapValue(value)),
        )
      : supportsOllamaCloudFullThinkingEffort(modelId) ||
        (capabilities === undefined
          ? isReasoningModelHeuristic(modelId)
          : capabilities.includes("thinking")),
    input: capabilities?.includes("vision") ? ["text", "image"] : ["text"],
    cost: OLLAMA_DEFAULT_COST,
    contextWindow: resolvedContext,
    maxTokens: resolveOllamaOutputBudget({
      modelId,
      contextWindow: resolvedContext,
      remote: opts?.remote,
    }),
    ...(opts?.parameterCount !== undefined ? { parameterCount: opts.parameterCount } : {}),
    ...(opts?.thinkingLevelMap ? { thinkingLevelMap: opts.thinkingLevelMap } : {}),
    compat: {
      supportsTools: capabilities?.includes("tools") ?? opts?.showInspectionFailed !== true,
      supportsUsageInStreaming: true,
      supportsJsonSchemaResponseFormat: !isOllamaCloudModel(modelId),
    },
  };
}

export function buildDefaultOllamaCloudModelDefinition(
  model: (typeof OLLAMA_CLOUD_DEFAULT_MODELS)[number],
): ModelDefinitionConfig {
  return {
    ...buildOllamaModelDefinition(model.id, model.contextWindow, [...model.capabilities], {
      remote: true,
    }),
    compat: {
      supportsTools: true,
      supportsUsageInStreaming: true,
    },
  };
}

export function toDynamicOllamaModel(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  model: ModelDefinitionConfig;
}): ProviderRuntimeModel {
  const input = params.model.input.filter(
    (value): value is "text" | "image" => value === "text" || value === "image",
  );
  const api = params.providerConfig.api ?? "ollama";
  const cloudModel = resolveOllamaCloudDefaultModel(params.model.id);
  const contextWindow = params.model.contextWindow ?? cloudModel?.contextWindow ?? 8192;
  return {
    id: params.model.id,
    name: params.model.name,
    provider: params.provider,
    api,
    baseUrl: readProviderBaseUrl(params.providerConfig) ?? "",
    reasoning: params.model.reasoning,
    input: input.length > 0 ? input : ["text"],
    cost: params.model.cost,
    contextWindow,
    ...(params.model.contextTokens !== undefined
      ? { contextTokens: params.model.contextTokens }
      : {}),
    maxTokens: params.model.maxTokens,
    ...(params.model.parameterCount !== undefined
      ? { parameterCount: params.model.parameterCount }
      : {}),
    ...(api === "ollama" && params.model.thinkingLevelMap
      ? { thinkingLevelMap: params.model.thinkingLevelMap }
      : {}),
    ...(params.model.compat ? { compat: params.model.compat } : {}),
    ...(params.model.params ? { params: params.model.params } : {}),
  };
}

export function capLocalOllamaModelContext(
  model: ModelDefinitionConfig,
  baseUrl: string,
): ModelDefinitionConfig {
  // Direct hosted routes use bare model IDs; their context is not a local KV allocation.
  if (
    isHostedOllamaCloud(baseUrl) ||
    isOllamaCloudModel(model.id) ||
    typeof model.contextWindow !== "number"
  ) {
    return model;
  }
  return {
    ...model,
    // Local Ollama allocates KV cache from num_ctx. Keep native metadata, but cap
    // setup-assistant and typical agent turns at 32k; config overlays remain authoritative.
    contextTokens: Math.min(OLLAMA_LOCAL_CONTEXT_TOKENS, model.contextWindow),
  };
}

export function capLocalOllamaProviderContext(provider: ModelProviderConfig): ModelProviderConfig {
  return {
    ...provider,
    models: provider.models?.map((model) => capLocalOllamaModelContext(model, provider.baseUrl)),
  };
}

async function fetchOllamaModelRows(params: {
  baseUrl: string;
  endpoint: "ps" | "tags";
  opts?: OllamaModelRequestOptions;
}): Promise<{ reachable: boolean; models: OllamaModelRow[] }> {
  try {
    const apiBase = resolveOllamaApiBase(params.baseUrl);
    const auditContext = `ollama-provider-models.${params.endpoint}`;
    const { response, release } = await fetchWithSsrFGuard({
      url: `${apiBase}/api/${params.endpoint}`,
      init: {
        headers: params.opts?.apiKey
          ? { Authorization: `Bearer ${params.opts.apiKey}` }
          : undefined,
      },
      // Guard-owned timeoutMs also bounds DNS/proxy preflight; init.signal does not.
      timeoutMs: Math.min(params.opts?.timeoutMs ?? OLLAMA_TAGS_TIMEOUT_MS, OLLAMA_TAGS_TIMEOUT_MS),
      ...(params.opts?.signal ? { signal: params.opts.signal } : {}),
      policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
      auditContext,
    });
    try {
      if (!response.ok) {
        // Capture can retain a cloned tee branch, so cancellation must not delay
        // the guard's bounded dispatcher release.
        void response.body?.cancel().catch(() => undefined);
        if (params.opts?.discoveryMode === "strict") {
          throw new LiveModelCatalogHttpError("ollama", response.status);
        }
        return { reachable: true, models: [] };
      }
      const data = await readProviderJsonResponse<{ models?: OllamaModelRow[] }>(
        response,
        auditContext,
      );
      const models = Array.isArray(data.models) ? data.models : undefined;
      if (params.opts?.discoveryMode === "strict" && !models) {
        throw new Error("Ollama model discovery response must contain models[]");
      }
      return { reachable: true, models: models ?? [] };
    } finally {
      await release();
    }
  } catch (error) {
    throwIfOllamaRequestAborted(params.opts?.signal);
    if (params.opts?.discoveryMode === "strict") {
      throw error;
    }
    return { reachable: false, models: [] };
  }
}

export async function fetchOllamaModels(
  baseUrl: string,
  opts?: OllamaModelRequestOptions,
): Promise<{ reachable: boolean; models: OllamaTagModel[] }> {
  const result = await fetchOllamaModelRows({ baseUrl, endpoint: "tags", opts });
  return {
    reachable: result.reachable,
    models: result.models.filter(
      (model): model is OllamaTagModel => typeof model.name === "string" && Boolean(model.name),
    ),
  };
}

export async function fetchLoadedOllamaModelNames(
  baseUrl: string,
  opts?: OllamaModelRequestOptions,
): Promise<{ reachable: boolean; models: string[] }> {
  const result = await fetchOllamaModelRows({ baseUrl, endpoint: "ps", opts });
  return {
    reachable: result.reachable,
    models: result.models
      .map((model) =>
        typeof model.name === "string"
          ? model.name.trim()
          : "model" in model && typeof model.model === "string"
            ? model.model.trim()
            : "",
      )
      .filter(Boolean),
  };
}

export async function buildOllamaProvider(
  configuredBaseUrl?: string,
  opts?: {
    apiKey?: string;
    quiet?: boolean;
    discoveryMode?: "strict";
    onListedModels?: (names: string[]) => void;
  },
): Promise<ModelProviderConfig> {
  const apiBase = resolveOllamaApiBase(configuredBaseUrl);
  const auth = opts?.apiKey ? { apiKey: opts.apiKey } : undefined;
  const { reachable, models } = await fetchOllamaModels(apiBase, opts);
  if (!reachable && !opts?.quiet) {
    console.warn(`Ollama could not be reached at ${apiBase}.`);
  }
  if (reachable) {
    opts?.onListedModels?.(models.map((model) => model.name));
  }
  const discovered = await enrichOllamaCompletionModels(apiBase, models, auth);
  return {
    baseUrl: apiBase,
    api: "ollama",
    models: discovered.map((model) =>
      buildOllamaModelDefinition(model.name, model.contextWindow, model.capabilities, {
        ...model,
        remote: isHostedOllamaCloud(apiBase) || isOllamaRemoteModel(model),
      }),
    ),
  };
}
