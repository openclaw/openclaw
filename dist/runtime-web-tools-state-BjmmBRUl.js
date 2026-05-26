//#region src/secrets/runtime-web-tools-state.ts
let activeRuntimeWebToolsMetadata = null;
function clearActiveRuntimeWebToolsMetadata() {
	activeRuntimeWebToolsMetadata = null;
}
function setActiveRuntimeWebToolsMetadata(metadata) {
	activeRuntimeWebToolsMetadata = structuredClone(metadata);
}
function getActiveRuntimeWebToolsMetadata() {
	if (!activeRuntimeWebToolsMetadata) return null;
	return structuredClone(activeRuntimeWebToolsMetadata);
}
//#endregion
export { getActiveRuntimeWebToolsMetadata as n, setActiveRuntimeWebToolsMetadata as r, clearActiveRuntimeWebToolsMetadata as t };
