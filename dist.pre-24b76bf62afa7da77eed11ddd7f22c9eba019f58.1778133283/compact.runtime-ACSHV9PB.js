import { t as createLazyImportLoader } from "./lazy-promise-AiZRy56y.js";
//#region src/agents/pi-embedded-runner/compact.runtime.ts
const compactRuntimeLoader = createLazyImportLoader(() => import("./compact-geLMK9He.js"));
function loadCompactRuntime() {
	return compactRuntimeLoader.load();
}
async function compactEmbeddedPiSessionDirect(...args) {
	const { compactEmbeddedPiSessionDirect } = await loadCompactRuntime();
	return compactEmbeddedPiSessionDirect(...args);
}
//#endregion
export { compactEmbeddedPiSessionDirect };
