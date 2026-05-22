import { a as isAvatarImageDataUrl, i as isAvatarHttpUrl, u as looksLikeAvatarPath } from "./avatar-policy-BSD55fx7.js";
//#region src/gateway/control-ui-shared.ts
const CONTROL_UI_AVATAR_PREFIX = "/avatar";
function normalizeControlUiBasePath(basePath) {
	if (!basePath) return "";
	let normalized = basePath.trim();
	if (!normalized) return "";
	if (!normalized.startsWith("/")) normalized = `/${normalized}`;
	if (normalized === "/") return "";
	if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
	return normalized;
}
function buildControlUiAvatarUrl(basePath, agentId) {
	return basePath ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/${agentId}` : `${CONTROL_UI_AVATAR_PREFIX}/${agentId}`;
}
function resolveAssistantAvatarUrl(params) {
	const avatar = params.avatar?.trim();
	if (!avatar) return;
	if (isAvatarHttpUrl(avatar) || isAvatarImageDataUrl(avatar)) return avatar;
	const basePath = normalizeControlUiBasePath(params.basePath);
	const baseAvatarPrefix = basePath ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/` : `${CONTROL_UI_AVATAR_PREFIX}/`;
	if (basePath && avatar.startsWith(`/avatar/`)) return `${basePath}${avatar}`;
	if (avatar.startsWith(baseAvatarPrefix)) return avatar;
	if (!params.agentId) return avatar;
	if (looksLikeAvatarPath(avatar)) return buildControlUiAvatarUrl(basePath, params.agentId);
	return avatar;
}
//#endregion
export { resolveAssistantAvatarUrl as i, buildControlUiAvatarUrl as n, normalizeControlUiBasePath as r, CONTROL_UI_AVATAR_PREFIX as t };
