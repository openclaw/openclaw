import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./model-selection-P-81eBKx.js";
import crypto from "node:crypto";
//#region src/agents/cli-session.ts
const CLAUDE_CLI_BACKEND_ID = "claude-cli";
function hashCliSessionText(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	return crypto.createHash("sha256").update(trimmed).digest("hex");
}
function getCliSessionBinding(entry, provider) {
	if (!entry) return;
	const normalized = normalizeProviderId(provider);
	const fromBindings = entry.cliSessionBindings?.[normalized];
	const bindingSessionId = normalizeOptionalString(fromBindings?.sessionId);
	if (bindingSessionId) return {
		sessionId: bindingSessionId,
		...fromBindings?.forceReuse === true ? { forceReuse: true } : {},
		authProfileId: normalizeOptionalString(fromBindings?.authProfileId),
		authEpoch: normalizeOptionalString(fromBindings?.authEpoch),
		authEpochVersion: fromBindings?.authEpochVersion,
		extraSystemPromptHash: normalizeOptionalString(fromBindings?.extraSystemPromptHash),
		promptToolNamesHash: normalizeOptionalString(fromBindings?.promptToolNamesHash),
		mcpConfigHash: normalizeOptionalString(fromBindings?.mcpConfigHash),
		mcpResumeHash: normalizeOptionalString(fromBindings?.mcpResumeHash)
	};
	const fromMap = entry.cliSessionIds?.[normalized];
	const normalizedFromMap = normalizeOptionalString(fromMap);
	if (normalizedFromMap) return { sessionId: normalizedFromMap };
	if (normalized === CLAUDE_CLI_BACKEND_ID) {
		const legacy = normalizeOptionalString(entry.claudeCliSessionId);
		if (legacy) return { sessionId: legacy };
	}
}
function getCliSessionId(entry, provider) {
	return getCliSessionBinding(entry, provider)?.sessionId;
}
function setCliSessionId(entry, provider, sessionId) {
	setCliSessionBinding(entry, provider, { sessionId });
}
function setCliSessionBinding(entry, provider, binding) {
	const normalized = normalizeProviderId(provider);
	const trimmed = binding.sessionId.trim();
	if (!trimmed) return;
	entry.cliSessionBindings = {
		...entry.cliSessionBindings,
		[normalized]: {
			sessionId: trimmed,
			...binding.forceReuse === true ? { forceReuse: true } : {},
			...normalizeOptionalString(binding.authProfileId) ? { authProfileId: normalizeOptionalString(binding.authProfileId) } : {},
			...normalizeOptionalString(binding.authEpoch) ? { authEpoch: normalizeOptionalString(binding.authEpoch) } : {},
			...typeof binding.authEpochVersion === "number" && Number.isFinite(binding.authEpochVersion) ? { authEpochVersion: binding.authEpochVersion } : {},
			...normalizeOptionalString(binding.extraSystemPromptHash) ? { extraSystemPromptHash: normalizeOptionalString(binding.extraSystemPromptHash) } : {},
			...normalizeOptionalString(binding.promptToolNamesHash) ? { promptToolNamesHash: normalizeOptionalString(binding.promptToolNamesHash) } : {},
			...normalizeOptionalString(binding.mcpConfigHash) ? { mcpConfigHash: normalizeOptionalString(binding.mcpConfigHash) } : {},
			...normalizeOptionalString(binding.mcpResumeHash) ? { mcpResumeHash: normalizeOptionalString(binding.mcpResumeHash) } : {}
		}
	};
	entry.cliSessionIds = {
		...entry.cliSessionIds,
		[normalized]: trimmed
	};
	if (normalized === CLAUDE_CLI_BACKEND_ID) entry.claudeCliSessionId = trimmed;
}
function clearCliSession(entry, provider) {
	const normalized = normalizeProviderId(provider);
	if (entry.cliSessionBindings?.[normalized] !== void 0) {
		const next = { ...entry.cliSessionBindings };
		delete next[normalized];
		entry.cliSessionBindings = Object.keys(next).length > 0 ? next : void 0;
	}
	if (entry.cliSessionIds?.[normalized] !== void 0) {
		const next = { ...entry.cliSessionIds };
		delete next[normalized];
		entry.cliSessionIds = Object.keys(next).length > 0 ? next : void 0;
	}
	if (normalized === CLAUDE_CLI_BACKEND_ID) entry.claudeCliSessionId = void 0;
}
function clearAllCliSessions(entry) {
	entry.cliSessionBindings = void 0;
	entry.cliSessionIds = void 0;
	entry.claudeCliSessionId = void 0;
}
function resolveCliSessionReuse(params) {
	const binding = params.binding;
	const sessionId = normalizeOptionalString(binding?.sessionId);
	if (!sessionId) return {};
	if (binding?.forceReuse === true) return { sessionId };
	const currentAuthProfileId = normalizeOptionalString(params.authProfileId);
	const currentAuthEpoch = normalizeOptionalString(params.authEpoch);
	const currentExtraSystemPromptHash = normalizeOptionalString(params.extraSystemPromptHash);
	const currentPromptToolNamesHash = normalizeOptionalString(params.promptToolNamesHash);
	const currentMcpConfigHash = normalizeOptionalString(params.mcpConfigHash);
	const currentMcpResumeHash = normalizeOptionalString(params.mcpResumeHash);
	const storedAuthProfileId = normalizeOptionalString(binding?.authProfileId);
	const storedAuthEpoch = normalizeOptionalString(binding?.authEpoch);
	const hasMatchingVersionedAuthEpoch = binding?.authEpochVersion === params.authEpochVersion && storedAuthEpoch !== void 0 && currentAuthEpoch !== void 0 && storedAuthEpoch === currentAuthEpoch;
	if (storedAuthProfileId !== currentAuthProfileId) {
		if (!hasMatchingVersionedAuthEpoch) return { invalidatedReason: "auth-profile" };
	}
	if (binding?.authEpochVersion === params.authEpochVersion && storedAuthEpoch !== currentAuthEpoch) return { invalidatedReason: "auth-epoch" };
	if (normalizeOptionalString(binding?.extraSystemPromptHash) !== currentExtraSystemPromptHash) return { invalidatedReason: "system-prompt" };
	if (normalizeOptionalString(binding?.promptToolNamesHash) !== currentPromptToolNamesHash) return { invalidatedReason: "system-prompt" };
	const storedMcpResumeHash = normalizeOptionalString(binding?.mcpResumeHash);
	if (storedMcpResumeHash && currentMcpResumeHash) {
		if (storedMcpResumeHash !== currentMcpResumeHash) return { invalidatedReason: "mcp" };
		return { sessionId };
	}
	if (normalizeOptionalString(binding?.mcpConfigHash) !== currentMcpConfigHash) return { invalidatedReason: "mcp" };
	return { sessionId };
}
//#endregion
export { hashCliSessionText as a, setCliSessionId as c, getCliSessionId as i, clearCliSession as n, resolveCliSessionReuse as o, getCliSessionBinding as r, setCliSessionBinding as s, clearAllCliSessions as t };
