import { c as isRecord } from "./utils-CCskKJVV.js";
import { n as isNonEmptyString } from "./shared-BwAOXrhs.js";
//#region src/secrets/secret-value.ts
function isExpectedResolvedSecretValue(value, expected) {
	if (expected === "string") return isNonEmptyString(value);
	return isNonEmptyString(value) || isRecord(value);
}
function hasConfiguredPlaintextSecretValue(value, expected) {
	if (expected === "string") return isNonEmptyString(value);
	return isNonEmptyString(value) || isRecord(value) && Object.keys(value).length > 0;
}
function assertExpectedResolvedSecretValue(params) {
	if (!isExpectedResolvedSecretValue(params.value, params.expected)) throw new Error(params.errorMessage);
}
//#endregion
export { hasConfiguredPlaintextSecretValue as n, isExpectedResolvedSecretValue as r, assertExpectedResolvedSecretValue as t };
