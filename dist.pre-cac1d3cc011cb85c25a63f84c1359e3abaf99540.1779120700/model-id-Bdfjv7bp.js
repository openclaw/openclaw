//#region extensions/fireworks/model-id.ts
function isFireworksKimiModelId(modelId) {
	const normalized = modelId.trim().toLowerCase();
	const lastSegment = normalized.split("/").pop() ?? normalized;
	return /^kimi-k2(?:p[56]|[.-][56])(?:[-_].+)?$/.test(lastSegment);
}
//#endregion
export { isFireworksKimiModelId as t };
