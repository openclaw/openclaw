import { t as createLazyImportLoader } from "./lazy-promise-BWWZqHu4.js";
//#region src/agents/pi-embedded-runner/compact.runtime.ts
const compactRuntimeLoader = createLazyImportLoader(() => import("./compact-XOxkFwp4.js"));
function loadCompactRuntime() {
	return compactRuntimeLoader.load();
}
async function compactEmbeddedPiSessionDirect(...args) {
	const { compactEmbeddedPiSessionDirect } = await loadCompactRuntime();
	return compactEmbeddedPiSessionDirect(...args);
}
//#endregion
export { compactEmbeddedPiSessionDirect };
