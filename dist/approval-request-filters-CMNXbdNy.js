import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { h as compileSafeRegex, v as testRegexWithBoundedInput } from "./redact-ok5Q8nmw.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
//#region src/infra/approval-request-filters.ts
function matchesApprovalRequestSessionFilter(sessionKey, patterns) {
	return patterns.some((pattern) => {
		if (sessionKey.includes(pattern)) return true;
		const regex = compileSafeRegex(pattern);
		return regex ? testRegexWithBoundedInput(regex, sessionKey) : false;
	});
}
function matchesApprovalRequestFilters(params) {
	if (params.agentFilter?.length) {
		const explicitAgentId = normalizeOptionalString(params.request.agentId);
		const sessionAgentId = params.fallbackAgentIdFromSessionKey ? parseAgentSessionKey(params.request.sessionKey)?.agentId ?? void 0 : void 0;
		const agentId = explicitAgentId ?? sessionAgentId;
		if (!agentId || !params.agentFilter.includes(agentId)) return false;
	}
	if (params.sessionFilter?.length) {
		const sessionKey = normalizeOptionalString(params.request.sessionKey);
		if (!sessionKey || !matchesApprovalRequestSessionFilter(sessionKey, params.sessionFilter)) return false;
	}
	return true;
}
//#endregion
export { matchesApprovalRequestSessionFilter as n, matchesApprovalRequestFilters as t };
