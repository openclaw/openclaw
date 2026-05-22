import { t as createLazyImportLoader } from "./lazy-promise-B6on3yPt.js";
//#region src/agents/pi-embedded-runner/compact.runtime.ts
const compactRuntimeLoader = createLazyImportLoader(() => import("./compact-CSD-0Ufc.js"));
function loadCompactRuntime() {
	return compactRuntimeLoader.load();
}
async function compactEmbeddedPiSessionDirect(...args) {
	const { compactEmbeddedPiSessionDirect } = await loadCompactRuntime();
	return compactEmbeddedPiSessionDirect(...args);
}
//#endregion
export { compactEmbeddedPiSessionDirect };
