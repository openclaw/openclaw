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

/**
 * Operator replay preferences that live in `compat` but describe no endpoint capability, so a
 * provider catalog never owns them and cannot supply a replacement value.
 */
export const OPERATOR_OWNED_MODEL_COMPAT_KEYS = ["appendOnlyRuntimeContext"] as const;

function withOperatorOwnedCompat(
  catalogCompat: ModelCompatConfig | undefined,
  configuredCompat: ModelCompatConfig | undefined,
): ModelCompatConfig | undefined {
  const operatorOwned: ModelCompatConfig = {};
  for (const key of OPERATOR_OWNED_MODEL_COMPAT_KEYS) {
    const value = configuredCompat?.[key];
    if (value !== undefined) {
      operatorOwned[key] = value;
    }
  }
  return Object.keys(operatorOwned).length > 0
    ? { ...catalogCompat, ...operatorOwned }
    : catalogCompat;
}

/** Capabilities belong to the catalog route; config owns them only for a different/custom route. */
export function resolveCatalogOwnedModelCompat(params: {
  catalogRoute?: ModelTransportRoute;
  catalogCompat?: ModelCompatConfig;
  configuredRoute?: ModelTransportRoute;
  configuredCompat?: ModelCompatConfig;
}): ModelCompatConfig | undefined {
  if (!params.catalogRoute) {
    return params.configuredCompat;
  }
  return modelTransportRoutesMatch(params.catalogRoute, params.configuredRoute ?? {})
    ? withOperatorOwnedCompat(params.catalogCompat, params.configuredCompat)
    : params.configuredCompat;
}
