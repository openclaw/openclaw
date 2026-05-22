import { i as OpenClawConfig } from "./types.openclaw-C58U02FA.js";
import { S as requireApiKey } from "./types-core-DDZhpNYe.js";
import { d as ResolvedTtsConfig } from "./tts-runtime.types-DbIveJ6V.js";
import { a as getApiKeyForModel } from "./model-auth-CVOqM3HC.js";
import { t as resolveModelAsync } from "./model-CrBrlTkM.js";
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