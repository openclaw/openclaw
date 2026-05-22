import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as parseClawHubPluginSpec } from "./clawhub-spec-CIPRxT8T.js";
import { F as parseRegistryNpmSpec } from "./discovery-CVL9-KJt.js";
//#region src/plugins/install-source-info.ts
function resolveNpmPinState(params) {
	if (params.exactVersion) return params.hasIntegrity ? "exact-with-integrity" : "exact-without-integrity";
	return params.hasIntegrity ? "floating-with-integrity" : "floating-without-integrity";
}
function resolveDefaultChoice(value) {
	return value === "clawhub" || value === "npm" || value === "local" ? value : void 0;
}
function normalizeExpectedPackageName(value) {
	const expected = normalizeOptionalString(value);
	if (!expected) return;
	return parseRegistryNpmSpec(expected)?.name ?? expected;
}
function describePluginInstallSource(install, options) {
	const clawhubSpec = normalizeOptionalString(install.clawhubSpec);
	const npmSpec = normalizeOptionalString(install.npmSpec);
	const localPath = normalizeOptionalString(install.localPath);
	const defaultChoice = resolveDefaultChoice(install.defaultChoice);
	const expectedIntegrity = normalizeOptionalString(install.expectedIntegrity);
	const expectedPackageName = normalizeExpectedPackageName(options?.expectedPackageName);
	const warnings = [];
	let clawhub;
	let npm;
	if (install.defaultChoice !== void 0 && !defaultChoice) warnings.push("invalid-default-choice");
	if (clawhubSpec) {
		const parsed = parseClawHubPluginSpec(clawhubSpec);
		if (parsed) {
			if (!parsed.version) warnings.push("clawhub-spec-floating");
			clawhub = {
				spec: clawhubSpec,
				packageName: parsed.name,
				...parsed.version ? { version: parsed.version } : {},
				exactVersion: Boolean(parsed.version)
			};
		} else warnings.push("invalid-clawhub-spec");
	}
	if (npmSpec) {
		const parsed = parseRegistryNpmSpec(npmSpec);
		if (parsed) {
			const exactVersion = parsed.selectorKind === "exact-version";
			const hasIntegrity = Boolean(expectedIntegrity);
			if (!exactVersion) warnings.push("npm-spec-floating");
			if (!hasIntegrity) warnings.push("npm-spec-missing-integrity");
			if (expectedPackageName && parsed.name !== expectedPackageName) warnings.push("npm-spec-package-name-mismatch");
			npm = {
				spec: parsed.raw,
				packageName: parsed.name,
				...expectedPackageName && parsed.name !== expectedPackageName ? { expectedPackageName } : {},
				selectorKind: parsed.selectorKind,
				exactVersion,
				pinState: resolveNpmPinState({
					exactVersion,
					hasIntegrity
				}),
				...parsed.selector ? { selector: parsed.selector } : {},
				...expectedIntegrity ? { expectedIntegrity } : {}
			};
		} else warnings.push("invalid-npm-spec");
	}
	if (defaultChoice === "clawhub" && !clawhub) warnings.push("default-choice-missing-source");
	if (defaultChoice === "npm" && !npm) warnings.push("default-choice-missing-source");
	if (defaultChoice === "local" && !localPath) warnings.push("default-choice-missing-source");
	if (expectedIntegrity && !npm) warnings.push("npm-integrity-without-source");
	return {
		...defaultChoice ? { defaultChoice } : {},
		...clawhub ? { clawhub } : {},
		...npm ? { npm } : {},
		...localPath ? { local: { path: localPath } } : {},
		warnings
	};
}
//#endregion
export { describePluginInstallSource as t };
