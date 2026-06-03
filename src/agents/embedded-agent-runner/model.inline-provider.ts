import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.js";
import { normalizeGoogleApiBaseUrl } from "../../infra/google-api-base-url.js";
import type { Api } from "../../llm/types.js";
import { isSecretRefHeaderValueMarker } from "../model-auth-markers.js";
import { attachModelProviderLocalService } from "../provider-local-service.js";
import {
  attachModelProviderRequestTransport,
  resolveProviderRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "../provider-request-config.js";

export type InlineModelEntry = Omit<ModelDefinitionConfig, "api"> & {
  api?: Api;
  provider: string;
  baseUrl?: string;
  headers?: Record<string, string>;
};

export type InlineProviderConfig = {
  baseUrl?: string;
  api?: ModelDefinitionConfig["api"];
  models?: ModelDefinitionConfig[];
  contextWindow?: ModelProviderConfig["contextWindow"];
  contextTokens?: ModelProviderConfig["contextTokens"];
  maxTokens?: ModelProviderConfig["maxTokens"];
  params?: ModelProviderConfig["params"];
  headers?: unknown;
  authHeader?: boolean;
  timeoutSeconds?: ModelProviderConfig["timeoutSeconds"];
  request?: ModelProviderConfig["request"];
  localService?: ModelProviderConfig["localService"];
};

/** Normalizes configured transport API ids into the subset supported by inline providers. */
export function normalizeResolvedTransportApi(
  api: unknown,
): ModelDefinitionConfig["api"] | undefined {
  switch (api) {
    case "anthropic-messages":
    case "bedrock-converse-stream":
    case "github-copilot":
    case "google-generative-ai":
    case "google-vertex":
    case "ollama":
    case "openai-chatgpt-responses":
    case "openai-completions":
    case "openai-responses":
    case "azure-openai-responses":
      return api;
    default:
      return undefined;
  }
}

/** Keeps only string model headers, optionally dropping unresolved secret-ref placeholders. */
export function sanitizeModelHeaders(
  headers: unknown,
  opts?: { stripSecretRefMarkers?: boolean },
): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") {
      continue;
    }
    if (opts?.stripSecretRefMarkers && isSecretRefHeaderValueMarker(headerValue)) {
      continue;
    }
    next[headerName] = headerValue;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function isLegacyFoundryVisionModelCandidate(params: {
  provider?: string;
  modelId?: string;
  modelName?: string;
}): boolean {
  if (normalizeOptionalLowercaseString(params.provider) !== "microsoft-foundry") {
    return false;
  }
  const normalizedCandidates = [params.modelId, params.modelName]
    .filter((value): value is string => typeof value === "string")
    .map((value) => normalizeOptionalLowercaseString(value))
    .filter((value): value is string => Boolean(value));
  // Older Foundry OpenAI-family entries omitted `image` input even though these
  // models accept vision payloads; keep them usable until provider catalogs
  // consistently declare model.input.
  return normalizedCandidates.some(
    (candidate) =>
      candidate.startsWith("gpt-") ||
      candidate.startsWith("o1") ||
      candidate.startsWith("o3") ||
      candidate.startsWith("o4") ||
      candidate === "computer-use-preview",
  );
}

/** Resolves a model's declared input modes with legacy Foundry vision compatibility. */
export function resolveProviderModelInput(params: {
  provider?: string;
  modelId?: string;
  modelName?: string;
  input?: unknown;
  fallbackInput?: unknown;
}): Array<"text" | "image"> {
  const resolvedInput = Array.isArray(params.input) ? params.input : params.fallbackInput;
  const normalizedInput = Array.isArray(resolvedInput)
    ? resolvedInput.filter((item): item is "text" | "image" => item === "text" || item === "image")
    : [];
  if (
    normalizedInput.length > 0 &&
    !normalizedInput.includes("image") &&
    isLegacyFoundryVisionModelCandidate(params)
  ) {
    return ["text", "image"];
  }
  return normalizedInput.length > 0 ? normalizedInput : ["text"];
}

function resolveInlineProviderTransport(params: { api?: Api | null; baseUrl?: string }): {
  api?: Api;
  baseUrl?: string;
} {
  const api = normalizeResolvedTransportApi(params.api);
  return {
    api,
    baseUrl:
      api === "google-generative-ai" ? normalizeGoogleApiBaseUrl(params.baseUrl) : params.baseUrl,
  };
}

/** Expands inline provider configs into model entries with inherited transport/request settings. */
export function buildInlineProviderModels(
  providers: Record<string, InlineProviderConfig>,
): InlineModelEntry[] {
  return Object.entries(providers).flatMap(([providerId, entry]) => {
    const trimmed = providerId.trim();
    if (!trimmed) {
      return [];
    }
    const providerHeaders = sanitizeModelHeaders(entry?.headers, {
      stripSecretRefMarkers: true,
    });
    const providerRequest = sanitizeConfiguredModelProviderRequest(entry?.request);
    return (entry?.models ?? []).map((model) => {
      const transport = resolveInlineProviderTransport({
        api: model.api ?? entry?.api,
        baseUrl: (model as InlineModelEntry).baseUrl ?? entry?.baseUrl,
      });
      const modelHeaders = sanitizeModelHeaders((model as InlineModelEntry).headers, {
        stripSecretRefMarkers: true,
      });
      const requestConfig = resolveProviderRequestConfig({
        provider: trimmed,
        api: transport.api ?? model.api,
        baseUrl: transport.baseUrl,
        providerHeaders,
        modelHeaders,
        authHeader: entry?.authHeader,
        request: providerRequest,
        capability: "llm",
        transport: "stream",
      });
      return attachModelProviderLocalService(
        attachModelProviderRequestTransport(
          {
            ...model,
            contextWindow: model.contextWindow ?? entry?.contextWindow,
            contextTokens: model.contextTokens ?? entry?.contextTokens,
            maxTokens: model.maxTokens ?? entry?.maxTokens,
            input: resolveProviderModelInput({
              provider: trimmed,
              modelId: model.id,
              modelName: model.name,
              input: model.input,
            }),
            provider: trimmed,
            baseUrl: requestConfig.baseUrl ?? transport.baseUrl,
            api: requestConfig.api ?? model.api,
            headers: requestConfig.headers,
          },
          providerRequest,
        ),
        entry?.localService,
      );
    });
  });
}
