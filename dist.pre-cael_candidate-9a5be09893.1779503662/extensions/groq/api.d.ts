import { o as ModelCompatConfig } from "../../types.models-tqxsISRc.js";
//#region extensions/groq/api.d.ts
declare function resolveGroqReasoningCompatPatch(modelId: string): Pick<ModelCompatConfig, "supportsReasoningEffort" | "supportedReasoningEfforts" | "reasoningEffortMap"> | null;
declare function contributeGroqResolvedModelCompat(params: {
  modelId: string;
  model: {
    api?: unknown;
    provider?: unknown;
  };
}): Partial<ModelCompatConfig> | undefined;
//#endregion
export { contributeGroqResolvedModelCompat, resolveGroqReasoningCompatPatch };