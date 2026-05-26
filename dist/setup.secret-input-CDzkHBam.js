import { d as normalizeSecretInputString, m as resolveSecretInputRef } from "./types.secrets-DwPik3M8.js";
import { i as resolveSecretRefString } from "./resolve-D1Ko6pWx.js";
//#region src/wizard/setup.secret-input.ts
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
