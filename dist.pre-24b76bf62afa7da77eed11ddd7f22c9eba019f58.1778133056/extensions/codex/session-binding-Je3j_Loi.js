import { r as resolveProviderIdForAuth } from "../../provider-auth-aliases-D3bAtgRH.js";
import { n as ensureAuthProfileStore } from "../../store-H1X3llav.js";
import { t as resolveOpenClawAgentDir } from "../../agent-paths-CoNW3JiD.js";
import { t as log } from "../../logger-5TyEPTxC.js";
import "../../agent-runtime-Bw1oNb-Q.js";
import "../../agent-harness-runtime-GQH6TCt-.js";
import fs from "node:fs/promises";
//#region extensions/codex/src/app-server/session-binding.ts
const CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER = "openai-codex";
const PUBLIC_OPENAI_MODEL_PROVIDER = "openai";
function resolveCodexAppServerBindingPath(sessionFile) {
	return `${sessionFile}.codex-app-server.json`;
}
async function readCodexAppServerBinding(sessionFile, lookup = {}) {
	const path = resolveCodexAppServerBindingPath(sessionFile);
	let raw;
	try {
		raw = await fs.readFile(path, "utf8");
	} catch (error) {
		if (isNotFound(error)) return;
		log.warn("failed to read codex app-server binding", {
			path,
			error
		});
		return;
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed.schemaVersion !== 1 || typeof parsed.threadId !== "string") return;
		const authProfileId = typeof parsed.authProfileId === "string" ? parsed.authProfileId : void 0;
		return {
			schemaVersion: 1,
			threadId: parsed.threadId,
			sessionFile,
			cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
			authProfileId,
			model: typeof parsed.model === "string" ? parsed.model : void 0,
			modelProvider: normalizeCodexAppServerBindingModelProvider({
				...lookup,
				authProfileId,
				modelProvider: typeof parsed.modelProvider === "string" ? parsed.modelProvider : void 0
			}),
			approvalPolicy: readApprovalPolicy(parsed.approvalPolicy),
			sandbox: readSandboxMode(parsed.sandbox),
			serviceTier: readServiceTier(parsed.serviceTier),
			dynamicToolsFingerprint: typeof parsed.dynamicToolsFingerprint === "string" ? parsed.dynamicToolsFingerprint : void 0,
			createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : (/* @__PURE__ */ new Date()).toISOString(),
			updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : (/* @__PURE__ */ new Date()).toISOString()
		};
	} catch (error) {
		log.warn("failed to parse codex app-server binding", {
			path,
			error
		});
		return;
	}
}
async function writeCodexAppServerBinding(sessionFile, binding, lookup = {}) {
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const payload = {
		schemaVersion: 1,
		sessionFile,
		threadId: binding.threadId,
		cwd: binding.cwd,
		authProfileId: binding.authProfileId,
		model: binding.model,
		modelProvider: normalizeCodexAppServerBindingModelProvider({
			...lookup,
			authProfileId: binding.authProfileId,
			modelProvider: binding.modelProvider
		}),
		approvalPolicy: binding.approvalPolicy,
		sandbox: binding.sandbox,
		serviceTier: binding.serviceTier,
		dynamicToolsFingerprint: binding.dynamicToolsFingerprint,
		createdAt: binding.createdAt ?? now,
		updatedAt: now
	};
	await fs.writeFile(resolveCodexAppServerBindingPath(sessionFile), `${JSON.stringify(payload, null, 2)}\n`);
}
async function clearCodexAppServerBinding(sessionFile) {
	try {
		await fs.unlink(resolveCodexAppServerBindingPath(sessionFile));
	} catch (error) {
		if (!isNotFound(error)) log.warn("failed to clear codex app-server binding", {
			sessionFile,
			error
		});
	}
}
function isNotFound(error) {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
function isCodexAppServerNativeAuthProfile(lookup) {
	const authProfileId = lookup.authProfileId?.trim();
	if (!authProfileId) return false;
	try {
		return isCodexAppServerNativeAuthProvider({
			provider: resolveCodexAppServerAuthProfileCredential({
				...lookup,
				authProfileId
			})?.provider,
			config: lookup.config
		});
	} catch (error) {
		log.debug("failed to resolve codex app-server auth profile provider", {
			authProfileId,
			error
		});
		return false;
	}
}
function normalizeCodexAppServerBindingModelProvider(params) {
	const modelProvider = params.modelProvider?.trim();
	if (!modelProvider) return;
	if (isCodexAppServerNativeAuthProfile(params) && modelProvider.toLowerCase() === PUBLIC_OPENAI_MODEL_PROVIDER) return;
	return modelProvider;
}
function resolveCodexAppServerAuthProfileCredential(lookup) {
	const authProfileId = lookup.authProfileId?.trim();
	if (!authProfileId) return;
	return (lookup.authProfileStore ?? loadCodexAppServerAuthProfileStore(lookup.agentDir)).profiles[authProfileId];
}
function loadCodexAppServerAuthProfileStore(agentDir) {
	return ensureAuthProfileStore(agentDir?.trim() || resolveOpenClawAgentDir(), { allowKeychainPrompt: false });
}
function isCodexAppServerNativeAuthProvider(params) {
	const provider = params.provider?.trim();
	return Boolean(provider && resolveProviderIdForAuth(provider, { config: params.config }) === CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER);
}
function readApprovalPolicy(value) {
	return value === "never" || value === "on-request" || value === "on-failure" || value === "untrusted" ? value : void 0;
}
function readSandboxMode(value) {
	return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : void 0;
}
function readServiceTier(value) {
	return value === "fast" || value === "flex" ? value : void 0;
}
//#endregion
export { resolveCodexAppServerBindingPath as a, readCodexAppServerBinding as i, isCodexAppServerNativeAuthProfile as n, writeCodexAppServerBinding as o, normalizeCodexAppServerBindingModelProvider as r, clearCodexAppServerBinding as t };
