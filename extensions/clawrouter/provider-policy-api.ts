import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import type {
  ProviderFastModePolicyContext,
  ProviderNativeWebSearchPolicyContext,
  ProviderResponseModelEquivalenceContext,
} from "openclaw/plugin-sdk/provider-model-types";
import {
  asOptionalRecord,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export const CLAWROUTER_ROUTE_METADATA_KEY = "clawrouterRoute";

/**
 * Routed ids are `<vendor>/<upstream>`; the upstream reports its own id without the vendor
 * namespace. Any other response id, or a different vendor, is a real reroute.
 */
export function isResponseModelEquivalent(params: ProviderResponseModelEquivalenceContext) {
  if (params.provider.trim().toLowerCase() !== "clawrouter") {
    return false;
  }
  const separator = params.requestedModelId.indexOf("/");
  const upstream = separator > 0 ? params.requestedModelId.slice(separator + 1) : "";
  return upstream.length > 0 && params.responseModelId === upstream;
}

/** Catalog support and per-key admission apply only to the exact resolved route. */
export function resolveNativeWebSearch(ctx: ProviderNativeWebSearchPolicyContext): boolean {
  const searchProvider = ctx.config?.tools?.web?.search?.provider?.trim().toLowerCase();
  const route = asOptionalRecord(ctx.modelParams?.[CLAWROUTER_ROUTE_METADATA_KEY]);
  return (
    ctx.provider === "clawrouter" &&
    ctx.config?.tools?.web?.search?.enabled !== false &&
    (!searchProvider || searchProvider === "auto" || searchProvider === "openai") &&
    ctx.api === "openai-responses" &&
    route?.api === ctx.api &&
    route.baseUrl === ctx.baseUrl &&
    route.hostedWebSearch === true
  );
}

// Catalog tier facts belong to the exact selected route, never a model-name guess.
export function resolveClawRouterServiceTiers(
  model: Pick<ProviderRuntimeModel, "api" | "baseUrl" | "params">,
): string[] | undefined {
  const route = asOptionalRecord(model.params?.[CLAWROUTER_ROUTE_METADATA_KEY]);
  if (
    model.api !== "openai-responses" ||
    route?.api !== model.api ||
    route.baseUrl !== model.baseUrl
  ) {
    return undefined;
  }
  const tiers = normalizeTrimmedStringList(route.serviceTiers);
  return tiers.length > 0 ? tiers : undefined;
}

export function resolveServiceTiers(
  ctx: ProviderFastModePolicyContext,
): readonly string[] | undefined {
  if (ctx.provider !== "clawrouter" || ctx.runtimeId !== "openclaw") {
    return undefined;
  }
  return resolveClawRouterServiceTiers({
    api: ctx.api ?? "",
    baseUrl: ctx.baseUrl ?? "",
    params: ctx.modelParams,
  });
}

export function resolveFastModeSupport(ctx: ProviderFastModePolicyContext): boolean | undefined {
  if (ctx.runtimeId !== "openclaw") {
    return undefined;
  }
  return resolveServiceTiers(ctx)?.includes("priority") ?? false;
}
