import { eb as resolveSecretRefString } from "./auth-profiles-DAOR1fRn.js";
import { f as resolveSecretInputRef, o as init_types_secrets, u as normalizeSecretInputString } from "./types.secrets-Cu0Lz6pi.js";
//#region src/wizard/setup.secret-input.ts
init_types_secrets();
function formatSecretResolutionError(error) {
	if (error instanceof Error && error.message.trim().length > 0) return error.message;
	return String(error);
}
async function resolveSetupSecretInputString(params) {
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
export { resolveSetupSecretInputString as t };
