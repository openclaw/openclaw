import { Sn as ProviderResolveDynamicModelContext } from "./types-lCXG2pW_.js";
import * as _$_earendil_works_pi_ai0 from "@earendil-works/pi-ai";

//#region extensions/xai/provider-models.d.ts
declare function isModernXaiModel(modelId: string): boolean;
declare function resolveXaiForwardCompatModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
}): (_$_earendil_works_pi_ai0.Model<_$_earendil_works_pi_ai0.Api> & {
  thinkingLevelMap: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;
}) | undefined;
//#endregion
export { resolveXaiForwardCompatModel as n, isModernXaiModel as t };