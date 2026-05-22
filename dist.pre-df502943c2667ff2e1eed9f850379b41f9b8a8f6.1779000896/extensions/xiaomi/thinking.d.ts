import { qn as ProviderThinkingProfile } from "../../types-DdGVOQ6y.js";
//#region extensions/xiaomi/thinking.d.ts
declare function isMiMoReasoningModelId(modelId: string): boolean;
declare function isMiMoReasoningModelRef(model: {
  provider?: string;
  id?: unknown;
}): boolean;
declare function resolveMiMoThinkingProfile(modelId: string): ProviderThinkingProfile | undefined;
//#endregion
export { isMiMoReasoningModelId, isMiMoReasoningModelRef, resolveMiMoThinkingProfile };