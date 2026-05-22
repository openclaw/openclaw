import { n as matchesAnyGlobPattern, t as compileGlobPatterns } from "./glob-pattern-4JO_uNsM.js";
import { i as normalizeToolName, n as expandToolGroups } from "./tool-policy-shared-C87JPsbp.js";
import "./tool-policy-Bmp2N959.js";
//#region src/agents/tool-policy-match.ts
function makeToolPolicyMatcher(policy) {
	const deny = compileGlobPatterns({
		raw: expandToolGroups(policy.deny ?? []),
		normalize: normalizeToolName
	});
	const allow = compileGlobPatterns({
		raw: expandToolGroups(policy.allow ?? []),
		normalize: normalizeToolName
	});
	return (name) => {
		const normalized = normalizeToolName(name);
		if (matchesAnyGlobPattern(normalized, deny)) return false;
		if (allow.length === 0) return true;
		if (matchesAnyGlobPattern(normalized, allow)) return true;
		if (normalized === "apply_patch" && matchesAnyGlobPattern("write", allow)) return true;
		return false;
	};
}
function isToolAllowedByPolicyName(name, policy) {
	if (!policy) return true;
	return makeToolPolicyMatcher(policy)(name);
}
function isToolAllowedByPolicies(name, policies) {
	return policies.every((policy) => isToolAllowedByPolicyName(name, policy));
}
//#endregion
export { isToolAllowedByPolicyName as n, isToolAllowedByPolicies as t };
