import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { S as requireApiKey } from "./types-core-DxqEkbXr.js";
import { d as ResolvedTtsConfig } from "./tts-runtime.types-DsGX4LDs.js";
import { s as getApiKeyForModel } from "./model-auth-BcP_r4Rt.js";
import { t as resolveModelAsync } from "./model-BhzuYXOU.js";
import { Api, Model, completeSimple } from "@earendil-works/pi-ai";

//#region src/agents/simple-completion-transport.d.ts
declare function prepareModelForSimpleCompletion<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
}): Model<Api>;
//#endregion
//#region src/tts/tts-core.d.ts
type SummarizeTextDeps = {
  completeSimple: typeof completeSimple;
  getApiKeyForModel: typeof getApiKeyForModel;
  prepareModelForSimpleCompletion: typeof prepareModelForSimpleCompletion;
  requireApiKey: typeof requireApiKey;
  resolveModelAsync: typeof resolveModelAsync;
};
type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};
declare function summarizeText(params: {
  text: string;
  targetLength: number;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  timeoutMs: number;
}, deps?: SummarizeTextDeps): Promise<SummarizeResult>;
//#endregion
export { summarizeText as t };