import { o as ModelDefinitionConfig } from "../../types.models-CkWCv1xp.js";
//#region extensions/github-copilot/models-defaults.d.ts
declare function getDefaultCopilotModelIds(): string[];
declare function buildCopilotModelDefinition(modelId: string): ModelDefinitionConfig;
//#endregion
export { buildCopilotModelDefinition, getDefaultCopilotModelIds };