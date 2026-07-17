import { OPENCLAW_LOCALES, OPENCLAW_LOCALE_REGISTRY_REVISION } from "./locale-registry.mjs";
//#region src/coverage.ts
const LOCALIZATION_MATURITY_STATES = [
	"source",
	"complete",
	"partial",
	"experimental",
	"platform-constrained",
	"unsupported"
];
const LOCALIZATION_CONTENT_CLASSES = [
	"general",
	"safety",
	"security",
	"authentication",
	"authorization",
	"destructive-action",
	"privacy",
	"recovery",
	"generated"
];
const LOCALIZATION_CHECKS = [
	"key-parity",
	"placeholder-parity",
	"fallback-reporting",
	"namespace-ownership",
	"locale-state-isolation",
	"hardcoded-string-inventory",
	"generated-artifact-parity",
	"human-review-attestation"
];
const REQUIRED_LOCALIZATION_SURFACES = [
	"control-ui",
	"cli-onboarding",
	"channel-plugin-setup",
	"cli",
	"tui",
	"runtime",
	"gateway-errors",
	"server-rendered-channels",
	"command-metadata",
	"telegram-command-menu",
	"discord-command-menu",
	"skill-metadata",
	"android",
	"apple",
	"docs"
];
const MATURITY_STATES = new Set(LOCALIZATION_MATURITY_STATES);
const CONTENT_CLASSES = new Set(LOCALIZATION_CONTENT_CLASSES);
const CHECKS = new Set(LOCALIZATION_CHECKS);
const SENSITIVE_CONTENT_CLASSES = new Set([
	"safety",
	"security",
	"authentication",
	"authorization",
	"destructive-action",
	"privacy",
	"recovery"
]);
const BASE_COMPLETE_CHECKS = [
	"key-parity",
	"placeholder-parity",
	"fallback-reporting",
	"namespace-ownership",
	"locale-state-isolation",
	"hardcoded-string-inventory"
];
function validateLocalizationCoverageManifest(value) {
	const issues = [];
	if (!isRecord(value)) return [issue("$", "Manifest must be an object.")];
	if (value.version !== 1) issues.push(issue("version", "Version must be 1."));
	if (value.registryRevision !== "sha256:f1fc485ce67ea02b74c69e63e648da3fddc51e276d507a2eeb21d49a18898207") issues.push(issue("registryRevision", `Expected locale registry revision ${OPENCLAW_LOCALE_REGISTRY_REVISION}.`));
	if (typeof value.localeRegistry !== "string" || !value.localeRegistry.trim()) issues.push(issue("localeRegistry", "Locale registry path is required."));
	validateFixtures(value.testFixtures, issues);
	validateSurfaces(value.surfaces, issues);
	return Object.freeze(issues.map((entry) => Object.freeze(entry)));
}
function requiredChecksForSurface(surface) {
	if (!Object.values(surface.locales).some((state) => isRecord(state) && state.maturity === "complete")) return [];
	const required = new Set(BASE_COMPLETE_CHECKS);
	if (surface.contentClasses.includes("generated")) required.add("generated-artifact-parity");
	if (surface.contentClasses.some((contentClass) => SENSITIVE_CONTENT_CLASSES.has(contentClass))) required.add("human-review-attestation");
	return [...required].toSorted();
}
function validateFixtures(value, issues) {
	if (!isRecord(value)) {
		issues.push(issue("testFixtures", "Test fixtures must be an object."));
		return;
	}
	for (const [fixtureId, fixture] of Object.entries(value)) {
		const path = `testFixtures.${fixtureId}`;
		if (OPENCLAW_LOCALES.includes(fixtureId)) issues.push(issue(path, "Release locale IDs cannot be reused as test fixture IDs."));
		if (!isRecord(fixture)) {
			issues.push(issue(path, "Fixture must be an object."));
			continue;
		}
		if (![
			"expansion",
			"bidirectional",
			"shaping",
			"segmentation"
		].includes(String(fixture.kind))) issues.push(issue(`${path}.kind`, "Unknown fixture kind."));
		if (fixture.direction !== "ltr" && fixture.direction !== "rtl") issues.push(issue(`${path}.direction`, "Direction must be ltr or rtl."));
	}
}
function validateSurfaces(value, issues) {
	if (!isRecord(value)) {
		issues.push(issue("surfaces", "Surfaces must be an object."));
		return;
	}
	for (const surfaceId of REQUIRED_LOCALIZATION_SURFACES) {
		const surface = value[surfaceId];
		const path = `surfaces.${surfaceId}`;
		if (!isRecord(surface)) {
			issues.push(issue(path, "Required surface is missing."));
			continue;
		}
		validateSurface(path, surface, issues);
	}
	for (const surfaceId of Object.keys(value)) if (!REQUIRED_LOCALIZATION_SURFACES.includes(surfaceId)) issues.push(issue(`surfaces.${surfaceId}`, "Unknown localization surface."));
}
function validateSurface(path, surface, issues) {
	for (const field of [
		"owner",
		"artifactId",
		"catalogRevision",
		"source"
	]) if (typeof surface[field] !== "string" || !surface[field].trim()) issues.push(issue(`${path}.${field}`, `${field} is required.`));
	const contentClasses = validateStringSet(`${path}.contentClasses`, surface.contentClasses, CONTENT_CLASSES, issues);
	const checks = validateStringSet(`${path}.checks`, surface.checks, CHECKS, issues);
	const locales = surface.locales;
	if (!isRecord(locales)) {
		issues.push(issue(`${path}.locales`, "Locale rows must be an object."));
		return;
	}
	for (const locale of OPENCLAW_LOCALES) {
		const state = locales[locale];
		const statePath = `${path}.locales.${locale}`;
		if (!isRecord(state)) {
			issues.push(issue(statePath, "Required locale row is missing."));
			continue;
		}
		if (!MATURITY_STATES.has(String(state.maturity))) {
			issues.push(issue(`${statePath}.maturity`, "Unknown maturity state."));
			continue;
		}
		if (locale === "en" && state.maturity !== "source") issues.push(issue(`${statePath}.maturity`, "English must be the source locale."));
		if (locale !== "en" && state.maturity === "source") issues.push(issue(`${statePath}.maturity`, "Only English can be the source locale."));
		if (state.maturity === "complete" && (typeof state.languageOwner !== "string" || !state.languageOwner.trim())) issues.push(issue(`${statePath}.languageOwner`, "Complete translations require an owner."));
	}
	for (const locale of Object.keys(locales)) if (!OPENCLAW_LOCALES.includes(locale)) issues.push(issue(`${path}.locales.${locale}`, "Unknown release locale."));
	if (contentClasses.length > 0) {
		const required = requiredChecksForSurface({
			contentClasses,
			locales
		});
		for (const check of required) if (!checks.includes(check)) issues.push(issue(`${path}.checks`, `Missing derived check: ${check}.`));
	}
}
function validateStringSet(path, value, allowed, issues) {
	if (!Array.isArray(value)) {
		issues.push(issue(path, "Expected an array."));
		return [];
	}
	const strings = value.filter((entry) => typeof entry === "string");
	if (strings.length !== value.length || new Set(strings).size !== strings.length) issues.push(issue(path, "Entries must be unique strings."));
	for (const entry of strings) if (!allowed.has(entry)) issues.push(issue(path, `Unknown value: ${entry}.`));
	return strings;
}
function issue(path, detail) {
	return {
		path,
		detail
	};
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
export { LOCALIZATION_CHECKS, LOCALIZATION_CONTENT_CLASSES, LOCALIZATION_MATURITY_STATES, REQUIRED_LOCALIZATION_SURFACES, requiredChecksForSurface, validateLocalizationCoverageManifest };
