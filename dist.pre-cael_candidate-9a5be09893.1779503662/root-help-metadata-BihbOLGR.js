import { t as readCliStartupMetadata } from "./startup-metadata-CCK-kryO.js";
//#region src/cli/root-help-metadata.ts
let precomputedRootHelpText;
let precomputedBrowserHelpText;
let precomputedSecretsHelpText;
let precomputedNodesHelpText;
let precomputedSubcommandHelpText;
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
function loadPrecomputedSecretsHelpText() {
	return loadPrecomputedHelpText("secretsHelpText", precomputedSecretsHelpText, (value) => {
		precomputedSecretsHelpText = value;
	});
}
function loadPrecomputedNodesHelpText() {
	return loadPrecomputedHelpText("nodesHelpText", precomputedNodesHelpText, (value) => {
		precomputedNodesHelpText = value;
	});
}
function loadPrecomputedSubcommandHelpText(commandName) {
	if (!isPrecomputedSubcommandHelpName(commandName)) return null;
	const cache = precomputedSubcommandHelpText?.[commandName];
	if (cache !== void 0) return cache;
	try {
		const subcommandHelpText = readCliStartupMetadata(import.meta.url)?.subcommandHelpText;
		if (isSubcommandHelpTextRecord(subcommandHelpText)) {
			const value = subcommandHelpText[commandName];
			if (typeof value === "string" && value.length > 0) {
				setPrecomputedSubcommandHelpText(commandName, value);
				return value;
			}
		}
	} catch {}
	setPrecomputedSubcommandHelpText(commandName, null);
	return null;
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
function outputPrecomputedSecretsHelpText() {
	const secretsHelpText = loadPrecomputedSecretsHelpText();
	if (!secretsHelpText) return false;
	process.stdout.write(secretsHelpText);
	return true;
}
function outputPrecomputedNodesHelpText() {
	const nodesHelpText = loadPrecomputedNodesHelpText();
	if (!nodesHelpText) return false;
	process.stdout.write(nodesHelpText);
	return true;
}
function outputPrecomputedSubcommandHelpText(commandName) {
	const helpText = loadPrecomputedSubcommandHelpText(commandName);
	if (!helpText) return false;
	process.stdout.write(helpText);
	return true;
}
function isPrecomputedSubcommandHelpName(commandName) {
	return commandName === "doctor" || commandName === "gateway" || commandName === "models" || commandName === "plugins";
}
function isSubcommandHelpTextRecord(value) {
	return typeof value === "object" && value !== null;
}
function setPrecomputedSubcommandHelpText(commandName, value) {
	precomputedSubcommandHelpText = {
		...precomputedSubcommandHelpText,
		[commandName]: value
	};
}
//#endregion
export { outputPrecomputedBrowserHelpText, outputPrecomputedNodesHelpText, outputPrecomputedRootHelpText, outputPrecomputedSecretsHelpText, outputPrecomputedSubcommandHelpText };
