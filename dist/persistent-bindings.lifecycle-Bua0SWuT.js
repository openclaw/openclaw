import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { t as getAcpSessionManager } from "./manager-CnO_4PJM.js";
import "./session-meta-CZ8B2a4Z.js";
import { o as buildConfiguredAcpSessionKey } from "./binding-registry-dyeOsusx.js";
import "./persistent-bindings.resolve-DrfbZLJ2.js";
//#region src/acp/persistent-bindings.lifecycle.ts
function sessionMatchesConfiguredBinding(params) {
	if (params.meta.state === "error") return false;
	const desiredAgent = normalizeLowercaseStringOrEmpty(params.spec.acpAgentId ?? params.spec.agentId);
	const currentAgent = normalizeLowercaseStringOrEmpty(params.meta.agent);
	if (!currentAgent || currentAgent !== desiredAgent) return false;
	if (params.meta.mode !== params.spec.mode) return false;
	const desiredBackend = normalizeOptionalString(params.spec.backend) ?? normalizeOptionalString(params.cfg.acp?.backend) ?? "";
	if (desiredBackend) {
		const currentBackend = (params.meta.backend ?? "").trim();
		if (!currentBackend || currentBackend !== desiredBackend) return false;
	}
	const desiredCwd = normalizeOptionalString(params.spec.cwd);
	if (desiredCwd !== void 0) {
		if (desiredCwd !== (params.meta.runtimeOptions?.cwd ?? params.meta.cwd ?? "").trim()) return false;
	}
	return true;
}
async function ensureConfiguredAcpBindingSession(params) {
	const sessionKey = buildConfiguredAcpSessionKey(params.spec);
	const acpManager = getAcpSessionManager();
	try {
		const resolution = acpManager.resolveSession({
			cfg: params.cfg,
			sessionKey
		});
		if (resolution.kind === "ready" && sessionMatchesConfiguredBinding({
			cfg: params.cfg,
			spec: params.spec,
			meta: resolution.meta
		})) return {
			ok: true,
			sessionKey
		};
		if (resolution.kind !== "none") await acpManager.closeSession({
			cfg: params.cfg,
			sessionKey,
			reason: "config-binding-reconfigure",
			clearMeta: false,
			allowBackendUnavailable: true,
			requireAcpSession: false
		});
		await acpManager.initializeSession({
			cfg: params.cfg,
			sessionKey,
			agent: params.spec.acpAgentId ?? params.spec.agentId,
			mode: params.spec.mode,
			cwd: params.spec.cwd,
			backendId: params.spec.backend
		});
		return {
			ok: true,
			sessionKey
		};
	} catch (error) {
		const message = formatErrorMessage(error);
		logVerbose(`acp-configured-binding: failed ensuring ${params.spec.channel}:${params.spec.accountId}:${params.spec.conversationId} -> ${sessionKey}: ${message}`);
		return {
			ok: false,
			sessionKey,
			error: message
		};
	}
}
async function ensureConfiguredAcpBindingReady(params) {
	if (!params.configuredBinding) return { ok: true };
	const ensured = await ensureConfiguredAcpBindingSession({
		cfg: params.cfg,
		spec: params.configuredBinding.spec
	});
	if (ensured.ok) return { ok: true };
	return {
		ok: false,
		error: ensured.error ?? "unknown error"
	};
}
//#endregion
export { ensureConfiguredAcpBindingSession as n, ensureConfiguredAcpBindingReady as t };
