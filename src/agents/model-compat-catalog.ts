import { ownsThinkingProfile } from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeLowercaseStringOrEmpty as normalizeApi } from "@openclaw/normalization-core/string-coerce";
import type { ModelCompatConfig } from "../config/zod-schema.model-compat.js";

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

function normalizeBaseUrl(value: string, api: string): string {
  return normalizeCatalogRouteBaseUrl(normalizeModelTransportBaseUrl(api, value)) ?? "";
}

export function modelTransportRoutesMatch(
  catalogRoute: ModelTransportRoute,
  configuredRoute: ModelTransportRoute,
): boolean {
  const catalogApi = normalizeApi(catalogRoute.api);
  const configuredApi = normalizeApi(configuredRoute.api) || catalogApi;
  if (configuredApi !== catalogApi) {
    return false;
  }
  const catalogUrl = typeof catalogRoute.baseUrl === "string" ? catalogRoute.baseUrl.trim() : "";
  const configuredUrl =
    typeof configuredRoute.baseUrl === "string" ? configuredRoute.baseUrl.trim() : "";
  // Catalog rows commonly inherit the same endpoint. Equality needs no URL objects;
  // distinct spellings still use canonical transport normalization below.
  if (!configuredUrl || configuredUrl === catalogUrl) {
    return true;
  }
  const catalogBaseUrl = normalizeBaseUrl(catalogUrl, catalogApi);
  return (normalizeBaseUrl(configuredUrl, configuredApi) || catalogBaseUrl) === catalogBaseUrl;
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

/**
 * Configured effort facts (list, map or support flag) replace a profile the catalog row owns,
 * unless config states its own ladder or default, so the provider derives the ladder from them.
 */
export function withoutOverriddenThinkingProfile(
  catalogCompat: ModelCompatConfig | undefined,
  configuredCompat: ModelCompatConfig | undefined,
): ModelCompatConfig | undefined {
  const declaresEfforts =
    configuredCompat?.supportedReasoningEfforts !== undefined ||
    configuredCompat?.supportsReasoningEffort !== undefined ||
    configuredCompat?.reasoningEffortMap !== undefined;
  if (!catalogCompat || !declaresEfforts || ownsThinkingProfile(configuredCompat)) {
    return catalogCompat;
  }
  const { defaultThinkingLevel: _default, thinkingLevels: _levels, ...rest } = catalogCompat;
  return rest;
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
        "thinkingLevels",
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
    ...withoutOverriddenThinkingProfile(params.catalogCompat, configured),
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
