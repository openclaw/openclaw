import { Dn as ProviderResolveDynamicModelContext } from "./types-WgmX6DKe.js";
//#region extensions/xai/provider-models.d.ts
declare function isModernXaiModel(modelId: string): boolean;
declare function resolveXaiForwardCompatModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
}): (import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api> & {
  compat: Record<string, unknown>;
  thinkingLevelMap: Partial<Record<"off" | "minimal" | "high" | "low" | "medium" | "xhigh", string | null>>;
}) | undefined;
//#endregion
export { resolveXaiForwardCompatModel as n, isModernXaiModel as t };