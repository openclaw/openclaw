import { i as resolveManifestProviderAuthChoices, t as resolveManifestDeprecatedProviderAuthChoice } from "./provider-auth-choices-BFWeF5vS.js";
//#region src/commands/auth-choice-legacy.ts
function resolveLegacyCliBackendChoice(choice, params) {
	if (!choice.endsWith("-cli")) return;
	return resolveManifestDeprecatedProviderAuthChoice(choice, params);
}
function resolveReplacementLabel(choiceLabel) {
	return choiceLabel.trim() || "the replacement auth choice";
}
function resolveLegacyAuthChoiceAliasesForCli(params) {
	return resolveManifestProviderAuthChoices(params).flatMap((choice) => choice.deprecatedChoiceIds ?? []).filter((choice) => choice.endsWith("-cli")).toSorted((left, right) => left.localeCompare(right));
}
function normalizeLegacyOnboardAuthChoice(authChoice, params) {
	if (authChoice === "oauth") return "setup-token";
	if (typeof authChoice === "string") {
		const deprecatedChoice = resolveLegacyCliBackendChoice(authChoice, params);
		if (deprecatedChoice) return deprecatedChoice.choiceId;
	}
	return authChoice;
}
function isDeprecatedAuthChoice(authChoice, params) {
	return typeof authChoice === "string" && Boolean(resolveLegacyCliBackendChoice(authChoice, params));
}
function resolveDeprecatedAuthChoiceReplacement(authChoice, params) {
	if (typeof authChoice !== "string") return;
	const deprecatedChoice = resolveLegacyCliBackendChoice(authChoice, params);
	if (!deprecatedChoice) return;
	const replacementLabel = resolveReplacementLabel(deprecatedChoice.choiceLabel);
	return {
		normalized: deprecatedChoice.choiceId,
		message: `Auth choice "${authChoice}" is deprecated; using ${replacementLabel} setup instead.`
	};
}
function formatDeprecatedNonInteractiveAuthChoiceError(authChoice, params) {
	const replacement = resolveDeprecatedAuthChoiceReplacement(authChoice, params);
	if (!replacement) return;
	return [`Auth choice "${authChoice}" is deprecated.`, `Use "--auth-choice ${replacement.normalized}".`].join("\n");
}
//#endregion
export { resolveLegacyAuthChoiceAliasesForCli as a, resolveDeprecatedAuthChoiceReplacement as i, isDeprecatedAuthChoice as n, normalizeLegacyOnboardAuthChoice as r, formatDeprecatedNonInteractiveAuthChoiceError as t };
