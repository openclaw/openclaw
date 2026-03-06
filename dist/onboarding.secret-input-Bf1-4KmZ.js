import { Nt as resolveSecretRefString } from "./model-selection-Dmiyt9yA.js";
import { F as normalizeSecretInputString, L as resolveSecretInputRef } from "./registry-DBb6KIXY.js";

//#region src/wizard/onboarding.secret-input.ts
function formatSecretResolutionError(error) {
	if (error instanceof Error && error.message.trim().length > 0) return error.message;
	return String(error);
}
async function resolveOnboardingSecretInputString(params) {
	const defaults = params.defaults ?? params.config.secrets?.defaults;
	const { ref } = resolveSecretInputRef({
		value: params.value,
		defaults
	});
	if (ref) try {
		return await resolveSecretRefString(ref, {
			config: params.config,
			env: params.env ?? process.env
		});
	} catch (error) {
		throw new Error(`${params.path}: failed to resolve SecretRef "${ref.source}:${ref.provider}:${ref.id}": ${formatSecretResolutionError(error)}`, { cause: error });
	}
	return normalizeSecretInputString(params.value);
}

//#endregion
export { resolveOnboardingSecretInputString as t };