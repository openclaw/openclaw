//#region extensions/openrouter/models.d.ts
declare function normalizeOpenRouterModelId(modelId: unknown): string | undefined;
declare function isOpenRouterDeepSeekV4ModelId(modelId: unknown): boolean;
//#endregion
export { isOpenRouterDeepSeekV4ModelId, normalizeOpenRouterModelId };