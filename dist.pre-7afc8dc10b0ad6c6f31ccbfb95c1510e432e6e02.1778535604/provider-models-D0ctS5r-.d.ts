import { mn as ProviderResolveDynamicModelContext } from "./types-DaukV8xd.js";
import * as _$_mariozechner_pi_ai0 from "@mariozechner/pi-ai";

//#region extensions/xai/provider-models.d.ts
declare function isModernXaiModel(modelId: string): boolean;
declare function resolveXaiForwardCompatModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
}): (_$_mariozechner_pi_ai0.Model<_$_mariozechner_pi_ai0.Api> & {
  thinkingLevelMap: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;
}) | undefined;
//#endregion
export { resolveXaiForwardCompatModel as n, isModernXaiModel as t };