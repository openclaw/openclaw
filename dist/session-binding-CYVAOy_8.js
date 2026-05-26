import { s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { t as log } from "./logger-D2U-uUBZ.js";
import "./agent-runtime-Lc7H-PlR.js";
import "./agent-harness-runtime-CMvm9HY6.js";
import { s as normalizeCodexServiceTier } from "./config-CRe1vCzw.js";
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
			userMcpServersFingerprint: typeof parsed.userMcpServersFingerprint === "string" ? parsed.userMcpServersFingerprint : void 0,
			mcpServersFingerprint: typeof parsed.mcpServersFingerprint === "string" ? parsed.mcpServersFingerprint : void 0,
			pluginAppsFingerprint: typeof parsed.pluginAppsFingerprint === "string" ? parsed.pluginAppsFingerprint : void 0,
			pluginAppsInputFingerprint: typeof parsed.pluginAppsInputFingerprint === "string" ? parsed.pluginAppsInputFingerprint : void 0,
			pluginAppPolicyContext: readPluginAppPolicyContext(parsed.pluginAppPolicyContext),
			contextEngine: readContextEngineBinding(parsed.contextEngine),
			environmentSelectionFingerprint: typeof parsed.environmentSelectionFingerprint === "string" ? parsed.environmentSelectionFingerprint : void 0,
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
		userMcpServersFingerprint: binding.userMcpServersFingerprint,
		mcpServersFingerprint: binding.mcpServersFingerprint,
		pluginAppsFingerprint: binding.pluginAppsFingerprint,
		pluginAppsInputFingerprint: binding.pluginAppsInputFingerprint,
		pluginAppPolicyContext: binding.pluginAppPolicyContext,
		contextEngine: binding.contextEngine,
		environmentSelectionFingerprint: binding.environmentSelectionFingerprint,
		createdAt: binding.createdAt ?? now,
		updatedAt: now
	};
	await fs.writeFile(resolveCodexAppServerBindingPath(sessionFile), `${JSON.stringify(payload, null, 2)}\n`);
}
function readContextEngineBinding(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value;
	if (record.schemaVersion !== 1 || typeof record.engineId !== "string" || typeof record.policyFingerprint !== "string") return;
	return {
		schemaVersion: 1,
		engineId: record.engineId,
		policyFingerprint: record.policyFingerprint,
		projection: readContextEngineProjectionBinding(record.projection)
	};
}
function readContextEngineProjectionBinding(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value;
	if (record.schemaVersion !== 1 || record.mode !== "thread_bootstrap" || typeof record.epoch !== "string" || !record.epoch.trim()) return;
	return {
		schemaVersion: 1,
		mode: "thread_bootstrap",
		epoch: record.epoch,
		fingerprint: typeof record.fingerprint === "string" ? record.fingerprint : void 0
	};
}
function readPluginAppPolicyContext(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value;
	if (typeof record.fingerprint !== "string") return;
	const apps = record.apps;
	if (!apps || typeof apps !== "object" || Array.isArray(apps)) return;
	const parsedApps = {};
	for (const [appId, rawEntry] of Object.entries(apps)) {
		if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return;
		const entry = rawEntry;
		if ("appId" in entry || typeof entry.configKey !== "string" || entry.marketplaceName !== "openai-curated" || typeof entry.pluginName !== "string" || typeof entry.allowDestructiveActions !== "boolean" || !Array.isArray(entry.mcpServerNames) || entry.mcpServerNames.some((serverName) => typeof serverName !== "string")) return;
		parsedApps[appId] = {
			configKey: entry.configKey,
			marketplaceName: entry.marketplaceName,
			pluginName: entry.pluginName,
			allowDestructiveActions: entry.allowDestructiveActions,
			mcpServerNames: entry.mcpServerNames
		};
	}
	const parsedPluginAppIds = {};
	const rawPluginAppIds = record.pluginAppIds;
	if (rawPluginAppIds && (typeof rawPluginAppIds !== "object" || Array.isArray(rawPluginAppIds))) return;
	if (rawPluginAppIds && typeof rawPluginAppIds === "object") for (const [configKey, appIds] of Object.entries(rawPluginAppIds)) {
		if (!Array.isArray(appIds) || appIds.some((appId) => typeof appId !== "string")) return;
		parsedPluginAppIds[configKey] = appIds;
	}
	return {
		fingerprint: record.fingerprint,
		apps: parsedApps,
		pluginAppIds: parsedPluginAppIds
	};
}
async function clearCodexAppServerBinding(sessionFile, _lookup = {}) {
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
	return (lookup.authProfileStore ?? loadCodexAppServerAuthProfileStore({
		agentDir: lookup.agentDir,
		authProfileId,
		config: lookup.config
	})).profiles[authProfileId];
}
function loadCodexAppServerAuthProfileStore(params) {
	return ensureAuthProfileStore(params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {}), {
		allowKeychainPrompt: false,
		config: params.config,
		externalCliProviderIds: [CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER],
		externalCliProfileIds: [params.authProfileId]
	});
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
	return normalizeCodexServiceTier(value);
}
//#endregion
export { resolveCodexAppServerBindingPath as a, readCodexAppServerBinding as i, isCodexAppServerNativeAuthProfile as n, writeCodexAppServerBinding as o, normalizeCodexAppServerBindingModelProvider as r, clearCodexAppServerBinding as t };
