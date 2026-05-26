import { s as ModelDefinitionConfig } from "../../types.models-tqxsISRc.js";
//#region extensions/github-copilot/model-metadata.d.ts
type CopilotRuntimeApi = "anthropic-messages" | "openai-completions" | "openai-responses";
declare function resolveCopilotTransportApi(modelId: string): CopilotRuntimeApi;
declare function resolveCopilotModelCompat(modelId: string): ModelDefinitionConfig["compat"] | undefined;
declare function resolveStaticCopilotModelOverride(modelId: string): Partial<ModelDefinitionConfig> | undefined;
//#endregion
export { resolveCopilotModelCompat, resolveCopilotTransportApi, resolveStaticCopilotModelOverride };