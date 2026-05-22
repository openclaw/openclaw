import { o as ModelDefinitionConfig } from "../../types.models-fxeqhDwC.js";
//#region extensions/github-copilot/model-metadata.d.ts
declare function resolveCopilotTransportApi(modelId: string): "anthropic-messages" | "openai-responses";
declare function resolveStaticCopilotModelOverride(modelId: string): Partial<ModelDefinitionConfig> | undefined;
//#endregion
export { resolveCopilotTransportApi, resolveStaticCopilotModelOverride };