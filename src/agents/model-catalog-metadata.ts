import {
  PREPARED_THINKING_POLICY,
  type ThinkingCatalogPolicyCarrier,
} from "../plugins/provider-thinking-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { resolveCatalogOwnedModelCompat } from "./model-compat-catalog.js";

function mergeCatalogFields<T extends object>(
  base: T | undefined,
  override: T | undefined,
): T | undefined {
  return base && override ? { ...base, ...override } : (override ?? base);
}

export function normalizeCatalogRouteBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return value.replace(/\/+$/u, "");
  }
}

function catalogRouteChanges(base: ModelCatalogEntry, overlay: ModelCatalogEntry): boolean {
  if (overlay.api === undefined && overlay.baseUrl === undefined) {
    return false;
  }
  return (
    (overlay.api !== undefined && base.api !== undefined && overlay.api !== base.api) ||
    (overlay.baseUrl !== undefined &&
      base.baseUrl !== undefined &&
      normalizeCatalogRouteBaseUrl(overlay.baseUrl) !== normalizeCatalogRouteBaseUrl(base.baseUrl))
  );
}

function clearRouteBoundCatalogMetadata(
  entry: ModelCatalogEntry & ThinkingCatalogPolicyCarrier,
): ModelCatalogEntry {
  const {
    contextWindow: _contextWindow,
    contextWindows: _contextWindows,
    contextWindowDefault: _contextWindowDefault,
    contextTokens: _contextTokens,
    reasoning: _reasoning,
    configuredReasoning: _configuredReasoning,
    thinkingPolicyProvider: _thinkingPolicyProvider,
    [PREPARED_THINKING_POLICY]: _thinkingPolicy,
    thinkingLevelMap: _thinkingLevelMap,
    input: _input,
    params: _params,
    compat: _compat,
    mediaInput: _mediaInput,
    ...routeNeutral
  } = entry;
  return routeNeutral;
}

export function overlayCatalogMetadata(
  base: ModelCatalogEntry,
  overlay: ModelCatalogEntry,
  options?: {
    preserveBaseCompat?: boolean;
    /** Keep the donor transport for subsequent route projection. */
    preserveBaseRoute?: boolean;
  },
): ModelCatalogEntry {
  // Catalog rows with one logical provider/id may describe different physical
  // routes. Capabilities are atomic with their route; never carry them across
  // an API/endpoint change when the new source omits those facts.
  const routeChanged = catalogRouteChanges(base, overlay);
  const routeBase = routeChanged ? clearRouteBoundCatalogMetadata(base) : base;
  const params = mergeCatalogFields(routeBase.params, overlay.params);
  const thinkingLevelMap = overlay.thinkingLevelMap ?? routeBase.thinkingLevelMap;
  // Options + default are one normalized unit (default ∈ options): an overlay
  // that replaces the options list must also own the default, or a base default
  // absent from the new list would leak through the field-by-field merge.
  const {
    contextWindows: _baseContextWindows,
    contextWindowDefault: _baseContextWindowDefault,
    ...selectionNeutralBase
  } = routeBase;
  const contextWindowSelection =
    overlay.contextWindows !== undefined
      ? {
          contextWindows: overlay.contextWindows,
          ...(overlay.contextWindowDefault !== undefined
            ? { contextWindowDefault: overlay.contextWindowDefault }
            : {}),
        }
      : {
          ...(routeBase.contextWindows !== undefined
            ? { contextWindows: routeBase.contextWindows }
            : {}),
          ...((overlay.contextWindowDefault ?? routeBase.contextWindowDefault)
            ? {
                contextWindowDefault:
                  overlay.contextWindowDefault ?? routeBase.contextWindowDefault,
              }
            : {}),
        };
  const applyRoute = !options?.preserveBaseRoute;
  return {
    ...selectionNeutralBase,
    ...contextWindowSelection,
    ...(routeChanged ? { name: overlay.name } : {}),
    ...(applyRoute && overlay.api !== undefined ? { api: overlay.api } : {}),
    ...(applyRoute && overlay.baseUrl !== undefined ? { baseUrl: overlay.baseUrl } : {}),
    ...(overlay.contextWindow !== undefined ? { contextWindow: overlay.contextWindow } : {}),
    ...(overlay.contextTokens !== undefined ? { contextTokens: overlay.contextTokens } : {}),
    ...(overlay.reasoning !== undefined ? { reasoning: overlay.reasoning } : {}),
    ...(overlay.configuredReasoning !== undefined
      ? { configuredReasoning: overlay.configuredReasoning }
      : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(overlay.input !== undefined ? { input: overlay.input } : {}),
    ...(params ? { params } : {}),
    ...(overlay.mediaInput !== undefined ? { mediaInput: overlay.mediaInput } : {}),
    ...(overlay.providerOrder !== undefined ? { providerOrder: overlay.providerOrder } : {}),
    ...(overlay.status !== undefined ? { status: overlay.status } : {}),
    ...(overlay.statusReason !== undefined ? { statusReason: overlay.statusReason } : {}),
    ...(overlay.replaces !== undefined ? { replaces: overlay.replaces } : {}),
    ...(overlay.replacedBy !== undefined ? { replacedBy: overlay.replacedBy } : {}),
    compat: options?.preserveBaseCompat
      ? resolveCatalogOwnedModelCompat({
          catalogRoute: base,
          catalogCompat: base.compat,
          configuredRoute: {
            api: overlay.api ?? base.api,
            baseUrl: overlay.baseUrl ?? base.baseUrl,
          },
          configuredCompat: overlay.compat,
        })
      : mergeCatalogFields(routeBase.compat, overlay.compat),
  };
}
