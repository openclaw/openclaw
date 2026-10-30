import { normalizeLowercaseStringOrEmpty as normalizeApi } from "@openclaw/normalization-core/string-coerce";
import type { ModelCompatConfig } from "../config/types.models.js";

type ModelTransportRoute = {
  api?: unknown;
  baseUrl?: unknown;
};

export function isVllmQwenThinkingCompat(
  providerId: string,
  compat?: { thinkingFormat?: unknown } | null,
): boolean {
  return (
    providerId === "vllm" &&
    (compat?.thinkingFormat === "qwen" || compat?.thinkingFormat === "qwen-chat-template")
  );
}

export function normalizeModelTransportBaseUrl(api: string, baseUrl: string): string {
  return api === "anthropic-messages" ? baseUrl.replace(/\/v1\/?$/, "") : baseUrl;
}

export function normalizeCatalogRouteBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const url = URL.parse(value);
  if (!url) {
    return value.replace(/\/+$/u, "");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString();
}

function normalizeBaseUrl(value: unknown, api: string): string {
  return typeof value === "string"
    ? (normalizeCatalogRouteBaseUrl(normalizeModelTransportBaseUrl(api, value.trim())) ?? "")
    : "";
}

export function modelTransportRoutesMatch(
  catalogRoute: ModelTransportRoute,
  configuredRoute: ModelTransportRoute,
): boolean {
  const catalogApi = normalizeApi(catalogRoute.api);
  const configuredApi = normalizeApi(configuredRoute.api) || catalogApi;
  const catalogBaseUrl = normalizeBaseUrl(catalogRoute.baseUrl, catalogApi);
  return (
    configuredApi === catalogApi &&
    (normalizeBaseUrl(configuredRoute.baseUrl, configuredApi) || catalogBaseUrl) === catalogBaseUrl
  );
}

/** Returns one unambiguous physical catalog route for destructive config cleanup. */
export function resolveUniqueCatalogModelRoute<T extends ModelTransportRoute>(
  catalogRoutes: readonly T[] | undefined,
  configuredRoute: ModelTransportRoute,
): T | undefined {
  let match: T | undefined;
  for (const route of catalogRoutes ?? []) {
    if (!modelTransportRoutesMatch(route, configuredRoute)) {
      continue;
    }
    if (match) {
      return undefined;
    }
    match = route;
  }
  return match;
}

/** Catalogs own route defaults; operator reasoning declarations take precedence. */
export function resolveCatalogOwnedModelCompat(params: {
  catalogRoute?: ModelTransportRoute;
  catalogCompat?: ModelCompatConfig;
  configuredRoute?: ModelTransportRoute;
  configuredCompat?: ModelCompatConfig;
}): ModelCompatConfig | undefined {
  if (
    !params.catalogRoute ||
    !modelTransportRoutesMatch(params.catalogRoute, params.configuredRoute ?? {})
  ) {
    return params.configuredCompat;
  }
  const configured = params.configuredCompat;
  // Thinking-profile settings a config states explicitly win over the catalog's.
  const thinkingOverrides = Object.fromEntries(
    (
      [
        "defaultThinkingLevel",
        "adaptiveThinking",
        "thinkingRequired",
        "thinkingLevelLabels",
      ] as const
    ).flatMap((key) => (configured?.[key] === undefined ? [] : [[key, configured[key]]])),
  );
  const efforts = configured?.supportedReasoningEfforts;
  if (
    efforts === undefined &&
    configured?.supportsReasoningEffort === undefined &&
    configured?.reasoningEffortMap === undefined
  ) {
    return Object.keys(thinkingOverrides).length > 0
      ? { ...params.catalogCompat, ...thinkingOverrides }
      : params.catalogCompat;
  }
  return {
    ...params.catalogCompat,
    ...(efforts !== undefined
      ? { supportedReasoningEfforts: efforts, supportsReasoningEffort: efforts.length > 0 }
      : configured?.supportsReasoningEffort !== false &&
          (Object.keys(configured?.reasoningEffortMap ?? {}).length > 0 ||
            (configured?.supportsReasoningEffort === true &&
              params.catalogCompat?.supportedReasoningEfforts?.length === 0))
        ? { supportedReasoningEfforts: undefined, supportsReasoningEffort: true }
        : {}),
    ...(configured?.supportsReasoningEffort !== undefined
      ? { supportsReasoningEffort: configured.supportsReasoningEffort }
      : {}),
    ...(configured?.reasoningEffortMap !== undefined
      ? { reasoningEffortMap: configured.reasoningEffortMap }
      : {}),
    ...thinkingOverrides,
  };
}
