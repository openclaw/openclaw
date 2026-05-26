import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as resolveAgentIdentity } from "./identity-nYw-h8DL.js";
import { t as resolveAgentAvatar } from "./identity-avatar-B6GTrfBh.js";
//#region src/infra/outbound/identity.ts
function normalizeOutboundIdentity(identity) {
	if (!identity) return;
	const name = normalizeOptionalString(identity.name);
	const avatarUrl = normalizeOptionalString(identity.avatarUrl);
	const emoji = normalizeOptionalString(identity.emoji);
	const theme = normalizeOptionalString(identity.theme);
	if (!name && !avatarUrl && !emoji && !theme) return;
	return {
		name,
		avatarUrl,
		emoji,
		theme
	};
}
function resolveAgentOutboundIdentity(cfg, agentId) {
	const agentIdentity = resolveAgentIdentity(cfg, agentId);
	const avatar = resolveAgentAvatar(cfg, agentId);
	return normalizeOutboundIdentity({
		name: agentIdentity?.name,
		emoji: agentIdentity?.emoji,
		avatarUrl: avatar.kind === "remote" ? avatar.url : void 0,
		theme: agentIdentity?.theme
	});
}
//#endregion
export { resolveAgentOutboundIdentity as n, normalizeOutboundIdentity as t };
