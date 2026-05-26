import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
//#region src/agents/pi-embedded-runner/compact.runtime.ts
const compactRuntimeLoader = createLazyImportLoader(() => import("./compact-Dq5QH5CN.js"));
function loadCompactRuntime() {
	return compactRuntimeLoader.load();
}
async function compactEmbeddedPiSessionDirect(...args) {
	const { compactEmbeddedPiSessionDirect } = await loadCompactRuntime();
	return compactEmbeddedPiSessionDirect(...args);
}
//#endregion
export { compactEmbeddedPiSessionDirect };
