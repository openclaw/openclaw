import { t as parseClawHubPluginSpec } from "./clawhub-spec-CIPRxT8T.js";
import { F as parseRegistryNpmSpec } from "./discovery-CVL9-KJt.js";
//#region src/plugins/install-channel-specs.ts
function isDefaultNpmSpecForBetaChannel(spec) {
	const parsed = parseRegistryNpmSpec(spec);
	if (!parsed) return null;
	if (parsed.selectorKind === "none") return { name: parsed.name };
	if (parsed.selectorKind === "tag" && parsed.selector?.toLowerCase() === "latest") return { name: parsed.name };
	return null;
}
function isDefaultClawHubSpecForBetaChannel(spec) {
	const parsed = parseClawHubPluginSpec(spec);
	if (!parsed) return null;
	if (!parsed.version || parsed.version.toLowerCase() === "latest") return { name: parsed.name };
	return null;
}
function resolveNpmInstallSpecsForUpdateChannel(params) {
	if (params.updateChannel !== "beta") return {
		installSpec: params.spec,
		recordSpec: params.spec
	};
	const betaTarget = isDefaultNpmSpecForBetaChannel(params.spec);
	if (!betaTarget) return {
		installSpec: params.spec,
		recordSpec: params.spec
	};
	const betaSpec = `${betaTarget.name}@beta`;
	return {
		installSpec: betaSpec,
		recordSpec: params.spec,
		fallbackSpec: params.spec,
		fallbackLabel: betaSpec
	};
}
function resolveClawHubInstallSpecsForUpdateChannel(params) {
	if (params.updateChannel !== "beta") return {
		installSpec: params.spec,
		recordSpec: params.spec
	};
	const betaTarget = isDefaultClawHubSpecForBetaChannel(params.spec);
	if (!betaTarget) return {
		installSpec: params.spec,
		recordSpec: params.spec
	};
	const betaSpec = `clawhub:${betaTarget.name}@beta`;
	return {
		installSpec: betaSpec,
		recordSpec: params.spec,
		fallbackSpec: params.spec,
		fallbackLabel: betaSpec
	};
}
//#endregion
export { resolveNpmInstallSpecsForUpdateChannel as n, resolveClawHubInstallSpecsForUpdateChannel as t };
