import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { a as resolveAgentDir } from "./agent-scope-config-26EcJVc0.js";
import { m as resolveSessionAgentIds } from "./agent-scope-C1Fl7gAf.js";
import { d as writeJson, l as tryReadJson } from "./json-files-CahFuwKs.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import { t as applyMergePatch } from "./merge-patch-DDivnvVJ.js";
import "./config-CzeRK-GW.js";
import { r as annotateInterSessionPromptText } from "./input-provenance-cioGkz6Z.js";
import { A as readCodexCliCredentialsCached, j as readGeminiCliCredentialsCached, k as readClaudeCliCredentialsCached, s as loadAuthProfileStoreForRuntime } from "./store-a4exFSck.js";
import { n as mergePluginTextTransforms, t as applyPluginTextReplacements } from "./plugin-text-transforms-BLjBtFc3.js";
import { r as resolvePluginSetupCliBackend } from "./setup-registry-C32GYnQD.js";
import { t as extractMcpServerMap } from "./bundle-mcp-CFLIOQBM.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-aUo3QVZe.js";
import { r as loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader-BqRX3EBI.js";
import { J as resolveRuntimeTextTransforms } from "./provider-runtime-DXB7r8u2.js";
import { n as resolveRuntimeCliBackends } from "./model-selection-cli-CT4Mltpu.js";
import "./model-selection-VRXWv5rs.js";
import { t as buildAgentHookContextChannelFields } from "./hook-agent-context-DJQE24WK.js";
import { i as buildBootstrapPromptWarning, o as buildBootstrapTruncationReportMeta, r as buildBootstrapInjectionStats, t as analyzeBootstrapBudget } from "./bootstrap-budget-CgtoXSfG.js";
import { a as resolveBootstrapContextForRun, c as resolveHeartbeatPromptForSystemPrompt, i as makeBootstrapWarn } from "./bootstrap-files-BUEAiWga.js";
import { h as resolveBootstrapTotalMaxChars, m as resolveBootstrapPromptTruncationWarningMode, p as resolveBootstrapMaxChars } from "./pi-embedded-helpers-CVGWGeIq.js";
import { r as externalCliDiscoveryForProviderAuth } from "./external-cli-discovery-Yd9K5coJ.js";
import { n as loadMergedBundleMcpConfig, r as toCliBundleMcpServerConfig } from "./embedded-pi-mcp-Ctrf7K_k.js";
import { s as resolveSkillsPromptForRun } from "./workspace-CWHANolf.js";
import "./skills-Cc0UgUNL.js";
import { t as resolveSystemPromptOverride } from "./system-prompt-override-Nli_P2Nw.js";
import { t as buildSystemPromptReport } from "./system-prompt-report-FMyQ300i.js";
import { r as appendModelIdentitySystemPrompt } from "./system-prompt-config-DpjdHIUy.js";
import { d as resolveAttemptPrependSystemContext, f as resolvePromptBuildHookResult, n as composeSystemPromptWithHookContext } from "./attempt.thread-helpers-Dpqwtc2q.js";
import { t as buildCurrentTurnPrompt } from "./runtime-context-prompt-BrtaVc2i.js";
import { n as resolveRunWorkspaceDir, t as redactRunIdentifier } from "./workspace-run-05nxuGpp.js";
import { a as decodeHeaderEnvPlaceholder, i as applyCommonServerConfig, o as isRecord, s as normalizeStringRecord } from "./codex-mcp-config-x-azT_Ey.js";
import { n as injectCodexMcpConfigArgs } from "./bundle-mcp-codex-zUqHjbeM.js";
import { a as hashCliSessionText, o as resolveCliSessionReuse } from "./cli-session-BhJMvmDC.js";
import { n as loadCliSessionHistoryMessages, r as loadCliSessionReseedMessages, t as buildCliSessionHistoryPrompt } from "./session-history-BqIMsxsA.js";
import { r as cliBackendLog } from "./log-CA4BzWiZ.js";
import { i as normalizeCliModel, t as buildCliAgentSystemPrompt } from "./helpers-B1ZH_nQ4.js";
import { a as getActiveMcpLoopbackRuntime, i as createMcpLoopbackServerConfig, n as ensureMcpLoopbackServer } from "./mcp-http-CqosJaju.js";
import { n as claudeCliSessionTranscriptHasContent } from "./attempt-execution.helpers-o_zmjlBC.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
//#region src/plugin-sdk/anthropic-cli.ts
function loadFacadeModule() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "anthropic",
		artifactBasename: "api.js"
	});
}
loadFacadeModule()["CLAUDE_CLI_BACKEND_ID"];
const isClaudeCliProvider = ((...args) => loadFacadeModule()["isClaudeCliProvider"](...args));
const cliAuthEpochDeps = {
	readClaudeCliCredentialsCached,
	readCodexCliCredentialsCached,
	readGeminiCliCredentialsCached,
	loadAuthProfileStoreForRuntime
};
function hashCliAuthEpochPart(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}
function encodeUnknown(value) {
	return JSON.stringify(value ?? null);
}
function encodeOAuthIdentity(credential) {
	return JSON.stringify([
		"oauth",
		credential.provider,
		credential.clientId ?? null,
		credential.email ?? null,
		credential.enterpriseUrl ?? null,
		credential.projectId ?? null,
		credential.accountId ?? null
	]);
}
function encodeClaudeCredential(credential) {
	if (credential.type === "oauth") return encodeOAuthIdentity(credential);
	return JSON.stringify([
		"token",
		credential.provider,
		credential.token
	]);
}
function encodeCodexCredential(credential) {
	return encodeOAuthIdentity(credential);
}
function encodeGeminiCredential(credential) {
	return encodeOAuthIdentity(credential);
}
function encodeAuthProfileCredential(credential) {
	switch (credential.type) {
		case "api_key": return JSON.stringify([
			"api_key",
			credential.provider,
			credential.key ?? null,
			encodeUnknown(credential.keyRef),
			credential.email ?? null,
			credential.displayName ?? null,
			encodeUnknown(credential.metadata)
		]);
		case "token": return JSON.stringify([
			"token",
			credential.provider,
			credential.token ?? null,
			encodeUnknown(credential.tokenRef),
			credential.email ?? null,
			credential.displayName ?? null
		]);
		case "oauth": return encodeOAuthIdentity(credential);
	}
	throw new Error("Unsupported auth profile credential type");
}
function hasOAuthAccountIdentity(credential) {
	return credential.type === "oauth" && (normalizeOptionalString(credential.accountId) !== void 0 || normalizeOptionalString(credential.email) !== void 0);
}
function encodeAuthProfileEpochPart(authProfileId, credential) {
	const credentialHash = hashCliAuthEpochPart(encodeAuthProfileCredential(credential));
	if (hasOAuthAccountIdentity(credential)) return `profile:oauth-identity:${credentialHash}`;
	return `profile:${authProfileId}:${credentialHash}`;
}
function getLocalCliCredentialFingerprint(provider) {
	switch (provider) {
		case "claude-cli": {
			const credential = cliAuthEpochDeps.readClaudeCliCredentialsCached({
				ttlMs: 5e3,
				allowKeychainPrompt: false
			});
			return credential ? hashCliAuthEpochPart(encodeClaudeCredential(credential)) : void 0;
		}
		case "codex-cli": {
			const credential = cliAuthEpochDeps.readCodexCliCredentialsCached({
				ttlMs: 5e3,
				allowKeychainPrompt: false
			});
			return credential ? hashCliAuthEpochPart(encodeCodexCredential(credential)) : void 0;
		}
		case "google-gemini-cli": {
			const credential = cliAuthEpochDeps.readGeminiCliCredentialsCached({ ttlMs: 5e3 });
			return credential ? hashCliAuthEpochPart(encodeGeminiCredential(credential)) : void 0;
		}
		default: return;
	}
}
function getAuthProfileCredential(store, authProfileId) {
	if (!authProfileId) return;
	return store.profiles[authProfileId];
}
async function resolveCliAuthEpoch(params) {
	const provider = params.provider.trim();
	const authProfileId = normalizeOptionalString(params.authProfileId);
	const parts = [];
	if (params.skipLocalCredential !== true) {
		const localFingerprint = getLocalCliCredentialFingerprint(provider);
		if (localFingerprint) parts.push(`local:${provider}:${localFingerprint}`);
	}
	if (authProfileId) {
		const credential = getAuthProfileCredential(cliAuthEpochDeps.loadAuthProfileStoreForRuntime(void 0, {
			readOnly: true,
			allowKeychainPrompt: false
		}), authProfileId);
		if (credential) parts.push(encodeAuthProfileEpochPart(authProfileId, credential));
	}
	if (parts.length === 0) return;
	return hashCliAuthEpochPart(parts.join("\n"));
}
let cliBackendsDeps = {
	resolvePluginSetupCliBackend,
	resolveRuntimeCliBackends
};
const FALLBACK_CLI_BACKEND_POLICIES = {};
function normalizeBundleMcpMode(mode, enabled) {
	if (!enabled) return;
	return mode ?? "claude-config-file";
}
function resolveSetupCliBackendPolicy(provider) {
	const entry = cliBackendsDeps.resolvePluginSetupCliBackend({ backend: provider });
	if (!entry) return;
	return {
		bundleMcp: entry.backend.bundleMcp === true,
		bundleMcpMode: normalizeBundleMcpMode(entry.backend.bundleMcpMode, entry.backend.bundleMcp === true),
		baseConfig: entry.backend.config,
		normalizeConfig: entry.backend.normalizeConfig,
		transformSystemPrompt: entry.backend.transformSystemPrompt,
		textTransforms: entry.backend.textTransforms,
		defaultAuthProfileId: entry.backend.defaultAuthProfileId,
		authEpochMode: entry.backend.authEpochMode,
		prepareExecution: entry.backend.prepareExecution,
		resolveExecutionArgs: entry.backend.resolveExecutionArgs,
		nativeToolMode: entry.backend.nativeToolMode
	};
}
function resolveFallbackCliBackendPolicy(provider) {
	return FALLBACK_CLI_BACKEND_POLICIES[provider] ?? resolveSetupCliBackendPolicy(provider);
}
function normalizeBackendKey(key) {
	return normalizeProviderId(key);
}
function pickBackendConfig(config, normalizedId) {
	const directKey = Object.keys(config).find((key) => normalizeOptionalLowercaseString(key) === normalizedId);
	if (directKey) return config[directKey];
	for (const [key, entry] of Object.entries(config)) if (normalizeBackendKey(key) === normalizedId) return entry;
}
function resolveRegisteredBackend(provider) {
	const normalized = normalizeBackendKey(provider);
	return cliBackendsDeps.resolveRuntimeCliBackends().find((entry) => normalizeBackendKey(entry.id) === normalized);
}
function mergeBackendConfig(base, override) {
	if (!override) return { ...base };
	const baseFresh = base.reliability?.watchdog?.fresh ?? {};
	const baseResume = base.reliability?.watchdog?.resume ?? {};
	const baseOutputLimits = base.reliability?.outputLimits ?? {};
	const overrideFresh = override.reliability?.watchdog?.fresh ?? {};
	const overrideResume = override.reliability?.watchdog?.resume ?? {};
	const overrideOutputLimits = override.reliability?.outputLimits ?? {};
	return {
		...base,
		...override,
		args: override.args ?? base.args,
		env: {
			...base.env,
			...override.env
		},
		modelAliases: {
			...base.modelAliases,
			...override.modelAliases
		},
		clearEnv: Array.from(new Set([...base.clearEnv ?? [], ...override.clearEnv ?? []])),
		sessionIdFields: override.sessionIdFields ?? base.sessionIdFields,
		sessionArgs: override.sessionArgs ?? base.sessionArgs,
		resumeArgs: override.resumeArgs ?? base.resumeArgs,
		reliability: {
			...base.reliability,
			...override.reliability,
			outputLimits: {
				...baseOutputLimits,
				...overrideOutputLimits
			},
			watchdog: {
				...base.reliability?.watchdog,
				...override.reliability?.watchdog,
				fresh: {
					...baseFresh,
					...overrideFresh
				},
				resume: {
					...baseResume,
					...overrideResume
				}
			}
		}
	};
}
function resolveCliBackendConfig(provider, cfg, options = {}) {
	const normalized = normalizeBackendKey(provider);
	const normalizeContext = {
		backendId: normalized,
		...options.agentId ? { agentId: options.agentId } : {},
		...cfg ? { config: cfg } : {}
	};
	const runtimeTextTransforms = resolveRuntimeTextTransforms();
	const override = pickBackendConfig(cfg?.agents?.defaults?.cliBackends ?? {}, normalized);
	const registered = resolveRegisteredBackend(normalized);
	if (registered) {
		const merged = mergeBackendConfig(registered.config, override);
		const config = registered.normalizeConfig ? registered.normalizeConfig(merged, normalizeContext) : merged;
		const command = config.command?.trim();
		if (!command) return null;
		return {
			id: normalized,
			config: {
				...config,
				command
			},
			bundleMcp: registered.bundleMcp === true,
			bundleMcpMode: normalizeBundleMcpMode(registered.bundleMcpMode, registered.bundleMcp === true),
			pluginId: registered.pluginId,
			transformSystemPrompt: registered.transformSystemPrompt,
			textTransforms: mergePluginTextTransforms(runtimeTextTransforms, registered.textTransforms),
			defaultAuthProfileId: registered.defaultAuthProfileId,
			authEpochMode: registered.authEpochMode,
			prepareExecution: registered.prepareExecution,
			resolveExecutionArgs: registered.resolveExecutionArgs,
			nativeToolMode: registered.nativeToolMode
		};
	}
	const fallbackPolicy = resolveFallbackCliBackendPolicy(normalized);
	if (!override) {
		if (!fallbackPolicy?.baseConfig) return null;
		const baseConfig = fallbackPolicy.normalizeConfig ? fallbackPolicy.normalizeConfig(fallbackPolicy.baseConfig, normalizeContext) : fallbackPolicy.baseConfig;
		const command = baseConfig.command?.trim();
		if (!command) return null;
		return {
			id: normalized,
			config: {
				...baseConfig,
				command
			},
			bundleMcp: fallbackPolicy.bundleMcp,
			bundleMcpMode: fallbackPolicy.bundleMcpMode,
			transformSystemPrompt: fallbackPolicy.transformSystemPrompt,
			textTransforms: mergePluginTextTransforms(runtimeTextTransforms, fallbackPolicy.textTransforms),
			defaultAuthProfileId: fallbackPolicy.defaultAuthProfileId,
			authEpochMode: fallbackPolicy.authEpochMode,
			prepareExecution: fallbackPolicy.prepareExecution,
			resolveExecutionArgs: fallbackPolicy.resolveExecutionArgs,
			nativeToolMode: fallbackPolicy.nativeToolMode
		};
	}
	const mergedFallback = fallbackPolicy?.baseConfig ? mergeBackendConfig(fallbackPolicy.baseConfig, override) : override;
	const config = fallbackPolicy?.normalizeConfig ? fallbackPolicy.normalizeConfig(mergedFallback, normalizeContext) : mergedFallback;
	const command = config.command?.trim();
	if (!command) return null;
	return {
		id: normalized,
		config: {
			...config,
			command
		},
		bundleMcp: fallbackPolicy?.bundleMcp === true,
		bundleMcpMode: fallbackPolicy?.bundleMcpMode,
		transformSystemPrompt: fallbackPolicy?.transformSystemPrompt,
		textTransforms: mergePluginTextTransforms(runtimeTextTransforms, fallbackPolicy?.textTransforms),
		defaultAuthProfileId: fallbackPolicy?.defaultAuthProfileId,
		authEpochMode: fallbackPolicy?.authEpochMode,
		prepareExecution: fallbackPolicy?.prepareExecution,
		resolveExecutionArgs: fallbackPolicy?.resolveExecutionArgs,
		nativeToolMode: fallbackPolicy?.nativeToolMode
	};
}
//#endregion
//#region src/agents/cli-runner/bundle-mcp-claude.ts
function findClaudeMcpConfigPath(args) {
	if (!args?.length) return;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (arg === "--mcp-config") return normalizeOptionalString(args[i + 1]);
		if (arg.startsWith("--mcp-config=")) return normalizeOptionalString(arg.slice(13));
	}
}
function injectClaudeMcpConfigArgs(args, mcpConfigPath) {
	const next = [];
	for (let i = 0; i < (args?.length ?? 0); i += 1) {
		const arg = args?.[i] ?? "";
		if (arg === "--strict-mcp-config") continue;
		if (arg === "--mcp-config") {
			i += 1;
			continue;
		}
		if (arg.startsWith("--mcp-config=")) continue;
		next.push(arg);
	}
	next.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
	return next;
}
//#endregion
//#region src/agents/cli-runner/bundle-mcp-gemini.ts
async function readJsonObject(filePath) {
	const raw = await tryReadJson(filePath);
	return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
}
function resolveEnvPlaceholder(value, inheritedEnv) {
	const decoded = decodeHeaderEnvPlaceholder(value);
	if (!decoded) return value;
	const resolved = inheritedEnv?.[decoded.envVar] ?? process.env[decoded.envVar] ?? "";
	return decoded.bearer ? `Bearer ${resolved}` : resolved;
}
function normalizeGeminiServerConfig(server, inheritedEnv) {
	const next = {};
	applyCommonServerConfig(next, server);
	if (typeof server.type === "string") next.type = server.type;
	const headers = normalizeStringRecord(server.headers);
	if (headers) next.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, resolveEnvPlaceholder(value, inheritedEnv)]));
	if (typeof server.trust === "boolean") next.trust = server.trust;
	return next;
}
async function writeGeminiSystemSettings(mergedConfig, inheritedEnv) {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gemini-mcp-"));
	const settingsPath = path.join(tempDir, "settings.json");
	const existingSettingsPath = inheritedEnv?.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
	const base = typeof existingSettingsPath === "string" && existingSettingsPath.trim() ? await readJsonObject(existingSettingsPath) : {};
	const normalizedConfig = { mcpServers: Object.fromEntries(Object.entries(mergedConfig.mcpServers).map(([name, server]) => [name, normalizeGeminiServerConfig(server, inheritedEnv)])) };
	const settings = applyMergePatch(base, {
		mcp: { allowed: Object.keys(normalizedConfig.mcpServers) },
		mcpServers: normalizedConfig.mcpServers
	});
	if (!isRecord(settings.mcp) || !isRecord(settings.mcpServers)) throw new Error("Gemini MCP settings merge produced an invalid object");
	await writeJson(settingsPath, settings, { trailingNewline: true });
	return {
		env: {
			...inheritedEnv,
			GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath
		},
		cleanup: async () => {
			await fs.rm(tempDir, {
				recursive: true,
				force: true
			});
		}
	};
}
//#endregion
//#region src/agents/cli-runner/bundle-mcp.ts
function resolveBundleMcpMode(mode) {
	return mode ?? "claude-config-file";
}
async function readExternalMcpConfig(configPath) {
	return { mcpServers: extractMcpServerMap(await tryReadJson(configPath)) };
}
function sortJsonValue(value) {
	if (Array.isArray(value)) return value.map((entry) => sortJsonValue(entry));
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).toSorted().map((key) => [key, sortJsonValue(value[key])]));
}
function normalizeOpenClawLoopbackUrl(value) {
	const match = /^(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])):\d+(\/mcp)$/.exec(value.trim()) ?? void 0;
	if (!match) return value;
	return `${match[1]}:<openclaw-loopback>${match[2]}`;
}
function canonicalizeBundleMcpConfigForResume(config) {
	return { mcpServers: sortJsonValue(Object.fromEntries(Object.entries(config.mcpServers).map(([name, server]) => {
		if (name !== "openclaw" || typeof server.url !== "string") return [name, sortJsonValue(server)];
		return [name, sortJsonValue({
			...server,
			url: normalizeOpenClawLoopbackUrl(server.url)
		})];
	}))) };
}
async function prepareModeSpecificBundleMcpConfig(params) {
	const serializedConfig = `${JSON.stringify(params.mergedConfig, null, 2)}\n`;
	const mcpConfigHash = crypto.createHash("sha256").update(serializedConfig).digest("hex");
	const serializedResumeConfig = `${JSON.stringify(canonicalizeBundleMcpConfigForResume(params.mergedConfig), null, 2)}\n`;
	const mcpResumeHash = crypto.createHash("sha256").update(serializedResumeConfig).digest("hex");
	if (params.mode === "codex-config-overrides") return {
		backend: {
			...params.backend,
			args: injectCodexMcpConfigArgs(params.backend.args, params.mergedConfig),
			resumeArgs: injectCodexMcpConfigArgs(params.backend.resumeArgs ?? params.backend.args ?? [], params.mergedConfig)
		},
		mcpConfigHash,
		mcpResumeHash,
		env: params.env
	};
	if (params.mode === "gemini-system-settings") {
		const settings = await writeGeminiSystemSettings(params.mergedConfig, params.env);
		return {
			backend: params.backend,
			mcpConfigHash,
			mcpResumeHash,
			env: settings.env,
			cleanup: settings.cleanup
		};
	}
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-"));
	const mcpConfigPath = path.join(tempDir, "mcp.json");
	await fs.writeFile(mcpConfigPath, serializedConfig, "utf-8");
	return {
		backend: {
			...params.backend,
			args: injectClaudeMcpConfigArgs(params.backend.args, mcpConfigPath),
			resumeArgs: injectClaudeMcpConfigArgs(params.backend.resumeArgs ?? params.backend.args ?? [], mcpConfigPath)
		},
		mcpConfigHash,
		mcpResumeHash,
		env: params.env,
		cleanup: async () => {
			await fs.rm(tempDir, {
				recursive: true,
				force: true
			});
		}
	};
}
async function prepareCliBundleMcpConfig(params) {
	if (!params.enabled) return {
		backend: params.backend,
		env: params.env
	};
	const mode = resolveBundleMcpMode(params.mode);
	const existingMcpConfigPath = mode === "claude-config-file" ? findClaudeMcpConfigPath(params.backend.resumeArgs) ?? findClaudeMcpConfigPath(params.backend.args) : void 0;
	let mergedConfig = { mcpServers: {} };
	if (existingMcpConfigPath) {
		const resolvedExistingPath = path.isAbsolute(existingMcpConfigPath) ? existingMcpConfigPath : path.resolve(params.workspaceDir, existingMcpConfigPath);
		mergedConfig = applyMergePatch(mergedConfig, await readExternalMcpConfig(resolvedExistingPath));
	}
	const bundleConfig = loadMergedBundleMcpConfig({
		workspaceDir: params.workspaceDir,
		cfg: params.config,
		mapConfiguredServer: toCliBundleMcpServerConfig
	});
	for (const diagnostic of bundleConfig.diagnostics) params.warn?.(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
	mergedConfig = applyMergePatch(mergedConfig, bundleConfig.config);
	if (params.additionalConfig) mergedConfig = applyMergePatch(mergedConfig, params.additionalConfig);
	return await prepareModeSpecificBundleMcpConfig({
		mode,
		backend: params.backend,
		mergedConfig,
		env: params.env
	});
}
//#endregion
//#region src/agents/cli-runner/prepare.ts
const prepareDeps = {
	makeBootstrapWarn,
	resolveBootstrapContextForRun,
	getActiveMcpLoopbackRuntime,
	ensureMcpLoopbackServer,
	createMcpLoopbackServerConfig,
	resolveOpenClawReferencePaths: async (params) => (await import("./docs-path-B5XTsq6P.js")).resolveOpenClawReferencePaths(params),
	claudeCliSessionTranscriptHasContent
};
function shouldSkipLocalCliCredentialEpoch(params) {
	return Boolean(params.authEpochMode === "profile-only" && params.authProfileId && params.authCredential && params.preparedExecution);
}
async function prepareCliRunContext(params) {
	const started = Date.now();
	const workspaceResolution = resolveRunWorkspaceDir({
		workspaceDir: params.workspaceDir,
		sessionKey: params.sessionKey,
		agentId: params.agentId,
		config: params.config
	});
	const resolvedWorkspace = workspaceResolution.workspaceDir;
	const redactedSessionId = redactRunIdentifier(params.sessionId);
	const redactedSessionKey = redactRunIdentifier(params.sessionKey);
	const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
	if (workspaceResolution.usedFallback) cliBackendLog.warn(`[workspace-fallback] caller=runCliAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`);
	const workspaceDir = resolvedWorkspace;
	const backendResolved = resolveCliBackendConfig(params.provider, params.config, { agentId: params.agentId });
	if (!backendResolved) throw new Error(`Unknown CLI backend: ${params.provider}`);
	if (params.toolsAllow !== void 0) throw new Error(`CLI backend ${backendResolved.id} cannot enforce runtime toolsAllow; use an embedded runtime for restricted tool policy`);
	if (params.disableTools === true && backendResolved.nativeToolMode === "always-on") throw new Error(`CLI backend ${backendResolved.id} cannot run with tools disabled because it exposes native tools`);
	const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
		sessionKey: params.sessionKey,
		config: params.config,
		agentId: params.agentId
	});
	const agentDir = resolveAgentDir(params.config ?? {}, sessionAgentId);
	const effectiveAuthProfileId = (params.authProfileId?.trim() || void 0) ?? backendResolved.defaultAuthProfileId?.trim() ?? void 0;
	let authCredential;
	if (effectiveAuthProfileId) authCredential = loadAuthProfileStoreForRuntime(agentDir, {
		readOnly: true,
		externalCli: externalCliDiscoveryForProviderAuth({
			provider: params.provider,
			profileId: effectiveAuthProfileId
		})
	}).profiles[effectiveAuthProfileId];
	const extraSystemPrompt = params.extraSystemPrompt?.trim() ?? "";
	const extraSystemPromptHash = params.extraSystemPromptStatic !== void 0 ? hashCliSessionText(params.extraSystemPromptStatic.trim() || void 0) : hashCliSessionText(extraSystemPrompt);
	const modelId = (params.model ?? "default").trim() || "default";
	const normalizedModel = normalizeCliModel(modelId, backendResolved.config);
	const modelDisplay = `${params.provider}/${modelId}`;
	const sessionLabel = params.sessionKey ?? params.sessionId;
	const { bootstrapFiles, contextFiles } = await prepareDeps.resolveBootstrapContextForRun({
		workspaceDir,
		config: params.config,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		warn: prepareDeps.makeBootstrapWarn({
			sessionLabel,
			workspaceDir,
			warn: (message) => cliBackendLog.warn(message)
		})
	});
	const bootstrapMaxChars = resolveBootstrapMaxChars(params.config);
	const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config);
	const bootstrapAnalysis = analyzeBootstrapBudget({
		files: buildBootstrapInjectionStats({
			bootstrapFiles,
			injectedFiles: contextFiles
		}),
		bootstrapMaxChars,
		bootstrapTotalMaxChars
	});
	const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);
	const bootstrapPromptWarning = buildBootstrapPromptWarning({
		analysis: bootstrapAnalysis,
		mode: bootstrapPromptWarningMode,
		seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
		previousSignature: params.bootstrapPromptWarningSignature
	});
	const bundleMcpEnabled = backendResolved.bundleMcp && params.disableTools !== true;
	let mcpLoopbackRuntime = bundleMcpEnabled ? prepareDeps.getActiveMcpLoopbackRuntime() : void 0;
	if (bundleMcpEnabled && !mcpLoopbackRuntime) {
		try {
			await prepareDeps.ensureMcpLoopbackServer();
		} catch (error) {
			cliBackendLog.warn(`mcp loopback server failed to start: ${String(error)}`);
		}
		mcpLoopbackRuntime = prepareDeps.getActiveMcpLoopbackRuntime();
	}
	const preparedBackend = await prepareCliBundleMcpConfig({
		enabled: bundleMcpEnabled,
		mode: backendResolved.bundleMcpMode,
		backend: backendResolved.config,
		workspaceDir,
		config: params.config,
		additionalConfig: mcpLoopbackRuntime ? prepareDeps.createMcpLoopbackServerConfig(mcpLoopbackRuntime.port) : void 0,
		env: mcpLoopbackRuntime ? {
			OPENCLAW_MCP_TOKEN: params.senderIsOwner === true ? mcpLoopbackRuntime.ownerToken : mcpLoopbackRuntime.nonOwnerToken,
			OPENCLAW_MCP_AGENT_ID: sessionAgentId ?? "",
			OPENCLAW_MCP_ACCOUNT_ID: params.agentAccountId ?? "",
			OPENCLAW_MCP_SESSION_KEY: params.sessionKey ?? "",
			OPENCLAW_MCP_MESSAGE_CHANNEL: params.messageChannel ?? params.messageProvider ?? ""
		} : void 0,
		warn: (message) => cliBackendLog.warn(message)
	});
	const preparedExecution = await backendResolved.prepareExecution?.({
		config: params.config,
		workspaceDir,
		agentDir,
		provider: params.provider,
		modelId,
		authProfileId: effectiveAuthProfileId
	});
	const skipLocalCredentialEpoch = shouldSkipLocalCliCredentialEpoch({
		authEpochMode: backendResolved.authEpochMode,
		authProfileId: effectiveAuthProfileId,
		authCredential,
		preparedExecution
	});
	const authEpoch = await resolveCliAuthEpoch({
		provider: params.provider,
		authProfileId: effectiveAuthProfileId,
		skipLocalCredential: skipLocalCredentialEpoch
	});
	const preparedBackendEnv = preparedExecution?.env && Object.keys(preparedExecution.env).length > 0 ? {
		...preparedBackend.env,
		...preparedExecution.env
	} : preparedBackend.env;
	const preparedBackendCleanup = preparedBackend.cleanup || preparedExecution?.cleanup ? async () => {
		try {
			await preparedExecution?.cleanup?.();
		} finally {
			await preparedBackend.cleanup?.();
		}
	} : void 0;
	const preparedBackendClearEnv = [...preparedBackend.backend.clearEnv ?? [], ...preparedExecution?.clearEnv ?? []];
	const preparedBackendFinal = {
		...preparedBackend,
		backend: {
			...preparedBackend.backend,
			...preparedBackendClearEnv.length > 0 ? { clearEnv: Array.from(new Set(preparedBackendClearEnv)) } : {}
		},
		...preparedBackendEnv ? { env: preparedBackendEnv } : {},
		...preparedBackendCleanup ? { cleanup: preparedBackendCleanup } : {}
	};
	const candidateClaudeCliSessionId = params.cliSessionBinding?.sessionId?.trim() || params.cliSessionId?.trim() || void 0;
	const reusableCliSession = candidateClaudeCliSessionId !== void 0 && isClaudeCliProvider(params.provider) && !await prepareDeps.claudeCliSessionTranscriptHasContent({ sessionId: candidateClaudeCliSessionId }) ? { invalidatedReason: "missing-transcript" } : params.cliSessionBinding ? resolveCliSessionReuse({
		binding: params.cliSessionBinding,
		authProfileId: effectiveAuthProfileId,
		authEpoch,
		authEpochVersion: 4,
		extraSystemPromptHash,
		mcpConfigHash: preparedBackendFinal.mcpConfigHash,
		mcpResumeHash: preparedBackendFinal.mcpResumeHash
	}) : params.cliSessionId ? { sessionId: params.cliSessionId } : {};
	if (reusableCliSession.invalidatedReason) cliBackendLog.info(`cli session reset: provider=${params.provider} reason=${reusableCliSession.invalidatedReason}`);
	let openClawHistoryMessages;
	const loadOpenClawHistoryMessages = async () => {
		openClawHistoryMessages ??= await loadCliSessionHistoryMessages({
			sessionId: params.sessionId,
			sessionFile: params.sessionFile,
			sessionKey: params.sessionKey,
			agentId: params.agentId,
			config: params.config
		});
		return openClawHistoryMessages;
	};
	const heartbeatPrompt = resolveHeartbeatPromptForSystemPrompt({
		config: params.config,
		agentId: sessionAgentId,
		defaultAgentId
	});
	const openClawReferences = await prepareDeps.resolveOpenClawReferencePaths({
		workspaceDir,
		argv1: process.argv[1],
		cwd: process.cwd(),
		moduleUrl: import.meta.url
	});
	const skillsPrompt = resolveSkillsPromptForRun({
		skillsSnapshot: params.skillsSnapshot,
		workspaceDir,
		config: params.config,
		agentId: sessionAgentId
	});
	const builtSystemPrompt = resolveSystemPromptOverride({
		config: params.config,
		agentId: sessionAgentId
	}) ?? buildCliAgentSystemPrompt({
		workspaceDir,
		config: params.config,
		defaultThinkLevel: params.thinkLevel,
		extraSystemPrompt,
		sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
		silentReplyPromptMode: params.silentReplyPromptMode,
		ownerNumbers: params.ownerNumbers,
		heartbeatPrompt,
		docsPath: openClawReferences.docsPath ?? void 0,
		sourcePath: openClawReferences.sourcePath ?? void 0,
		skillsPrompt,
		tools: [],
		contextFiles,
		modelDisplay,
		agentId: sessionAgentId
	});
	let systemPrompt = backendResolved.transformSystemPrompt?.({
		config: params.config,
		workspaceDir,
		provider: params.provider,
		modelId,
		modelDisplay,
		agentId: sessionAgentId,
		systemPrompt: builtSystemPrompt
	}) ?? builtSystemPrompt;
	let preparedPrompt = params.prompt;
	const hookRunner = getGlobalHookRunner();
	try {
		const hookResult = await resolvePromptBuildHookResult({
			config: params.config ?? getRuntimeConfig(),
			prompt: params.prompt,
			messages: await loadOpenClawHistoryMessages(),
			hookCtx: {
				runId: params.runId,
				agentId: sessionAgentId,
				sessionKey: params.sessionKey,
				sessionId: params.sessionId,
				workspaceDir,
				modelProviderId: params.provider,
				modelId,
				trigger: params.trigger,
				...buildAgentHookContextChannelFields(params)
			},
			hookRunner
		});
		if (hookResult.prependContext) preparedPrompt = `${hookResult.prependContext}\n\n${preparedPrompt}`;
		if (hookResult.appendContext) preparedPrompt = `${preparedPrompt}\n\n${hookResult.appendContext}`;
		const hookSystemPrompt = hookResult.systemPrompt?.trim();
		if (hookSystemPrompt) systemPrompt = hookSystemPrompt;
		systemPrompt = composeSystemPromptWithHookContext({
			baseSystemPrompt: systemPrompt,
			prependSystemContext: resolveAttemptPrependSystemContext({
				sessionKey: params.sessionKey,
				trigger: params.trigger,
				hookPrependSystemContext: hookResult.prependSystemContext
			}),
			appendSystemContext: hookResult.appendSystemContext
		}) ?? systemPrompt;
	} catch (error) {
		cliBackendLog.warn(`cli prompt-build hook preparation failed: ${String(error)}`);
	}
	preparedPrompt = buildCurrentTurnPrompt({
		context: params.currentTurnContext,
		prompt: preparedPrompt
	});
	preparedPrompt = annotateInterSessionPromptText(preparedPrompt, params.inputProvenance);
	const allowRawTranscriptReseed = backendResolved.config.reseedFromRawTranscriptWhenUncompacted === true;
	const rawTranscriptReseedReason = reusableCliSession.sessionId ? "session-expired" : reusableCliSession.invalidatedReason;
	const openClawHistoryPrompt = !reusableCliSession.sessionId || allowRawTranscriptReseed ? buildCliSessionHistoryPrompt({
		messages: await loadCliSessionReseedMessages({
			sessionId: params.sessionId,
			sessionFile: params.sessionFile,
			sessionKey: params.sessionKey,
			agentId: params.agentId,
			config: params.config,
			allowRawTranscriptReseed,
			rawTranscriptReseedReason
		}),
		prompt: preparedPrompt
	}) : void 0;
	systemPrompt = appendModelIdentitySystemPrompt({
		systemPrompt: applyPluginTextReplacements(systemPrompt, backendResolved.textTransforms?.input),
		model: modelDisplay
	});
	const systemPromptReport = buildSystemPromptReport({
		source: "run",
		generatedAt: Date.now(),
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		provider: params.provider,
		model: modelId,
		workspaceDir,
		bootstrapMaxChars,
		bootstrapTotalMaxChars,
		bootstrapTruncation: buildBootstrapTruncationReportMeta({
			analysis: bootstrapAnalysis,
			warningMode: bootstrapPromptWarningMode,
			warning: bootstrapPromptWarning
		}),
		sandbox: {
			mode: "off",
			sandboxed: false
		},
		systemPrompt,
		bootstrapFiles,
		injectedFiles: contextFiles,
		skillsPrompt,
		tools: []
	});
	return {
		params: preparedPrompt === params.prompt ? params : {
			...params,
			prompt: preparedPrompt
		},
		effectiveAuthProfileId,
		started,
		workspaceDir,
		backendResolved,
		preparedBackend: preparedBackendFinal,
		reusableCliSession,
		modelId,
		normalizedModel,
		systemPrompt,
		systemPromptReport,
		bootstrapPromptWarningLines: bootstrapPromptWarning.lines,
		...openClawHistoryPrompt ? { openClawHistoryPrompt } : {},
		heartbeatPrompt,
		authEpoch,
		authEpochVersion: 4,
		extraSystemPromptHash
	};
}
//#endregion
export { prepareCliRunContext };
