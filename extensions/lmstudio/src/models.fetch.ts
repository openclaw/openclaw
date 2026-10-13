import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { LiveModelCatalogHttpError } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  readProviderJsonArrayFieldResponse,
  readProviderJsonResponse,
  redactProviderResponseErrorText,
} from "openclaw/plugin-sdk/provider-http";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { readResponseTextPrefix } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { asPositiveSafeInteger, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH } from "./defaults.js";
import {
  mapLmstudioWireModels,
  resolveLmstudioCanonicalModelKey,
  resolveLmstudioServerBase,
  resolveLoadedContextWindow,
  type LmstudioModelWire,
} from "./models.js";
import { buildLmstudioAuthHeaders } from "./runtime.js";

const log = createSubsystemLogger("extensions/lmstudio/models");
const LMSTUDIO_ERROR_BODY_LIMIT_BYTES = 8 * 1024;

function redactLmstudioLoadError(value: string, headers: Record<string, string> | undefined) {
  return redactProviderResponseErrorText(
    value,
    Object.fromEntries(
      Object.entries(headers ?? {})
        .filter(([name]) => name.toLowerCase() !== "content-type")
        .map(([name, header]) => [name, header.trim()]),
    ),
  );
}

type LmstudioLoadResponse = {
  status?: string;
  instance_id?: string;
};

export class LmstudioModelLoadError extends Error {
  constructor(
    readonly resolvedModelKey: string,
    readonly requiredContextLength: number | undefined,
    cause: unknown,
  ) {
    super(
      requiredContextLength === undefined
        ? cause instanceof Error
          ? cause.message
          : String(cause)
        : `LM Studio could not load "${resolvedModelKey}" with ${requiredContextLength} context tokens. Wait for loading to finish in LM Studio, then retry, or lower the model's contextTokens.`,
      { cause },
    );
  }
}

type FetchLmstudioModelsResult = {
  reachable: boolean;
  status?: number;
  models: LmstudioModelWire[];
  error?: unknown;
};

type DiscoverLmstudioModelsParams = {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  quiet: boolean;
  discoveryMode?: "strict";
  fetchImpl?: typeof fetch;
};

