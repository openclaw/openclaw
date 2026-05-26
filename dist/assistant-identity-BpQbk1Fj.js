import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { a as isAvatarImageDataUrl, i as isAvatarHttpUrl, u as looksLikeAvatarPath } from "./avatar-policy-BSD55fx7.js";
import { n as resolveAgentIdentity } from "./identity-nYw-h8DL.js";
import { i as loadAgentIdentity } from "./agents.config-BhjhdYsc.js";
//#region src/shared/assistant-identity-values.ts
function coerceIdentityValue(value, maxLength) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	if (trimmed.length <= maxLength) return trimmed;
	return trimmed.slice(0, maxLength);
}
//#endregion
//#region src/gateway/assistant-identity.ts
const MAX_ASSISTANT_NAME = 50;
const MAX_ASSISTANT_AVATAR = 2e6;
const MAX_ASSISTANT_EMOJI = 16;
const DEFAULT_ASSISTANT_IDENTITY = {
	agentId: "main",
	name: "Assistant",
	avatar: "A"
};
function isAvatarUrl(value) {
	return isAvatarHttpUrl(value) || isAvatarImageDataUrl(value);
}
function normalizeAvatarValue(value) {
	if (!value) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	if (isAvatarUrl(trimmed)) return trimmed;
	if (looksLikeAvatarPath(trimmed)) return trimmed;
	if (!/\s/.test(trimmed) && trimmed.length <= 4) return trimmed;
}
function normalizeEmojiValue(value) {
	if (!value) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	if (trimmed.length > MAX_ASSISTANT_EMOJI) return;
	let hasNonAscii = false;
	for (let i = 0; i < trimmed.length; i += 1) if (trimmed.charCodeAt(i) > 127) {
		hasNonAscii = true;
		break;
	}
	if (!hasNonAscii) return;
	if (isAvatarUrl(trimmed) || looksLikeAvatarPath(trimmed)) return;
	return trimmed;
}
function resolveAssistantIdentity(params) {
	const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
	const agentId = normalizeAgentId(params.agentId ?? defaultAgentId);
	const isDefaultAgent = agentId === defaultAgentId;
	const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
	const configAssistant = params.cfg.ui?.assistant;
	const agentIdentity = resolveAgentIdentity(params.cfg, agentId);
	const fileIdentity = workspaceDir ? loadAgentIdentity(workspaceDir) : null;
	const uiName = coerceIdentityValue(configAssistant?.name, MAX_ASSISTANT_NAME);
	const agentName = coerceIdentityValue(agentIdentity?.name, MAX_ASSISTANT_NAME);
	const fileName = coerceIdentityValue(fileIdentity?.name, MAX_ASSISTANT_NAME);
	const name = (isDefaultAgent ? uiName ?? agentName ?? fileName : agentName ?? fileName ?? uiName) ?? DEFAULT_ASSISTANT_IDENTITY.name;
	const uiAvatar = coerceIdentityValue(configAssistant?.avatar, MAX_ASSISTANT_AVATAR);
	const agentAvatarCandidates = [
		coerceIdentityValue(agentIdentity?.avatar, MAX_ASSISTANT_AVATAR),
		coerceIdentityValue(agentIdentity?.emoji, MAX_ASSISTANT_AVATAR),
		coerceIdentityValue(fileIdentity?.avatar, MAX_ASSISTANT_AVATAR),
		coerceIdentityValue(fileIdentity?.emoji, MAX_ASSISTANT_AVATAR)
	];
	return {
		agentId,
		name,
		avatar: (isDefaultAgent ? [uiAvatar, ...agentAvatarCandidates] : [...agentAvatarCandidates, uiAvatar]).map((candidate) => normalizeAvatarValue(candidate)).find(Boolean) ?? DEFAULT_ASSISTANT_IDENTITY.avatar,
		emoji: [
			coerceIdentityValue(agentIdentity?.emoji, MAX_ASSISTANT_EMOJI),
			coerceIdentityValue(fileIdentity?.emoji, MAX_ASSISTANT_EMOJI),
			coerceIdentityValue(agentIdentity?.avatar, MAX_ASSISTANT_EMOJI),
			coerceIdentityValue(fileIdentity?.avatar, MAX_ASSISTANT_EMOJI)
		].map((candidate) => normalizeEmojiValue(candidate)).find(Boolean)
	};
}
//#endregion
export { resolveAssistantIdentity as n, DEFAULT_ASSISTANT_IDENTITY as t };
