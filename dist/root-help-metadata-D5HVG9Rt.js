import { t as readCliStartupMetadata } from "./startup-metadata-DGYmfh8l.js";
//#region src/cli/root-help-metadata.ts
let precomputedRootHelpText;
let precomputedBrowserHelpText;
function loadPrecomputedHelpText(key, cache, setCache) {
	if (cache !== void 0) return cache;
	try {
		const parsed = readCliStartupMetadata(import.meta.url);
		if (parsed) {
			const value = parsed[key];
			if (typeof value === "string" && value.length > 0) {
				setCache(value);
				return value;
			}
		}
	} catch {}
	setCache(null);
	return null;
}
function loadPrecomputedRootHelpText() {
	return loadPrecomputedHelpText("rootHelpText", precomputedRootHelpText, (value) => {
		precomputedRootHelpText = value;
	});
}
function loadPrecomputedBrowserHelpText() {
	return loadPrecomputedHelpText("browserHelpText", precomputedBrowserHelpText, (value) => {
		precomputedBrowserHelpText = value;
	});
}
function outputPrecomputedRootHelpText() {
	const rootHelpText = loadPrecomputedRootHelpText();
	if (!rootHelpText) return false;
	process.stdout.write(rootHelpText);
	return true;
}
function outputPrecomputedBrowserHelpText() {
	const browserHelpText = loadPrecomputedBrowserHelpText();
	if (!browserHelpText) return false;
	process.stdout.write(browserHelpText);
	return true;
}
//#endregion
export { outputPrecomputedBrowserHelpText, outputPrecomputedRootHelpText };
