import { c as isRecord } from "./utils-sBTEdeml.js";
import { o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import "./shared-Cv5g0_Ch.js";
import { u as secretRefKey } from "./ref-contract-D_h_G00C.js";
import { t as assertExpectedResolvedSecretValue } from "./secret-value-BZ8grP0G.js";
//#region src/secrets/runtime-shared.ts
function createResolverContext(params) {
	return {
		sourceConfig: params.sourceConfig,
		env: params.env,
		cache: {},
		warnings: [],
		warningKeys: /* @__PURE__ */ new Set(),
		assignments: []
	};
}
function pushAssignment(context, assignment) {
	context.assignments.push(assignment);
}
function pushWarning(context, warning) {
	const warningKey = `${warning.code}:${warning.path}:${warning.message}`;
	if (context.warningKeys.has(warningKey)) return;
	context.warningKeys.add(warningKey);
	context.warnings.push(warning);
}
function pushInactiveSurfaceWarning(params) {
	pushWarning(params.context, {
		code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
		path: params.path,
		message: params.details && params.details.trim().length > 0 ? `${params.path}: ${params.details}` : `${params.path}: secret ref is configured on an inactive surface; skipping resolution until it becomes active.`
	});
}
function collectSecretInputAssignment(params) {
	const ref = coerceSecretRef(params.value, params.defaults);
	if (!ref) return;
	if (params.active === false) {
		pushInactiveSurfaceWarning({
			context: params.context,
			path: params.path,
			details: params.inactiveReason
		});
		return;
	}
	pushAssignment(params.context, {
		ref,
		path: params.path,
		expected: params.expected,
		apply: params.apply
	});
}
function applyResolvedAssignments(params) {
	for (const assignment of params.assignments) {
		const key = secretRefKey(assignment.ref);
		if (!params.resolved.has(key)) throw new Error(`Secret reference "${key}" resolved to no value.`);
		const value = params.resolved.get(key);
		assertExpectedResolvedSecretValue({
			value,
			expected: assignment.expected,
			errorMessage: assignment.expected === "string" ? `${assignment.path} resolved to a non-string or empty value.` : `${assignment.path} resolved to an unsupported value type.`
		});
		assignment.apply(value);
	}
}
function hasOwnProperty(record, key) {
	return Object.prototype.hasOwnProperty.call(record, key);
}
function isEnabledFlag(value) {
	if (!isRecord(value)) return true;
	return value.enabled !== false;
}
function isChannelAccountEffectivelyEnabled(channel, account) {
	return isEnabledFlag(channel) && isEnabledFlag(account);
}
//#endregion
export { isChannelAccountEffectivelyEnabled as a, pushInactiveSurfaceWarning as c, hasOwnProperty as i, pushWarning as l, collectSecretInputAssignment as n, isEnabledFlag as o, createResolverContext as r, pushAssignment as s, applyResolvedAssignments as t };
