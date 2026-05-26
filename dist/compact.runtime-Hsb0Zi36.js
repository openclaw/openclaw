import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
//#region src/agents/pi-embedded-runner/compact.runtime.ts
const compactRuntimeLoader = createLazyImportLoader(() => import("./compact-beC9OyiD.js"));
function loadCompactRuntime() {
	return compactRuntimeLoader.load();
}
async function compactEmbeddedPiSessionDirect(...args) {
	const { compactEmbeddedPiSessionDirect } = await loadCompactRuntime();
	return compactEmbeddedPiSessionDirect(...args);
}
//#endregion
export { compactEmbeddedPiSessionDirect };
