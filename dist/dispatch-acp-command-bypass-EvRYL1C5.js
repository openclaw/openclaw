import { t as isCommandEnabled } from "./commands-registry-list--98FRviq.js";
import { n as maybeResolveTextAlias } from "./commands-registry-normalize-CnHNsvCE.js";
import { n as shouldHandleTextCommands } from "./commands-text-routing-C2SuW22t.js";
//#region src/auto-reply/reply/dispatch-acp-command-bypass.ts
function resolveFirstContextText(ctx, keys) {
	for (const key of keys) {
		const value = ctx[key];
		if (typeof value === "string") return value;
	}
	return "";
}
function resolveCommandCandidateText(ctx) {
	return resolveFirstContextText(ctx, [
		"CommandBody",
		"BodyForCommands",
		"RawBody",
		"Body"
	]).trim();
}
function isResetCommandCandidate(text) {
	return /^\/(?:new|reset)(?:\s|$)/i.test(text);
}
function isAcpCommandCandidate(text) {
	return /^\/acp(?:\s|$)/i.test(text);
}
function isLocalCommandCandidate(text) {
	return /^\/(?:status|unfocus)(?:\s|$)/i.test(text);
}
function shouldBypassAcpDispatchForCommand(ctx, cfg) {
	const candidate = resolveCommandCandidateText(ctx);
	if (!candidate) return false;
	const normalized = candidate.trim();
	const allowTextCommands = shouldHandleTextCommands({
		cfg,
		surface: ctx.Surface ?? ctx.Provider ?? "",
		commandSource: ctx.CommandSource
	});
	if (!normalized.startsWith("/") && maybeResolveTextAlias(candidate, cfg) != null) return allowTextCommands;
	if (isResetCommandCandidate(normalized)) return true;
	if (isAcpCommandCandidate(normalized)) return true;
	if (isLocalCommandCandidate(normalized)) return allowTextCommands;
	if (!normalized.startsWith("!")) return false;
	if (!ctx.CommandAuthorized) return false;
	if (!isCommandEnabled(cfg, "bash")) return false;
	return allowTextCommands;
}
//#endregion
export { shouldBypassAcpDispatchForCommand };