async function fetchLmstudioEndpoint(params: {
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  ssrfPolicy?: SsrFPolicy;
  auditContext: string;
  signal?: AbortSignal;
}): Promise<{ response: Response; release: () => Promise<void> }> {
  params.signal?.throwIfAborted();
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  let response: Response;
  let release: () => Promise<void>;
  if (params.ssrfPolicy) {
    const guarded = await fetchWithSsrFGuard({
      url: params.url,
      init: params.init,
      timeoutMs,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
      policy: params.ssrfPolicy,
      auditContext: params.auditContext,
    });
    response = guarded.response;
    release = guarded.release;
  } else {
    const fetchFn = params.fetchImpl ?? fetch;
    response = await fetchFn(params.url, {
      ...params.init,
      signal: params.signal
        ? AbortSignal.any([params.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    release = async () => undefined;
  }
  return {
    response,
    release: async () => {
      // A capture tee must not delay the guard's bounded dispatcher release.
      if (!response.bodyUsed) {
        void response.body?.cancel().catch(() => undefined);
      }
      await release();
    },
  };
}

/** Fetches /api/v1/models and reports transport reachability separately from HTTP status. */
export async function fetchLmstudioModels(params: {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<FetchLmstudioModelsResult> {
  const baseUrl = resolveLmstudioServerBase(params.baseUrl);
  const timeoutMs = params.timeoutMs ?? 5000;
  try {
    const { response, release } = await fetchLmstudioEndpoint({
      url: `${baseUrl}/api/v1/models`,
      init: {
        headers: buildLmstudioAuthHeaders({
          apiKey: params.apiKey,
          headers: params.headers,
        }),
      },
      timeoutMs,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
      ssrfPolicy: params.ssrfPolicy,
      auditContext: "lmstudio-model-discovery",
    });
    try {
      if (!response.ok) {
        return {
          reachable: true,
          status: response.status,
          models: [],
        };
      }
      const models = await readProviderJsonArrayFieldResponse(
        response,
        "LM Studio model list",
        "models",
      );
      const validModels = models.filter(isRecord);
      if (models.length > 0 && validModels.length === 0) {
        throw new Error("LM Studio model list: malformed JSON response");
      }
      return {
        reachable: true,
        status: response.status,
        models: validModels,
      };
    } finally {
      await release();
    }
  } catch (error) {
    return {
      reachable: false,
      models: [],
      error,
    };
  }
}

export async function discoverLmstudioModels(
  params: DiscoverLmstudioModelsParams,
): Promise<ModelDefinitionConfig[]> {
  const fetched = await fetchLmstudioModels({
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    headers: params.headers,
    fetchImpl: params.fetchImpl,
  });
  const quiet = params.quiet;
  if (!fetched.reachable || (fetched.status !== undefined && fetched.status >= 400)) {
    const error =
      fetched.status === undefined
        ? fetched.error
        : new LiveModelCatalogHttpError("lmstudio", fetched.status);
    if (params.discoveryMode === "strict") {
      throw error;
    }
    if (!quiet) {
      log.debug(`Failed to discover LM Studio models: ${String(error)}`);
    }
    return [];
  }

  return mapLmstudioWireModels(fetched.models, "runtime");
}

type LmstudioModelLoadParams = {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  modelKey: string;
  requestedContextLength?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export type LmstudioPreparedModel = {
  modelKey: string;
  instanceId?: string;
};

/** Keeps the public model/cache identity stable for embedding and SDK callers. */
export async function ensureLmstudioModelLoaded(params: LmstudioModelLoadParams): Promise<string> {
  return (await prepareLmstudioModelForInference(params)).modelKey;
}

export async function prepareLmstudioModelForInference(
  params: LmstudioModelLoadParams,
): Promise<LmstudioPreparedModel> {
  const modelKey = params.modelKey.trim();
  if (!modelKey) {
    throw new Error("LM Studio model key is required");
  }

  const timeoutMs = params.timeoutMs ?? 120_000;
  const baseUrl = resolveLmstudioServerBase(params.baseUrl);
  const preflight = await fetchLmstudioModels({
    baseUrl,
    apiKey: params.apiKey,
    headers: params.headers,
    ssrfPolicy: params.ssrfPolicy,
    timeoutMs,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  params.signal?.throwIfAborted();
  if (!preflight.reachable) {
    throw new Error(`LM Studio model discovery failed: ${String(preflight.error)}`);
  }
  if (preflight.status !== undefined && preflight.status >= 400) {
    throw new Error(`LM Studio model discovery failed (${preflight.status})`);
  }
  const canonicalModelKey = resolveLmstudioCanonicalModelKey({
    modelKey,
    models: preflight.models,
  });
  const matchingModel = preflight.models.find((entry) => entry.key?.trim() === canonicalModelKey);
  const loadedContextWindow = matchingModel ? resolveLoadedContextWindow(matchingModel) : null;
  const advertisedContextLimit = asPositiveSafeInteger(matchingModel?.max_context_length) ?? null;
  const requestedContextLength = asPositiveSafeInteger(params.requestedContextLength) ?? null;
  const contextLengthForLoad =
    advertisedContextLimit === null
      ? (requestedContextLength ?? LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH)
      : Math.min(
          requestedContextLength ?? LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH,
          advertisedContextLimit,
        );
  if (loadedContextWindow !== null && loadedContextWindow >= contextLengthForLoad) {
    const instances = Array.isArray(matchingModel?.loaded_instances)
      ? matchingModel.loaded_instances
      : [];
    const instance = instances.find(
      (entry) =>
        typeof entry?.id === "string" &&
        entry.id.trim().length > 0 &&
        (asPositiveSafeInteger(entry.config?.context_length) ?? 0) >= contextLengthForLoad,
    );
    return { modelKey: canonicalModelKey, instanceId: instance?.id?.trim() };
  }

  try {
    const requestHeaders = buildLmstudioAuthHeaders({
      apiKey: params.apiKey,
      headers: params.headers,
      json: true,
    });
    const { response, release } = await fetchLmstudioEndpoint({
      url: `${baseUrl}/api/v1/models/load`,
      init: {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          model: canonicalModelKey,
          // Ask LM Studio to load with our default target, capped to the model's own limit.
          context_length: contextLengthForLoad,
        }),
      },
      timeoutMs,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
      ssrfPolicy: params.ssrfPolicy,
      auditContext: "lmstudio-model-load",
    });
    try {
      if (!response.ok) {
        const bodyRead = await readResponseTextPrefix(response, LMSTUDIO_ERROR_BODY_LIMIT_BYTES, {
          chunkTimeoutMs: 10_000,
        });
        // A truncated credential cannot be identified safely; drop the entire diagnostic.
        const detail = bodyRead.truncated
          ? ""
          : redactLmstudioLoadError(bodyRead.text, requestHeaders);
        throw new Error(
          `LM Studio model load failed (${response.status})${detail ? `: ${detail}` : ""}`,
        );
      }
      // Read the success body through the shared byte-capped reader so a misbehaving
      // or compromised LM Studio server cannot stream an unbounded JSON payload into
      // memory before we parse it. Malformed JSON is wrapped with our own label.
      const payload = await readProviderJsonResponse<LmstudioLoadResponse>(
        response,
        "LM Studio model load",
      );
      if (typeof payload.status === "string" && payload.status.toLowerCase() !== "loaded") {
        const status = redactLmstudioLoadError(payload.status, requestHeaders);
        throw new Error(`LM Studio model load returned unexpected status: ${status}`);
      }
      return {
        modelKey: canonicalModelKey,
        instanceId:
          typeof payload.instance_id === "string"
            ? payload.instance_id.trim() || undefined
            : undefined,
      };
    } finally {
      await release();
    }
  } catch (error) {
    throw new LmstudioModelLoadError(
      canonicalModelKey,
      loadedContextWindow === null ? undefined : contextLengthForLoad,
      error,
    );
  }
}
