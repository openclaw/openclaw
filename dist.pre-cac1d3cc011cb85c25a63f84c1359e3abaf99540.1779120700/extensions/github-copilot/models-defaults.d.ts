import { o as ModelDefinitionConfig } from "../../types.models-BCM1Na_a.js";
//#region extensions/github-copilot/models-defaults.d.ts
declare function getDefaultCopilotModelIds(): string[];
declare function buildCopilotModelDefinition(modelId: string): ModelDefinitionConfig;
//#endregion
export { buildCopilotModelDefinition, getDefaultCopilotModelIds };