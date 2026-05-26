import { o as ModelDefinitionConfig } from "./types.models-CkWCv1xp.js";
import { Sn as ProviderResolveDynamicModelContext, qn as ProviderRuntimeModel } from "./types-lCXG2pW_.js";
//#region extensions/github-copilot/models.d.ts
declare const PROVIDER_ID = "github-copilot";
declare function resolveCopilotForwardCompatModel(ctx: ProviderResolveDynamicModelContext): ProviderRuntimeModel | undefined;
type FetchCopilotModelCatalogParams = {
  /** Short-lived Copilot API token (from `resolveCopilotApiToken`). */copilotApiToken: string; /** Resolved baseUrl from the same token-exchange response. */
  baseUrl: string; /** Optional fetch override for testing. */
  fetchImpl?: typeof fetch; /** Optional AbortSignal; defaults to a 10s timeout. */
  signal?: AbortSignal;
};
/**
 * Fetch the live Copilot model catalog from `${baseUrl}/models` and project it
 * into `ModelDefinitionConfig[]`. Used by the plugin's discovery hook so the
 * runtime catalog tracks per-account entitlements + accurate context windows
 * without manifest churn.
 *
 * Filters out non-chat objects (embeddings, routers) and internal router ids.
 * On any HTTP/parse failure the caller should fall back to the static manifest
 * catalog; this function throws so the caller decides the recovery shape.
 */
declare function fetchCopilotModelCatalog(params: FetchCopilotModelCatalogParams): Promise<ModelDefinitionConfig[]>;
//#endregion
export { resolveCopilotForwardCompatModel as i, PROVIDER_ID as n, fetchCopilotModelCatalog as r, FetchCopilotModelCatalogParams as t };