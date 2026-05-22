import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { i as callGateway } from "./call-Bpx-6B1C.js";
import { t as SESSION_ID_RE } from "./session-id-BSvwHgqa.js";
import { t as resolveEffectiveResetTargetSessionKey } from "./acp-reset-target-DSxSWpxX.js";
import { E as resolveAcpCommandBindingContext } from "./shared-BLaGCyl5.js";
import { s as resolveRequesterSessionKey } from "./shared-CdqVov1m.js";
//#region src/auto-reply/reply/commands-acp/targets.ts
async function resolveSessionKeyByToken(token) {
	const trimmed = token.trim();
	if (!trimmed) return null;
	const attempts = [{ key: trimmed }];
	if (SESSION_ID_RE.test(trimmed)) attempts.push({ sessionId: trimmed });
	attempts.push({ label: trimmed });
	for (const params of attempts) try {
		const key = normalizeOptionalString((await callGateway({
			method: "sessions.resolve",
			params,
			timeoutMs: 8e3
		}))?.key) ?? "";
		if (key) return key;
	} catch {}
	return null;
}
function resolveBoundAcpThreadSessionKey(params) {
	const activeSessionKey = (normalizeOptionalString(params.ctx.CommandTargetSessionKey) ?? "") || (normalizeOptionalString(params.sessionKey) ?? "");
	const bindingContext = resolveAcpCommandBindingContext(params);
	return resolveEffectiveResetTargetSessionKey({
		cfg: params.cfg,
		channel: bindingContext.channel,
		accountId: bindingContext.accountId,
		conversationId: bindingContext.conversationId,
		parentConversationId: bindingContext.parentConversationId,
		activeSessionKey,
		allowNonAcpBindingSessionKey: true,
		skipConfiguredFallbackWhenActiveSessionNonAcp: false
	});
}
async function resolveAcpTargetSessionKey(params) {
	const token = normalizeOptionalString(params.token) ?? "";
	if (token) {
		const resolved = await resolveSessionKeyByToken(token);
		if (resolved) return {
			ok: true,
			sessionKey: resolved
		};
	}
	const threadBound = resolveBoundAcpThreadSessionKey(params.commandParams);
	if (threadBound) return {
		ok: true,
		sessionKey: threadBound
	};
	if (token) return {
		ok: false,
		error: `Unable to resolve session target: ${token}`
	};
	const fallback = resolveRequesterSessionKey(params.commandParams, { preferCommandTarget: true });
	if (!fallback) return {
		ok: false,
		error: "Missing session key."
	};
	return {
		ok: true,
		sessionKey: fallback
	};
}
//#endregion
export { resolveBoundAcpThreadSessionKey as n, resolveAcpTargetSessionKey as t };
