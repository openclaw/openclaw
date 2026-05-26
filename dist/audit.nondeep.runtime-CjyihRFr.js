import { c as normalizeOptionalString, d as normalizeStringifiedOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { i as resolveAgentModelPrimaryValue, r as resolveAgentModelFallbackValues } from "./model-input-ChW9XXsQ.js";
import { s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { t as loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import { S as createPluginRegistryIdNormalizer, p as loadPluginRegistrySnapshot } from "./plugin-registry-CgH_ZSlH.js";
import "./scan-paths-BJFKmVji.js";
import "./auth-DZ1o6pTQ.js";
import { n as resolveGatewayAuth } from "./auth-resolve-BEn3Se6k.js";
import { r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { n as isDangerousNetworkMode, r as normalizeNetworkMode } from "./network-mode-BsO8g-R7.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { i as buildModelAliasIndex, x as resolveModelRefFromString } from "./model-selection-shared-ClxdEp4X.js";
import { i as parseModelRef, n as modelKey } from "./model-selection-normalize-CBfQo-Fd.js";
import { n as pickSandboxToolPolicy } from "./sandbox-tool-policy-A1J2EpRM.js";
import { h as resolveToolProfilePolicy } from "./tool-policy-COX5DaEj.js";
import { t as isToolAllowedByPolicies } from "./tool-policy-match-C9WqMgmG.js";
import { a as resolveProviderToolPolicy } from "./pi-tools.policy-DWPg8MXT.js";
import { r as resolveSandboxToolPolicyForAgent } from "./tool-policy-BY51AUO-.js";
import { i as resolveSandboxConfigForAgent } from "./config-CcQ2HijN.js";
import { n as listReadOnlyChannelPluginsForConfig } from "./read-only-CHBMrkWp.js";
import { t as getBlockedBindReason } from "./validate-sandbox-security-DkSeOpz8.js";
import { t as inspectReadOnlyChannelAccount } from "./read-only-account-inspect-DY5drRrW.js";
import { r as resolveNativeSkillsEnabled } from "./commands-BZM3rtIy.js";
import { i as listDangerousPluginNodeCommands, o as resolveNodeCommandAllowlist, t as DEFAULT_DANGEROUS_NODE_COMMANDS } from "./node-command-policy-Bsyvfkrl.js";
import { t as listAgentWorkspaceDirs } from "./workspace-dirs-BOQJykhE.js";
import { t as resolveAllowedAgentIds } from "./hooks-policy-ECa5-LHP.js";
import { i as readInstalledPackageVersion } from "./package-update-utils-CHd2_V9N.js";
import { t as inferParamBFromIdOrName } from "./model-param-b-Bj5BJb8S.js";
import { t as hasConfiguredInternalHooks } from "./configured-DmQDjcF5.js";
import { a as collectStateDeepFilesystemFindings, i as collectSandboxBrowserHashLabelFindings, o as readConfigSnapshotForAudit, s as shouldIgnoreInstalledPluginDirName, t as collectIncludeFilePermFindings } from "./audit-extra.async-CwvKTj2n.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/security/audit-plugins-trust.ts
let pluginTrustPolicyDepsPromise;
async function loadPluginTrustPolicyDeps() {
	pluginTrustPolicyDepsPromise ??= Promise.all([
		import("./config-DL5ZvdM-.js"),
		import("./tool-policy-rM6FxM2k.js"),
		import("./tool-policy-match-qLZ1ND6j.js"),
		import("./tool-policy-BJaSDc1y.js"),
		import("./audit-tool-policy-CkAkNNHS.js")
	]).then(([sandboxConfig, sandboxToolPolicy, toolPolicyMatch, toolPolicy, auditToolPolicy]) => ({
		isToolAllowedByPolicies: toolPolicyMatch.isToolAllowedByPolicies,
		pickSandboxToolPolicy: auditToolPolicy.pickSandboxToolPolicy,
		resolveSandboxConfigForAgent: sandboxConfig.resolveSandboxConfigForAgent,
		resolveSandboxToolPolicyForAgent: sandboxToolPolicy.resolveSandboxToolPolicyForAgent,
		resolveToolProfilePolicy: toolPolicy.resolveToolProfilePolicy
	}));
	return await pluginTrustPolicyDepsPromise;
}
function readChannelCommandSetting(cfg, channelId, key) {
	const channelCfg = cfg.channels?.[channelId];
	if (!channelCfg || typeof channelCfg !== "object" || Array.isArray(channelCfg)) return;
	const commands = channelCfg.commands;
	if (!commands || typeof commands !== "object" || Array.isArray(commands)) return;
	return commands[key];
}
async function isChannelPluginConfigured(cfg, plugin) {
	const accountIds = plugin.config.listAccountIds(cfg);
	const candidates = accountIds.length > 0 ? accountIds : [void 0];
	for (const accountId of candidates) {
		const inspected = plugin.config.inspectAccount?.(cfg, accountId) ?? await inspectReadOnlyChannelAccount({
			channelId: plugin.id,
			cfg,
			accountId
		});
		const inspectedRecord = inspected && typeof inspected === "object" && !Array.isArray(inspected) ? inspected : null;
		let resolvedAccount = inspected;
		if (!resolvedAccount) try {
			resolvedAccount = plugin.config.resolveAccount(cfg, accountId);
		} catch {
			resolvedAccount = null;
		}
		let enabled = typeof inspectedRecord?.enabled === "boolean" ? inspectedRecord.enabled : resolvedAccount != null;
		if (typeof inspectedRecord?.enabled !== "boolean" && resolvedAccount != null && plugin.config.isEnabled) try {
			enabled = plugin.config.isEnabled(resolvedAccount, cfg);
		} catch {
			enabled = false;
		}
		let configured = typeof inspectedRecord?.configured === "boolean" ? inspectedRecord.configured : resolvedAccount != null;
		if (typeof inspectedRecord?.configured !== "boolean" && resolvedAccount != null && plugin.config.isConfigured) try {
			configured = await plugin.config.isConfigured(resolvedAccount, cfg);
		} catch {
			configured = false;
		}
		if (enabled && configured) return true;
	}
	return false;
}
async function listInstalledPluginDirs(params) {
	const extensionsDir = path.join(params.stateDir, "extensions");
	if (!(await fs.stat(extensionsDir).catch((err) => {
		params.onReadError?.(err);
		return null;
	}))?.isDirectory()) return {
		extensionsDir,
		pluginDirs: []
	};
	return {
		extensionsDir,
		pluginDirs: (await fs.readdir(extensionsDir, { withFileTypes: true }).catch((err) => {
			params.onReadError?.(err);
			return [];
		})).filter((entry) => entry.isDirectory()).map((entry) => entry.name).filter((name) => !shouldIgnoreInstalledPluginDirName(name)).filter(Boolean)
	};
}
function resolveToolPolicies$2(params) {
	const profile = params.agentTools?.profile ?? params.cfg.tools?.profile;
	const policies = [
		params.deps.resolveToolProfilePolicy(profile),
		params.deps.pickSandboxToolPolicy(params.cfg.tools ?? void 0),
		params.deps.pickSandboxToolPolicy(params.agentTools)
	];
	if (params.sandboxMode === "all") policies.push(params.deps.resolveSandboxToolPolicyForAgent(params.cfg, params.agentId ?? void 0));
	return policies;
}
function normalizePluginIdSet(entries) {
	return new Set(entries.map((entry) => normalizeOptionalLowercaseString(entry)).filter((entry) => Boolean(entry)));
}
function resolveEnabledExtensionPluginIds(params) {
	const normalized = normalizePluginsConfig(params.cfg.plugins);
	if (!normalized.enabled) return [];
	const allowSet = normalizePluginIdSet(normalized.allow);
	const denySet = normalizePluginIdSet(normalized.deny);
	const entryById = /* @__PURE__ */ new Map();
	for (const [id, entry] of Object.entries(normalized.entries)) {
		const normalizedId = normalizeOptionalLowercaseString(id);
		if (!normalizedId) continue;
		entryById.set(normalizedId, entry);
	}
	const enabled = [];
	for (const id of params.pluginDirs) {
		const normalizedId = normalizeOptionalLowercaseString(id);
		if (!normalizedId) continue;
		if (denySet.has(normalizedId)) continue;
		if (allowSet.size > 0 && !allowSet.has(normalizedId)) continue;
		if (entryById.get(normalizedId)?.enabled === false) continue;
		enabled.push(normalizedId);
	}
	return enabled;
}
function collectAllowEntries(config) {
	const out = [];
	if (Array.isArray(config?.allow)) out.push(...config.allow);
	if (Array.isArray(config?.alsoAllow)) out.push(...config.alsoAllow);
	return out.map((entry) => normalizeOptionalLowercaseString(entry)).filter((entry) => Boolean(entry));
}
function hasExplicitPluginAllow(params) {
	return params.allowEntries.some((entry) => entry === "group:plugins" || params.enabledPluginIds.has(entry));
}
function hasProviderPluginAllow(params) {
	if (!params.byProvider) return false;
	for (const policy of Object.values(params.byProvider)) if (hasExplicitPluginAllow({
		allowEntries: collectAllowEntries(policy),
		enabledPluginIds: params.enabledPluginIds
	})) return true;
	return false;
}
function isPinnedRegistrySpec(spec) {
	const value = spec.trim();
	if (!value) return false;
	const at = value.lastIndexOf("@");
	if (at <= 0 || at >= value.length - 1) return false;
	const version = value.slice(at + 1).trim();
	return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}
async function collectPluginsTrustFindings(params) {
	const findings = [];
	const { extensionsDir, pluginDirs } = await listInstalledPluginDirs({ stateDir: params.stateDir });
	if (pluginDirs.length > 0) {
		const allow = params.cfg.plugins?.allow;
		const allowConfigured = Array.isArray(allow) && allow.length > 0;
		if (allowConfigured) {
			const installedPluginIds = new Set(pluginDirs.map((dir) => path.basename(dir).toLowerCase()));
			const pluginIndex = loadPluginRegistrySnapshot({
				config: params.cfg,
				stateDir: params.stateDir
			});
			const normalizePluginId = createPluginRegistryIdNormalizer(pluginIndex);
			const indexedPluginIds = new Set(pluginIndex.plugins.map((plugin) => plugin.pluginId.toLowerCase()));
			const phantomEntries = allow.filter((entry) => {
				if (typeof entry !== "string" || entry === "group:plugins") return false;
				const lower = entry.toLowerCase();
				if (installedPluginIds.has(lower) || indexedPluginIds.has(lower)) return false;
				const canonicalId = normalizeOptionalLowercaseString(normalizePluginId(entry)) ?? "";
				return !canonicalId || !indexedPluginIds.has(canonicalId);
			});
			if (phantomEntries.length > 0) findings.push({
				checkId: "plugins.allow_phantom_entries",
				severity: "warn",
				title: "plugins.allow contains entries with no matching installed plugin",
				detail: `The following plugins.allow entries do not correspond to any installed plugin: ${phantomEntries.join(", ")}.\nPhantom entries could be exploited by registering a new plugin with an allowlisted ID.`,
				remediation: "Remove unused entries from plugins.allow, or verify the expected plugins are installed."
			});
		}
		if (!allowConfigured) {
			const channelPlugins = listReadOnlyChannelPluginsForConfig(params.cfg, { stateDir: params.stateDir });
			const skillCommandsLikelyExposed = (await Promise.all(channelPlugins.map(async (plugin) => {
				if (plugin.capabilities.nativeCommands !== true && plugin.commands?.nativeSkillsAutoEnabled !== true) return false;
				if (!await isChannelPluginConfigured(params.cfg, plugin)) return false;
				return resolveNativeSkillsEnabled({
					providerId: plugin.id,
					providerSetting: readChannelCommandSetting(params.cfg, plugin.id, "nativeSkills"),
					globalSetting: params.cfg.commands?.nativeSkills,
					stateDir: params.stateDir,
					autoDefault: plugin.commands?.nativeSkillsAutoEnabled === true
				});
			}))).some(Boolean);
			findings.push({
				checkId: "plugins.extensions_no_allowlist",
				severity: skillCommandsLikelyExposed ? "critical" : "warn",
				title: "Extensions exist but plugins.allow is not set",
				detail: `Found ${pluginDirs.length} extension(s) under ${extensionsDir}. Without plugins.allow, any discovered plugin id may load (depending on config and plugin behavior).` + (skillCommandsLikelyExposed ? "\nNative skill commands are enabled on at least one configured chat surface; treat unpinned/unallowlisted extensions as high risk." : ""),
				remediation: "Set plugins.allow to an explicit list of plugin ids you trust."
			});
		}
		const enabledExtensionPluginIds = resolveEnabledExtensionPluginIds({
			cfg: params.cfg,
			pluginDirs
		});
		if (enabledExtensionPluginIds.length > 0) {
			const deps = await loadPluginTrustPolicyDeps();
			const enabledPluginSet = new Set(enabledExtensionPluginIds);
			const contexts = [{ label: "default" }];
			for (const entry of params.cfg.agents?.list ?? []) {
				if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
				contexts.push({
					label: `agents.list.${entry.id}`,
					agentId: entry.id,
					tools: entry.tools
				});
			}
			const permissiveContexts = [];
			for (const context of contexts) {
				const profile = context.tools?.profile ?? params.cfg.tools?.profile;
				const restrictiveProfile = Boolean(deps.resolveToolProfilePolicy(profile));
				const sandboxMode = deps.resolveSandboxConfigForAgent(params.cfg, context.agentId).mode;
				const policies = resolveToolPolicies$2({
					cfg: params.cfg,
					deps,
					agentTools: context.tools,
					sandboxMode,
					agentId: context.agentId
				});
				const broadPolicy = deps.isToolAllowedByPolicies("__openclaw_plugin_probe__", policies);
				const explicitPluginAllow = !restrictiveProfile && (hasExplicitPluginAllow({
					allowEntries: collectAllowEntries(params.cfg.tools),
					enabledPluginIds: enabledPluginSet
				}) || hasProviderPluginAllow({
					byProvider: params.cfg.tools?.byProvider,
					enabledPluginIds: enabledPluginSet
				}) || hasExplicitPluginAllow({
					allowEntries: collectAllowEntries(context.tools),
					enabledPluginIds: enabledPluginSet
				}) || hasProviderPluginAllow({
					byProvider: context.tools?.byProvider,
					enabledPluginIds: enabledPluginSet
				}));
				if (broadPolicy || explicitPluginAllow) permissiveContexts.push(context.label);
			}
			if (permissiveContexts.length > 0) findings.push({
				checkId: "plugins.tools_reachable_permissive_policy",
				severity: "warn",
				title: "Extension plugin tools may be reachable under permissive tool policy",
				detail: `Enabled extension plugins: ${enabledExtensionPluginIds.join(", ")}.\nPermissive tool policy contexts:\n${permissiveContexts.map((entry) => `- ${entry}`).join("\n")}`,
				remediation: "Use restrictive profiles (`minimal`/`coding`) or explicit tool allowlists that exclude plugin tools for agents handling untrusted input."
			});
		}
	}
	const pluginInstalls = await loadInstalledPluginIndexInstallRecords({ stateDir: params.stateDir });
	const npmPluginInstalls = Object.entries(pluginInstalls).filter(([, record]) => record?.source === "npm");
	if (npmPluginInstalls.length > 0) {
		const unpinned = npmPluginInstalls.filter(([, record]) => typeof record.spec === "string" && !isPinnedRegistrySpec(record.spec)).map(([pluginId, record]) => `${pluginId} (${record.spec})`);
		if (unpinned.length > 0) findings.push({
			checkId: "plugins.installs_unpinned_npm_specs",
			severity: "warn",
			title: "Plugin index includes unpinned npm specs",
			detail: `Unpinned plugin index install records:\n${unpinned.map((entry) => `- ${entry}`).join("\n")}`,
			remediation: "Pin install specs to exact versions (for example, `@scope/pkg@1.2.3`) for higher supply-chain stability."
		});
		const missingIntegrity = npmPluginInstalls.filter(([, record]) => typeof record.integrity !== "string" || record.integrity.trim() === "").map(([pluginId]) => pluginId);
		if (missingIntegrity.length > 0) findings.push({
			checkId: "plugins.installs_missing_integrity",
			severity: "warn",
			title: "Plugin index is missing integrity metadata",
			detail: `Plugin index records missing integrity:\n${missingIntegrity.map((entry) => `- ${entry}`).join("\n")}`,
			remediation: "Reinstall or update plugins to refresh install metadata with resolved integrity hashes."
		});
		const pluginVersionDrift = [];
		for (const [pluginId, record] of npmPluginInstalls) {
			const recordedVersion = record.resolvedVersion ?? record.version;
			if (!recordedVersion) continue;
			const installedVersion = await readInstalledPackageVersion(record.installPath ?? path.join(params.stateDir, "extensions", pluginId));
			if (!installedVersion || installedVersion === recordedVersion) continue;
			pluginVersionDrift.push(`${pluginId} (recorded ${recordedVersion}, installed ${installedVersion})`);
		}
		if (pluginVersionDrift.length > 0) findings.push({
			checkId: "plugins.installs_version_drift",
			severity: "warn",
			title: "Plugin index records drift from installed package versions",
			detail: `Detected plugin install metadata drift:\n${pluginVersionDrift.map((entry) => `- ${entry}`).join("\n")}`,
			remediation: "Run `openclaw plugins update --all` (or reinstall affected plugins) to refresh install metadata."
		});
	}
	const hookInstalls = params.cfg.hooks?.internal?.installs ?? {};
	const npmHookInstalls = Object.entries(hookInstalls).filter(([, record]) => record?.source === "npm");
	if (npmHookInstalls.length > 0) {
		const unpinned = npmHookInstalls.filter(([, record]) => typeof record.spec === "string" && !isPinnedRegistrySpec(record.spec)).map(([hookId, record]) => `${hookId} (${record.spec})`);
		if (unpinned.length > 0) findings.push({
			checkId: "hooks.installs_unpinned_npm_specs",
			severity: "warn",
			title: "Hook installs include unpinned npm specs",
			detail: `Unpinned hook install records:\n${unpinned.map((entry) => `- ${entry}`).join("\n")}`,
			remediation: "Pin hook install specs to exact versions (for example, `@scope/pkg@1.2.3`) for higher supply-chain stability."
		});
		const missingIntegrity = npmHookInstalls.filter(([, record]) => typeof record.integrity !== "string" || record.integrity.trim() === "").map(([hookId]) => hookId);
		if (missingIntegrity.length > 0) findings.push({
			checkId: "hooks.installs_missing_integrity",
			severity: "warn",
			title: "Hook installs are missing integrity metadata",
			detail: `Hook install records missing integrity:\n${missingIntegrity.map((entry) => `- ${entry}`).join("\n")}`,
			remediation: "Reinstall or update hooks to refresh install metadata with resolved integrity hashes."
		});
		const hookVersionDrift = [];
		for (const [hookId, record] of npmHookInstalls) {
			const recordedVersion = record.resolvedVersion ?? record.version;
			if (!recordedVersion) continue;
			const installedVersion = await readInstalledPackageVersion(record.installPath ?? path.join(params.stateDir, "hooks", hookId));
			if (!installedVersion || installedVersion === recordedVersion) continue;
			hookVersionDrift.push(`${hookId} (recorded ${recordedVersion}, installed ${installedVersion})`);
		}
		if (hookVersionDrift.length > 0) findings.push({
			checkId: "hooks.installs_version_drift",
			severity: "warn",
			title: "Hook install records drift from installed package versions",
			detail: `Detected hook install metadata drift:\n${hookVersionDrift.map((entry) => `- ${entry}`).join("\n")}`,
			remediation: "Run `openclaw hooks update --all` (or reinstall affected hooks) to refresh install metadata."
		});
	}
	return findings;
}
//#endregion
//#region src/plugins/web-search-credential-presence.ts
function hasConfiguredCredentialValue(value) {
	if (typeof value === "string") return value.trim().length > 0;
	return value !== void 0 && value !== null;
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function hasConfiguredSearchCredentialCandidate(searchConfig) {
	if (!isRecord(searchConfig)) return false;
	return Object.entries(searchConfig).some(([key, value]) => key !== "enabled" && hasConfiguredCredentialValue(value));
}
function hasConfiguredPluginWebSearchCandidate(config) {
	const entries = isRecord(config.plugins?.entries) ? config.plugins.entries : void 0;
	if (!entries) return false;
	return Object.values(entries).some((entry) => {
		const pluginConfig = isRecord(entry) ? entry.config : void 0;
		return isRecord(pluginConfig) && hasConfiguredSearchCredentialCandidate(pluginConfig.webSearch);
	});
}
function hasManifestWebSearchEnvCredentialCandidate(params) {
	const env = params.env;
	if (!env) return false;
	return loadManifestMetadataSnapshot({
		config: params.config,
		env
	}).plugins.some((plugin) => {
		if (params.origin && plugin.origin !== params.origin) return false;
		if ((plugin.contracts?.webSearchProviders?.length ?? 0) === 0) return false;
		const providerAuthEnvVars = plugin.providerAuthEnvVars;
		if (!providerAuthEnvVars) return false;
		return Object.values(providerAuthEnvVars).flat().some((envVar) => hasConfiguredCredentialValue(env[envVar]));
	});
}
function hasConfiguredWebSearchCredential(params) {
	return hasConfiguredSearchCredentialCandidate(params.searchConfig ?? params.config.tools?.web?.search) || hasConfiguredPluginWebSearchCandidate(params.config) || hasManifestWebSearchEnvCredentialCandidate({
		config: params.config,
		env: params.env,
		origin: params.origin
	});
}
//#endregion
//#region src/security/audit-model-refs.ts
function resolveAuditModelId(cfg, raw, aliasIndex) {
	const resolved = resolveModelRefFromString({
		cfg,
		raw,
		defaultProvider: DEFAULT_PROVIDER,
		aliasIndex,
		allowPluginNormalization: false
	})?.ref;
	return resolved ? modelKey(resolved.provider, resolved.model) : raw;
}
function addModelRef(params) {
	if (typeof params.raw !== "string") return;
	const raw = params.raw.trim();
	if (!raw) return;
	params.out.push({
		id: resolveAuditModelId(params.cfg, raw, params.aliasIndex),
		source: params.source
	});
}
function collectAuditModelRefs(cfg) {
	const aliasIndex = buildModelAliasIndex({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		allowPluginNormalization: false
	});
	const out = [];
	const add = (raw, source) => addModelRef({
		out,
		cfg,
		aliasIndex,
		raw,
		source
	});
	add(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model), "agents.defaults.model.primary");
	for (const fallback of resolveAgentModelFallbackValues(cfg.agents?.defaults?.model)) add(fallback, "agents.defaults.model.fallbacks");
	add(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel), "agents.defaults.imageModel.primary");
	for (const fallback of resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel)) add(fallback, "agents.defaults.imageModel.fallbacks");
	const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	for (const agent of list) {
		if (!agent || typeof agent !== "object") continue;
		const id = typeof agent.id === "string" ? agent.id : "";
		const model = agent.model;
		if (typeof model === "string") add(model, `agents.list.${id}.model`);
		else if (model && typeof model === "object") {
			add(model.primary, `agents.list.${id}.model.primary`);
			const fallbacks = model.fallbacks;
			if (Array.isArray(fallbacks)) for (const fallback of fallbacks) add(fallback, `agents.list.${id}.model.fallbacks`);
		}
	}
	return out;
}
//#endregion
//#region src/security/audit-extra.summary.ts
const SMALL_MODEL_PARAM_B_MAX = 300;
function summarizeGroupPolicy(cfg) {
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object") return {
		open: 0,
		allowlist: 0,
		other: 0
	};
	let open = 0;
	let allowlist = 0;
	let other = 0;
	for (const value of Object.values(channels)) {
		if (!value || typeof value !== "object") continue;
		const policy = value.groupPolicy;
		if (policy === "open") open += 1;
		else if (policy === "allowlist") allowlist += 1;
		else other += 1;
	}
	return {
		open,
		allowlist,
		other
	};
}
function extractAgentIdFromSource(source) {
	return source.match(/^agents\.list\.([^.]*)\./)?.[1] ?? null;
}
function resolveToolPolicies$1(params) {
	const policies = [];
	const profilePolicy = resolveToolProfilePolicy(params.agentTools?.profile ?? params.cfg.tools?.profile);
	if (profilePolicy) policies.push(profilePolicy);
	const globalPolicy = pickSandboxToolPolicy(params.cfg.tools ?? void 0);
	if (globalPolicy) policies.push(globalPolicy);
	const agentPolicy = pickSandboxToolPolicy(params.agentTools);
	if (agentPolicy) policies.push(agentPolicy);
	const globalProviderPolicy = resolveProviderToolPolicy({
		byProvider: params.cfg.tools?.byProvider,
		modelProvider: params.modelProvider,
		modelId: params.modelId
	});
	if (globalProviderPolicy) policies.push(globalProviderPolicy);
	const agentProviderPolicy = resolveProviderToolPolicy({
		byProvider: params.agentTools?.byProvider,
		modelProvider: params.modelProvider,
		modelId: params.modelId
	});
	if (agentProviderPolicy) policies.push(agentProviderPolicy);
	if (params.sandboxMode === "all") policies.push(resolveSandboxToolPolicyForAgent(params.cfg, params.agentId ?? void 0));
	return policies;
}
function hasWebSearchKey(cfg, env) {
	return hasConfiguredWebSearchCredential({
		config: cfg,
		env,
		origin: "bundled",
		bundledAllowlistCompat: true
	});
}
function isWebSearchEnabled(cfg, env) {
	const enabled = cfg.tools?.web?.search?.enabled;
	if (enabled === false) return false;
	if (enabled === true) return true;
	return hasWebSearchKey(cfg, env);
}
function isWebFetchEnabled(cfg) {
	if (cfg.tools?.web?.fetch?.enabled === false) return false;
	return true;
}
function isBrowserEnabled(cfg) {
	return cfg.browser?.enabled !== false;
}
function collectAttackSurfaceSummaryFindings(cfg) {
	const group = summarizeGroupPolicy(cfg);
	const elevated = cfg.tools?.elevated?.enabled !== false;
	const webhooksEnabled = cfg.hooks?.enabled === true;
	const internalHooksEnabled = hasConfiguredInternalHooks(cfg);
	const browserEnabled = cfg.browser?.enabled ?? true;
	return [{
		checkId: "summary.attack_surface",
		severity: "info",
		title: "Attack surface summary",
		detail: `groups: open=${group.open}, allowlist=${group.allowlist}\ntools.elevated: ${elevated ? "enabled" : "disabled"}\nhooks.webhooks: ${webhooksEnabled ? "enabled" : "disabled"}\nhooks.internal: ${internalHooksEnabled ? "enabled" : "disabled"}\nbrowser control: ${browserEnabled ? "enabled" : "disabled"}\ntrust model: personal assistant (one trusted operator boundary), not hostile multi-tenant on one shared gateway`
	}];
}
function collectSmallModelRiskFindings(params) {
	const findings = [];
	const models = collectAuditModelRefs(params.cfg).filter((entry) => !entry.source.includes("imageModel"));
	if (models.length === 0) return findings;
	const smallModels = models.map((entry) => {
		const paramB = inferParamBFromIdOrName(entry.id);
		if (!paramB || paramB > SMALL_MODEL_PARAM_B_MAX) return null;
		return {
			...entry,
			paramB
		};
	}).filter((entry) => Boolean(entry));
	if (smallModels.length === 0) return findings;
	let hasUnsafe = false;
	const modelLines = [];
	const exposureSet = /* @__PURE__ */ new Set();
	for (const entry of smallModels) {
		const agentId = extractAgentIdFromSource(entry.source);
		const modelRef = parseModelRef(entry.id, "openai", { allowPluginNormalization: false });
		const sandboxMode = resolveSandboxConfigForAgent(params.cfg, agentId ?? void 0).mode;
		const agentTools = agentId && params.cfg.agents?.list ? params.cfg.agents.list.find((agent) => agent?.id === agentId)?.tools : void 0;
		const policies = resolveToolPolicies$1({
			cfg: params.cfg,
			agentTools,
			sandboxMode,
			agentId,
			modelProvider: modelRef?.provider,
			modelId: modelRef?.model
		});
		const exposed = [];
		if (isWebSearchEnabled(params.cfg, params.env) && isToolAllowedByPolicies("web_search", policies)) exposed.push("web_search");
		if (isWebFetchEnabled(params.cfg) && isToolAllowedByPolicies("web_fetch", policies)) exposed.push("web_fetch");
		if (isBrowserEnabled(params.cfg) && isToolAllowedByPolicies("browser", policies)) exposed.push("browser");
		for (const tool of exposed) exposureSet.add(tool);
		const sandboxLabel = sandboxMode === "all" ? "sandbox=all" : `sandbox=${sandboxMode}`;
		const exposureLabel = exposed.length > 0 ? ` web=[${exposed.join(", ")}]` : " web=[off]";
		const safe = exposed.length === 0;
		if (!safe) hasUnsafe = true;
		const statusLabel = safe ? "ok" : "unsafe";
		modelLines.push(`- ${entry.id} (${entry.paramB}B) @ ${entry.source} (${statusLabel}; ${sandboxLabel};${exposureLabel})`);
	}
	const exposureList = Array.from(exposureSet);
	const exposureDetail = exposureList.length > 0 ? `Uncontrolled input tools allowed: ${exposureList.join(", ")}.` : "No web/browser tools detected for these models.";
	findings.push({
		checkId: "models.small_params",
		severity: hasUnsafe ? "critical" : "info",
		title: "Small models require sandboxing and web tools disabled",
		detail: `Small models (<=${SMALL_MODEL_PARAM_B_MAX}B params) detected:\n` + modelLines.join("\n") + `\n` + exposureDetail + "\nSmall models are not recommended for untrusted inputs.",
		remediation: "If you must use small models, disable web_search/web_fetch/browser globally or for each small model with tools.byProvider[\"provider/model\"].deny=[\"group:web\",\"browser\"]; use agents.defaults.sandbox.mode=\"all\" for defense in depth."
	});
	return findings;
}
//#endregion
//#region src/security/audit-extra.sync.ts
function isProbablySyncedPath(p) {
	const s = p.toLowerCase();
	return s.includes("icloud") || s.includes("dropbox") || s.includes("google drive") || s.includes("googledrive") || s.includes("onedrive");
}
function looksLikeEnvRef(value) {
	const v = value.trim();
	return v.startsWith("${") && v.endsWith("}");
}
function isGatewayRemotelyExposed(cfg) {
	if ((typeof cfg.gateway?.bind === "string" ? cfg.gateway.bind : "loopback") !== "loopback") return true;
	const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
	return tailscaleMode === "serve" || tailscaleMode === "funnel";
}
const LEGACY_MODEL_PATTERNS = [
	{
		id: "openai.gpt35",
		re: /\bgpt-3\.5\b/i,
		label: "GPT-3.5 family"
	},
	{
		id: "anthropic.claude2",
		re: /\bclaude-(instant|2)\b/i,
		label: "Claude 2/Instant family"
	},
	{
		id: "openai.gpt4_legacy",
		re: /\bgpt-4-(0314|0613)\b/i,
		label: "Legacy GPT-4 snapshots"
	}
];
const WEAK_TIER_MODEL_PATTERNS = [{
	id: "anthropic.haiku",
	re: /\bhaiku\b/i,
	label: "Haiku tier (smaller model)"
}];
function isGptModel(id) {
	return /\bgpt-/i.test(id);
}
function isGpt5OrHigher(id) {
	return /\bgpt-5(?:\b|[.-])/i.test(id);
}
function isClaudeModel(id) {
	return /\bclaude-/i.test(id);
}
function isClaude45OrHigher(id) {
	return /\bclaude-[^\s/]*?(?:-4-?(?:[5-9]|[1-9]\d)\b|4\.(?:[5-9]|[1-9]\d)\b|-[5-9](?:\b|[.-]))/i.test(id);
}
function hasConfiguredDockerConfig(docker) {
	if (!docker || typeof docker !== "object") return false;
	return Object.values(docker).some((value) => value !== void 0);
}
function normalizeNodeCommand(value) {
	return normalizeOptionalString(value) ?? "";
}
function isWildcardEntry(value) {
	return normalizeStringifiedOptionalString(value) === "*";
}
function listKnownNodeCommands(cfg) {
	const baseCfg = {
		...cfg,
		gateway: {
			...cfg.gateway,
			nodes: {
				...cfg.gateway?.nodes,
				denyCommands: []
			}
		}
	};
	const out = /* @__PURE__ */ new Set();
	for (const node of [
		{
			platform: "ios",
			deviceFamily: "iPhone"
		},
		{
			platform: "android",
			deviceFamily: "Android"
		},
		{
			platform: "macos",
			deviceFamily: "Mac",
			approvedCommands: [
				"system.run",
				"system.run.prepare",
				"system.which",
				"browser.proxy",
				"screen.snapshot"
			]
		},
		{
			platform: "linux",
			deviceFamily: "Linux",
			approvedCommands: [
				"system.run",
				"system.run.prepare",
				"system.which",
				"browser.proxy"
			]
		},
		{
			platform: "windows",
			deviceFamily: "Windows",
			approvedCommands: [
				"system.run",
				"system.run.prepare",
				"system.which",
				"browser.proxy",
				"screen.snapshot"
			]
		},
		{ platform: "unknown" }
	]) {
		const allow = resolveNodeCommandAllowlist(baseCfg, node);
		for (const cmd of allow) {
			const normalized = normalizeNodeCommand(cmd);
			if (normalized) out.add(normalized);
		}
	}
	for (const cmd of resolveNodeCommandAllowlist(baseCfg, { caps: ["talk"] })) {
		const normalized = normalizeNodeCommand(cmd);
		if (normalized) out.add(normalized);
	}
	for (const cmd of DEFAULT_DANGEROUS_NODE_COMMANDS) {
		const normalized = normalizeNodeCommand(cmd);
		if (normalized) out.add(normalized);
	}
	return out;
}
function resolveToolPolicies(params) {
	const policies = [];
	const profilePolicy = resolveToolProfilePolicy(params.agentTools?.profile ?? params.cfg.tools?.profile);
	if (profilePolicy) policies.push(profilePolicy);
	const globalPolicy = pickSandboxToolPolicy(params.cfg.tools ?? void 0);
	if (globalPolicy) policies.push(globalPolicy);
	const agentPolicy = pickSandboxToolPolicy(params.agentTools);
	if (agentPolicy) policies.push(agentPolicy);
	if (params.sandboxMode === "all") policies.push(resolveSandboxToolPolicyForAgent(params.cfg, params.agentId ?? void 0));
	return policies;
}
function looksLikeNodeCommandPattern(value) {
	if (!value) return false;
	if (/[?*[\]{}(),|]/.test(value)) return true;
	if (value.startsWith("/") || value.endsWith("/") || value.startsWith("^") || value.endsWith("$")) return true;
	return /\s/.test(value) || value.includes("group:");
}
function editDistance(a, b) {
	if (a === b) return 0;
	if (!a) return b.length;
	if (!b) return a.length;
	const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const temp = dp[j];
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
			prev = temp;
		}
	}
	return dp[b.length];
}
function suggestKnownNodeCommands(unknown, known) {
	const needle = unknown.trim();
	if (!needle) return [];
	const prefix = needle.includes(".") ? needle.split(".").slice(0, 2).join(".") : needle;
	const prefixHits = Array.from(known).filter((cmd) => cmd.startsWith(prefix)).slice(0, 3);
	if (prefixHits.length > 0) return prefixHits;
	const ranked = Array.from(known).map((cmd) => ({
		cmd,
		d: editDistance(needle, cmd)
	})).toSorted((a, b) => a.d - b.d || a.cmd.localeCompare(b.cmd));
	const best = ranked[0]?.d ?? Infinity;
	const threshold = Math.max(2, Math.min(4, best));
	return ranked.filter((r) => r.d <= threshold).slice(0, 3).map((r) => r.cmd);
}
function listGroupPolicyOpen(cfg) {
	const out = [];
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object") return out;
	for (const [channelId, value] of Object.entries(channels)) {
		if (!value || typeof value !== "object") continue;
		const section = value;
		if (section.groupPolicy === "open") out.push(`channels.${channelId}.groupPolicy`);
		const accounts = section.accounts;
		if (accounts && typeof accounts === "object") for (const [accountId, accountVal] of Object.entries(accounts)) {
			if (!accountVal || typeof accountVal !== "object") continue;
			if (accountVal.groupPolicy === "open") out.push(`channels.${channelId}.accounts.${accountId}.groupPolicy`);
		}
	}
	return out;
}
function hasConfiguredGroupTargets(section) {
	return [
		"groups",
		"guilds",
		"channels",
		"rooms"
	].some((key) => {
		const value = section[key];
		return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
	});
}
function listPotentialMultiUserSignals(cfg) {
	const out = /* @__PURE__ */ new Set();
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object") return [];
	const inspectSection = (section, basePath) => {
		const groupPolicy = typeof section.groupPolicy === "string" ? section.groupPolicy : null;
		if (groupPolicy === "open") out.add(`${basePath}.groupPolicy="open"`);
		else if (groupPolicy === "allowlist" && hasConfiguredGroupTargets(section)) out.add(`${basePath}.groupPolicy="allowlist" with configured group targets`);
		if ((typeof section.dmPolicy === "string" ? section.dmPolicy : null) === "open") out.add(`${basePath}.dmPolicy="open"`);
		if ((Array.isArray(section.allowFrom) ? section.allowFrom : []).some((entry) => isWildcardEntry(entry))) out.add(`${basePath}.allowFrom includes "*"`);
		if ((Array.isArray(section.groupAllowFrom) ? section.groupAllowFrom : []).some((entry) => isWildcardEntry(entry))) out.add(`${basePath}.groupAllowFrom includes "*"`);
		const dm = section.dm;
		if (dm && typeof dm === "object") {
			const dmSection = dm;
			if ((typeof dmSection.policy === "string" ? dmSection.policy : null) === "open") out.add(`${basePath}.dm.policy="open"`);
			if ((Array.isArray(dmSection.allowFrom) ? dmSection.allowFrom : []).some((entry) => isWildcardEntry(entry))) out.add(`${basePath}.dm.allowFrom includes "*"`);
		}
	};
	for (const [channelId, value] of Object.entries(channels)) {
		if (!value || typeof value !== "object") continue;
		const section = value;
		inspectSection(section, `channels.${channelId}`);
		const accounts = section.accounts;
		if (!accounts || typeof accounts !== "object") continue;
		for (const [accountId, accountValue] of Object.entries(accounts)) {
			if (!accountValue || typeof accountValue !== "object") continue;
			inspectSection(accountValue, `channels.${channelId}.accounts.${accountId}`);
		}
	}
	return Array.from(out);
}
function collectRiskyToolExposureContexts(cfg) {
	const contexts = [{ label: "agents.defaults" }];
	for (const agent of cfg.agents?.list ?? []) {
		if (!agent || typeof agent !== "object" || typeof agent.id !== "string") continue;
		contexts.push({
			label: `agents.list.${agent.id}`,
			agentId: agent.id,
			tools: agent.tools
		});
	}
	const riskyContexts = [];
	let hasRuntimeRisk = false;
	for (const context of contexts) {
		const sandboxMode = resolveSandboxConfigForAgent(cfg, context.agentId).mode;
		const policies = resolveToolPolicies({
			cfg,
			agentTools: context.tools,
			sandboxMode,
			agentId: context.agentId ?? null
		});
		const runtimeTools = ["exec", "process"].filter((tool) => isToolAllowedByPolicies(tool, policies));
		const fsTools = [
			"read",
			"write",
			"edit",
			"apply_patch"
		].filter((tool) => isToolAllowedByPolicies(tool, policies));
		const fsWorkspaceOnly = context.tools?.fs?.workspaceOnly ?? cfg.tools?.fs?.workspaceOnly;
		const runtimeUnguarded = runtimeTools.length > 0 && sandboxMode !== "all";
		const fsUnguarded = fsTools.length > 0 && sandboxMode !== "all" && fsWorkspaceOnly !== true;
		if (!runtimeUnguarded && !fsUnguarded) continue;
		if (runtimeUnguarded) hasRuntimeRisk = true;
		riskyContexts.push(`${context.label} (sandbox=${sandboxMode}; runtime=[${runtimeTools.join(", ") || "off"}]; fs=[${fsTools.join(", ") || "off"}]; fs.workspaceOnly=${fsWorkspaceOnly === true ? "true" : "false"})`);
	}
	return {
		riskyContexts,
		hasRuntimeRisk
	};
}
function collectSyncedFolderFindings(params) {
	const findings = [];
	if (isProbablySyncedPath(params.stateDir) || isProbablySyncedPath(params.configPath)) findings.push({
		checkId: "fs.synced_dir",
		severity: "warn",
		title: "State/config path looks like a synced folder",
		detail: `stateDir=${params.stateDir}, configPath=${params.configPath}. Synced folders (iCloud/Dropbox/OneDrive/Google Drive) can leak tokens and transcripts onto other devices.`,
		remediation: `Keep OPENCLAW_STATE_DIR on a local-only volume and re-run "${formatCliCommand("openclaw security audit --fix")}".`
	});
	return findings;
}
function collectSecretsInConfigFindings(cfg) {
	const findings = [];
	const password = normalizeOptionalString(cfg.gateway?.auth?.password) ?? "";
	if (password && !looksLikeEnvRef(password)) findings.push({
		checkId: "config.secrets.gateway_password_in_config",
		severity: "warn",
		title: "Gateway password is stored in config",
		detail: "gateway.auth.password is set in the config file; prefer environment variables for secrets when possible.",
		remediation: "Prefer OPENCLAW_GATEWAY_PASSWORD (env) and remove gateway.auth.password from disk."
	});
	const hooksToken = normalizeOptionalString(cfg.hooks?.token) ?? "";
	if (cfg.hooks?.enabled === true && hooksToken && !looksLikeEnvRef(hooksToken)) findings.push({
		checkId: "config.secrets.hooks_token_in_config",
		severity: "info",
		title: "Hooks token is stored in config",
		detail: "hooks.token is set in the config file; keep config perms tight and treat it like an API secret."
	});
	return findings;
}
function collectHooksHardeningFindings(cfg, env = process.env) {
	const findings = [];
	if (cfg.hooks?.enabled !== true) return findings;
	const token = normalizeOptionalString(cfg.hooks?.token) ?? "";
	if (token && token.length < 24) findings.push({
		checkId: "hooks.token_too_short",
		severity: "warn",
		title: "Hooks token looks short",
		detail: `hooks.token is ${token.length} chars; prefer a long random token.`
	});
	const gatewayAuth = resolveGatewayAuth({
		authConfig: cfg.gateway?.auth,
		tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
		env
	});
	const openclawGatewayToken = typeof env.OPENCLAW_GATEWAY_TOKEN === "string" && env.OPENCLAW_GATEWAY_TOKEN.trim() ? env.OPENCLAW_GATEWAY_TOKEN.trim() : null;
	const gatewayToken = gatewayAuth.mode === "token" && typeof gatewayAuth.token === "string" && gatewayAuth.token.trim() ? gatewayAuth.token.trim() : openclawGatewayToken ? openclawGatewayToken : null;
	if (token && gatewayToken && token === gatewayToken) findings.push({
		checkId: "hooks.token_reuse_gateway_token",
		severity: "critical",
		title: "Hooks token reuses the Gateway token",
		detail: "hooks.token matches gateway.auth token; compromise of hooks expands blast radius to the Gateway API.",
		remediation: "Use a separate hooks.token dedicated to hook ingress."
	});
	if ((normalizeOptionalString(cfg.hooks?.path) ?? "") === "/") findings.push({
		checkId: "hooks.path_root",
		severity: "critical",
		title: "Hooks base path is '/'",
		detail: "hooks.path='/' would shadow other HTTP endpoints and is unsafe.",
		remediation: "Use a dedicated path like '/hooks'."
	});
	const allowRequestSessionKey = cfg.hooks?.allowRequestSessionKey === true;
	const defaultSessionKey = normalizeOptionalString(cfg.hooks?.defaultSessionKey) ?? "";
	const allowedAgentIds = resolveAllowedAgentIds(cfg.hooks?.allowedAgentIds);
	const allowedPrefixes = Array.isArray(cfg.hooks?.allowedSessionKeyPrefixes) ? cfg.hooks.allowedSessionKeyPrefixes.map((prefix) => prefix.trim()).filter((prefix) => prefix.length > 0) : [];
	const remoteExposure = isGatewayRemotelyExposed(cfg);
	if (!defaultSessionKey) findings.push({
		checkId: "hooks.default_session_key_unset",
		severity: "warn",
		title: "hooks.defaultSessionKey is not configured",
		detail: "Hook agent runs without explicit sessionKey use generated per-request keys. Set hooks.defaultSessionKey to keep hook ingress scoped to a known session.",
		remediation: "Set hooks.defaultSessionKey (for example, \"hook:ingress\")."
	});
	if (allowedAgentIds === void 0) findings.push({
		checkId: "hooks.allowed_agent_ids_unrestricted",
		severity: remoteExposure ? "critical" : "warn",
		title: "Hook agent routing allows any configured agent",
		detail: "hooks.allowedAgentIds is unset or includes '*', so authenticated hook callers may route to any configured agent id.",
		remediation: "Set hooks.allowedAgentIds to an explicit allowlist (for example, [\"hooks\", \"main\"]) or [] to deny explicit agent routing."
	});
	if (allowRequestSessionKey) findings.push({
		checkId: "hooks.request_session_key_enabled",
		severity: remoteExposure ? "critical" : "warn",
		title: "External hook payloads may override sessionKey",
		detail: "hooks.allowRequestSessionKey=true allows `/hooks/agent` callers to choose the session key. Treat hook token holders as full-trust unless you also restrict prefixes.",
		remediation: "Set hooks.allowRequestSessionKey=false (recommended) or constrain hooks.allowedSessionKeyPrefixes."
	});
	if (allowRequestSessionKey && allowedPrefixes.length === 0) findings.push({
		checkId: "hooks.request_session_key_prefixes_missing",
		severity: remoteExposure ? "critical" : "warn",
		title: "Request sessionKey override is enabled without prefix restrictions",
		detail: "hooks.allowRequestSessionKey=true and hooks.allowedSessionKeyPrefixes is unset/empty, so request payloads can target arbitrary session key shapes.",
		remediation: "Set hooks.allowedSessionKeyPrefixes (for example, [\"hook:\"]) or disable request overrides."
	});
	return findings;
}
function collectGatewayHttpSessionKeyOverrideFindings(cfg) {
	const findings = [];
	const chatCompletionsEnabled = cfg.gateway?.http?.endpoints?.chatCompletions?.enabled === true;
	const responsesEnabled = cfg.gateway?.http?.endpoints?.responses?.enabled === true;
	if (!chatCompletionsEnabled && !responsesEnabled) return findings;
	const enabledEndpoints = [chatCompletionsEnabled ? "/v1/chat/completions" : null, responsesEnabled ? "/v1/responses" : null].filter((entry) => Boolean(entry));
	findings.push({
		checkId: "gateway.http.session_key_override_enabled",
		severity: "info",
		title: "HTTP API session-key override is enabled",
		detail: `${enabledEndpoints.join(", ")} accept x-openclaw-session-key for per-request session routing. Treat API credential holders as trusted principals.`
	});
	return findings;
}
function collectGatewayHttpNoAuthFindings(cfg, env) {
	const findings = [];
	const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
	if (resolveGatewayAuth({
		authConfig: cfg.gateway?.auth,
		tailscaleMode,
		env
	}).mode !== "none") return findings;
	const chatCompletionsEnabled = cfg.gateway?.http?.endpoints?.chatCompletions?.enabled === true;
	const responsesEnabled = cfg.gateway?.http?.endpoints?.responses?.enabled === true;
	const adminHttpRpcEnabled = cfg.plugins?.entries?.["admin-http-rpc"]?.enabled === true;
	const enabledEndpoints = [
		"/tools/invoke",
		chatCompletionsEnabled ? "/v1/chat/completions" : null,
		responsesEnabled ? "/v1/responses" : null,
		adminHttpRpcEnabled ? "/api/v1/admin/rpc" : null
	].filter((entry) => Boolean(entry));
	const remoteExposure = isGatewayRemotelyExposed(cfg);
	findings.push({
		checkId: "gateway.http.no_auth",
		severity: remoteExposure ? "critical" : "warn",
		title: "Gateway HTTP APIs are reachable without auth",
		detail: `gateway.auth.mode="none" leaves ${enabledEndpoints.join(", ")} callable without a shared secret. Treat this as trusted-local only and avoid exposing the gateway beyond loopback.`,
		remediation: "Set gateway.auth.mode to token/password (recommended). If you intentionally keep mode=none, keep gateway.bind=loopback and disable optional HTTP endpoints/plugins."
	});
	return findings;
}
function collectSandboxDockerNoopFindings(cfg) {
	const findings = [];
	const configuredPaths = [];
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	const defaultsSandbox = cfg.agents?.defaults?.sandbox;
	const hasDefaultDocker = hasConfiguredDockerConfig(defaultsSandbox?.docker);
	const defaultMode = defaultsSandbox?.mode ?? "off";
	const hasAnySandboxEnabledAgent = agents.some((entry) => {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string") return false;
		return resolveSandboxConfigForAgent(cfg, entry.id).mode !== "off";
	});
	if (hasDefaultDocker && defaultMode === "off" && !hasAnySandboxEnabledAgent) configuredPaths.push("agents.defaults.sandbox.docker");
	for (const entry of agents) {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
		if (!hasConfiguredDockerConfig(entry.sandbox?.docker)) continue;
		if (resolveSandboxConfigForAgent(cfg, entry.id).mode === "off") configuredPaths.push(`agents.list.${entry.id}.sandbox.docker`);
	}
	if (configuredPaths.length === 0) return findings;
	findings.push({
		checkId: "sandbox.docker_config_mode_off",
		severity: "warn",
		title: "Sandbox docker settings configured while sandbox mode is off",
		detail: "These docker settings will not take effect until sandbox mode is enabled:\n" + configuredPaths.map((entry) => `- ${entry}`).join("\n"),
		remediation: "Enable sandbox mode (`agents.defaults.sandbox.mode=\"non-main\"` or `\"all\"`) where needed, or remove unused docker settings."
	});
	return findings;
}
function collectSandboxDangerousConfigFindings(cfg) {
	const findings = [];
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	const configs = [];
	const defaultDocker = cfg.agents?.defaults?.sandbox?.docker;
	if (defaultDocker && typeof defaultDocker === "object") configs.push({
		source: "agents.defaults.sandbox.docker",
		docker: defaultDocker
	});
	for (const entry of agents) {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
		const agentDocker = entry.sandbox?.docker;
		if (agentDocker && typeof agentDocker === "object") configs.push({
			source: `agents.list.${entry.id}.sandbox.docker`,
			docker: agentDocker
		});
	}
	for (const { source, docker } of configs) {
		const binds = Array.isArray(docker.binds) ? docker.binds : [];
		for (const bind of binds) {
			if (typeof bind !== "string") continue;
			const blocked = getBlockedBindReason(bind);
			if (!blocked) continue;
			if (blocked.kind === "non_absolute") {
				findings.push({
					checkId: "sandbox.bind_mount_non_absolute",
					severity: "warn",
					title: "Sandbox bind mount uses a non-absolute source path",
					detail: `${source}.binds contains "${bind}" which uses source path "${blocked.sourcePath}". Non-absolute bind sources are hard to validate safely and may resolve unexpectedly.`,
					remediation: `Rewrite "${bind}" to use an absolute host path (for example: /home/user/project:/project:ro).`
				});
				continue;
			}
			if (blocked.kind !== "covers" && blocked.kind !== "targets") continue;
			const verb = blocked.kind === "covers" ? "covers" : "targets";
			findings.push({
				checkId: "sandbox.dangerous_bind_mount",
				severity: "critical",
				title: "Dangerous bind mount in sandbox config",
				detail: `${source}.binds contains "${bind}" which ${verb} blocked path "${blocked.blockedPath}". This can expose host system directories or the Docker socket to sandbox containers.`,
				remediation: `Remove "${bind}" from ${source}.binds. Use project-specific paths instead.`
			});
		}
		const network = typeof docker.network === "string" ? docker.network : void 0;
		const normalizedNetwork = normalizeNetworkMode(network);
		if (isDangerousNetworkMode(network)) {
			const modeLabel = normalizedNetwork === "host" ? "\"host\"" : `"${network}"`;
			const detail = normalizedNetwork === "host" ? `${source}.network is "host" which bypasses container network isolation entirely.` : `${source}.network is ${modeLabel} which joins another container namespace and can bypass sandbox network isolation.`;
			findings.push({
				checkId: "sandbox.dangerous_network_mode",
				severity: "critical",
				title: "Dangerous network mode in sandbox config",
				detail,
				remediation: `Set ${source}.network to "bridge", "none", or a custom bridge network name. Use ${source}.dangerouslyAllowContainerNamespaceJoin=true only as a break-glass override when you fully trust this runtime.`
			});
		}
		if (normalizeOptionalLowercaseString(typeof docker.seccompProfile === "string" ? docker.seccompProfile : void 0) === "unconfined") findings.push({
			checkId: "sandbox.dangerous_seccomp_profile",
			severity: "critical",
			title: "Seccomp unconfined in sandbox config",
			detail: `${source}.seccompProfile is "unconfined" which disables syscall filtering.`,
			remediation: `Remove ${source}.seccompProfile or use a custom seccomp profile file.`
		});
		if (normalizeOptionalLowercaseString(typeof docker.apparmorProfile === "string" ? docker.apparmorProfile : void 0) === "unconfined") findings.push({
			checkId: "sandbox.dangerous_apparmor_profile",
			severity: "critical",
			title: "AppArmor unconfined in sandbox config",
			detail: `${source}.apparmorProfile is "unconfined" which disables AppArmor enforcement.`,
			remediation: `Remove ${source}.apparmorProfile or use a named AppArmor profile.`
		});
	}
	return findings;
}
function collectNodeDenyCommandPatternFindings(cfg) {
	const findings = [];
	const denyListRaw = cfg.gateway?.nodes?.denyCommands;
	if (!Array.isArray(denyListRaw) || denyListRaw.length === 0) return findings;
	const denyList = denyListRaw.map(normalizeNodeCommand).filter(Boolean);
	if (denyList.length === 0) return findings;
	const knownCommands = listKnownNodeCommands(cfg);
	const patternLike = denyList.filter((entry) => looksLikeNodeCommandPattern(entry));
	const unknownExact = denyList.filter((entry) => !looksLikeNodeCommandPattern(entry) && !knownCommands.has(entry));
	if (patternLike.length === 0 && unknownExact.length === 0) return findings;
	const detailParts = [];
	if (patternLike.length > 0) detailParts.push(`Pattern-like entries (not supported by exact matching): ${patternLike.join(", ")}`);
	if (unknownExact.length > 0) {
		const unknownDetails = unknownExact.map((entry) => {
			const suggestions = suggestKnownNodeCommands(entry, knownCommands);
			if (suggestions.length === 0) return entry;
			return `${entry} (did you mean: ${suggestions.join(", ")})`;
		}).join(", ");
		detailParts.push(`Unknown command names (not in defaults/allowCommands): ${unknownDetails}`);
	}
	const examples = Array.from(knownCommands).slice(0, 8);
	findings.push({
		checkId: "gateway.nodes.deny_commands_ineffective",
		severity: "warn",
		title: "Some gateway.nodes.denyCommands entries are ineffective",
		detail: "gateway.nodes.denyCommands uses exact node command-name matching only (for example `system.run`), not shell-text filtering inside a command payload.\n" + detailParts.map((entry) => `- ${entry}`).join("\n"),
		remediation: `Use exact command names (for example: ${examples.join(", ")}). If you need broader restrictions, remove risky command IDs from allowCommands/default workflows and tighten tools.exec policy.`
	});
	return findings;
}
function collectNodeDangerousAllowCommandFindings(cfg) {
	const findings = [];
	const allowRaw = cfg.gateway?.nodes?.allowCommands;
	if (!Array.isArray(allowRaw) || allowRaw.length === 0) return findings;
	const allow = new Set(allowRaw.map(normalizeNodeCommand).filter(Boolean));
	if (allow.size === 0) return findings;
	const deny = new Set((cfg.gateway?.nodes?.denyCommands ?? []).map(normalizeNodeCommand));
	const dangerousAllowed = [...DEFAULT_DANGEROUS_NODE_COMMANDS, ...listDangerousPluginNodeCommands()].filter((cmd) => allow.has(cmd) && !deny.has(cmd));
	if (dangerousAllowed.length === 0) return findings;
	findings.push({
		checkId: "gateway.nodes.allow_commands_dangerous",
		severity: isGatewayRemotelyExposed(cfg) ? "critical" : "warn",
		title: "Dangerous node commands explicitly enabled",
		detail: `gateway.nodes.allowCommands includes: ${dangerousAllowed.join(", ")}. These commands can trigger high-impact device actions or read node files (camera/screen/contacts/calendar/reminders/SMS/file).`,
		remediation: "Remove these entries from gateway.nodes.allowCommands (recommended). If you keep them, treat gateway auth as full operator access and keep gateway exposure local/tailnet-only."
	});
	return findings;
}
function collectMinimalProfileOverrideFindings(cfg) {
	const findings = [];
	if (cfg.tools?.profile !== "minimal") return findings;
	const overrides = (cfg.agents?.list ?? []).filter((entry) => {
		return Boolean(entry && typeof entry === "object" && typeof entry.id === "string" && entry.tools?.profile && entry.tools.profile !== "minimal");
	}).map((entry) => `${entry.id}=${entry.tools?.profile}`);
	if (overrides.length === 0) return findings;
	findings.push({
		checkId: "tools.profile_minimal_overridden",
		severity: "warn",
		title: "Global tools.profile=minimal is overridden by agent profiles",
		detail: "Global minimal profile is set, but these agent profiles take precedence:\n" + overrides.map((entry) => `- agents.list.${entry}`).join("\n"),
		remediation: "Set those agents to `tools.profile=\"minimal\"` (or remove the agent override) if you want minimal tools enforced globally."
	});
	return findings;
}
function collectModelHygieneFindings(cfg) {
	const findings = [];
	const models = collectAuditModelRefs(cfg);
	if (models.length === 0) return findings;
	const weakMatches = /* @__PURE__ */ new Map();
	const addWeakMatch = (model, source, reason) => {
		const key = `${model}@@${source}`;
		const existing = weakMatches.get(key);
		if (!existing) {
			weakMatches.set(key, {
				model,
				source,
				reasons: [reason]
			});
			return;
		}
		if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
	};
	for (const entry of models) {
		for (const pat of WEAK_TIER_MODEL_PATTERNS) if (pat.re.test(entry.id)) {
			addWeakMatch(entry.id, entry.source, pat.label);
			break;
		}
		if (isGptModel(entry.id) && !isGpt5OrHigher(entry.id)) addWeakMatch(entry.id, entry.source, "Below GPT-5 family");
		if (isClaudeModel(entry.id) && !isClaude45OrHigher(entry.id)) addWeakMatch(entry.id, entry.source, "Below Claude 4.5");
	}
	const matches = [];
	for (const entry of models) for (const pat of LEGACY_MODEL_PATTERNS) if (pat.re.test(entry.id)) {
		matches.push({
			model: entry.id,
			source: entry.source,
			reason: pat.label
		});
		break;
	}
	if (matches.length > 0) {
		const lines = matches.slice(0, 12).map((m) => `- ${m.model} (${m.reason}) @ ${m.source}`).join("\n");
		const more = matches.length > 12 ? `\n…${matches.length - 12} more` : "";
		findings.push({
			checkId: "models.legacy",
			severity: "warn",
			title: "Some configured models look legacy",
			detail: "Older/legacy models can be less robust against prompt injection and tool misuse.\n" + lines + more,
			remediation: "Prefer modern, instruction-hardened models for any bot that can run tools."
		});
	}
	if (weakMatches.size > 0) {
		const lines = Array.from(weakMatches.values()).slice(0, 12).map((m) => `- ${m.model} (${m.reasons.join("; ")}) @ ${m.source}`).join("\n");
		const more = weakMatches.size > 12 ? `\n…${weakMatches.size - 12} more` : "";
		findings.push({
			checkId: "models.weak_tier",
			severity: "warn",
			title: "Some configured models are below recommended tiers",
			detail: "Smaller/older models are generally more susceptible to prompt injection and tool misuse.\n" + lines + more,
			remediation: "Use the latest, top-tier model for any bot with tools or untrusted inboxes. Avoid Haiku tiers; prefer GPT-5+ and Claude 4.5+."
		});
	}
	return findings;
}
function collectExposureMatrixFindings(cfg) {
	const findings = [];
	const openGroups = listGroupPolicyOpen(cfg);
	if (openGroups.length === 0) return findings;
	if (cfg.tools?.elevated?.enabled !== false) findings.push({
		checkId: "security.exposure.open_groups_with_elevated",
		severity: "critical",
		title: "Open groupPolicy with elevated tools enabled",
		detail: `Found groupPolicy="open" at:\n${openGroups.map((p) => `- ${p}`).join("\n")}\nWith tools.elevated enabled, a prompt injection in those rooms can become a high-impact incident.`,
		remediation: `Set groupPolicy="allowlist" and keep elevated allowlists extremely tight.`
	});
	const { riskyContexts, hasRuntimeRisk } = collectRiskyToolExposureContexts(cfg);
	if (riskyContexts.length > 0) findings.push({
		checkId: "security.exposure.open_groups_with_runtime_or_fs",
		severity: hasRuntimeRisk ? "critical" : "warn",
		title: "Open groupPolicy with runtime/filesystem tools exposed",
		detail: `Found groupPolicy="open" at:\n${openGroups.map((p) => `- ${p}`).join("\n")}\nRisky tool exposure contexts:\n${riskyContexts.map((line) => `- ${line}`).join("\n")}\nPrompt injection in open groups can trigger command/file actions in these contexts.`,
		remediation: "For open groups, prefer tools.profile=\"messaging\" (or deny group:runtime/group:fs), set tools.fs.workspaceOnly=true, and use agents.defaults.sandbox.mode=\"all\" for exposed agents."
	});
	return findings;
}
function collectLikelyMultiUserSetupFindings(cfg) {
	const findings = [];
	const signals = listPotentialMultiUserSignals(cfg);
	if (signals.length === 0) return findings;
	const { riskyContexts, hasRuntimeRisk } = collectRiskyToolExposureContexts(cfg);
	const impactLine = hasRuntimeRisk ? "Runtime/process tools are exposed without full sandboxing in at least one context." : "No unguarded runtime/process tools were detected by this heuristic.";
	const riskyContextsDetail = riskyContexts.length > 0 ? `Potential high-impact tool exposure contexts:\n${riskyContexts.map((line) => `- ${line}`).join("\n")}` : "No unguarded runtime/filesystem contexts detected.";
	findings.push({
		checkId: "security.trust_model.multi_user_heuristic",
		severity: "warn",
		title: "Potential multi-user setup detected (personal-assistant model warning)",
		detail: "Heuristic signals indicate this gateway may be reachable by multiple users:\n" + signals.map((signal) => `- ${signal}`).join("\n") + `\n${impactLine}\n${riskyContextsDetail}\nOpenClaw's default security model is personal-assistant (one trusted operator boundary), not hostile multi-tenant isolation on one shared gateway.`,
		remediation: "If users may be mutually untrusted, split trust boundaries (separate gateways + credentials, ideally separate OS users/hosts). If you intentionally run shared-user access, set agents.defaults.sandbox.mode=\"all\", keep tools.fs.workspaceOnly=true, deny runtime/fs/web tools unless required, and keep personal/private identities + credentials off that runtime."
	});
	return findings;
}
//#endregion
//#region src/security/audit-workspace-skills.ts
const MAX_WORKSPACE_SKILL_SCAN_FILES_PER_WORKSPACE = 2e3;
const MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS = 12;
async function safeStat(targetPath) {
	try {
		return {
			ok: true,
			isDir: (await fs.lstat(targetPath)).isDirectory()
		};
	} catch {
		return {
			ok: false,
			isDir: false
		};
	}
}
function realpathWithTimeout(p, timeoutMs = 2e3) {
	let timerHandle;
	const realpathPromise = fs.realpath(p).catch(() => null).then((result) => {
		clearTimeout(timerHandle);
		return result;
	});
	const timeoutPromise = new Promise((resolve) => {
		timerHandle = setTimeout(() => resolve(null), timeoutMs);
		timerHandle.unref?.();
	});
	return Promise.race([realpathPromise, timeoutPromise]);
}
async function listWorkspaceSkillMarkdownFiles(workspaceDir, limits = {}) {
	const skillsRoot = path.join(workspaceDir, "skills");
	const rootStat = await safeStat(skillsRoot);
	if (!rootStat.ok || !rootStat.isDir) return {
		skillFilePaths: [],
		truncated: false
	};
	const maxFiles = limits.maxFiles ?? MAX_WORKSPACE_SKILL_SCAN_FILES_PER_WORKSPACE;
	const maxTotalDirVisits = limits.maxDirVisits ?? maxFiles * 20;
	const skillFiles = [];
	const queue = [skillsRoot];
	const visitedDirs = /* @__PURE__ */ new Set();
	let totalDirVisits = 0;
	while (queue.length > 0 && skillFiles.length < maxFiles && totalDirVisits++ < maxTotalDirVisits) {
		const dir = queue.shift();
		const dirRealPath = await realpathWithTimeout(dir) ?? path.resolve(dir);
		if (visitedDirs.has(dirRealPath)) continue;
		visitedDirs.add(dirRealPath);
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				queue.push(fullPath);
				continue;
			}
			if (entry.isSymbolicLink()) {
				const stat = await fs.stat(fullPath).catch(() => null);
				if (!stat) continue;
				if (stat.isDirectory()) {
					queue.push(fullPath);
					continue;
				}
				if (stat.isFile() && entry.name === "SKILL.md") skillFiles.push(fullPath);
				continue;
			}
			if (entry.isFile() && entry.name === "SKILL.md") skillFiles.push(fullPath);
		}
	}
	return {
		skillFilePaths: skillFiles,
		truncated: queue.length > 0
	};
}
async function collectWorkspaceSkillSymlinkEscapeFindings(params) {
	const findings = [];
	const workspaceDirs = listAgentWorkspaceDirs(params.cfg);
	if (workspaceDirs.length === 0) return findings;
	const escapedSkillFiles = [];
	const seenSkillPaths = /* @__PURE__ */ new Set();
	for (const workspaceDir of workspaceDirs) {
		const workspacePath = path.resolve(workspaceDir);
		const workspaceRealPath = await realpathWithTimeout(workspacePath) ?? workspacePath;
		const { skillFilePaths, truncated } = await listWorkspaceSkillMarkdownFiles(workspacePath, params.skillScanLimits);
		if (truncated) findings.push({
			checkId: "skills.workspace.scan_truncated",
			severity: "warn",
			title: "Workspace skill scan reached the directory visit limit",
			detail: `The skills/ directory scan in ${workspacePath} stopped early after reaching the BFS visit cap. Skill files in the unscanned portion of the tree were not checked for symlink escapes.`,
			remediation: "Flatten or simplify the skills/ directory hierarchy to stay within the scan budget, or move deeply-nested skill collections to a managed skill location."
		});
		for (const skillFilePath of skillFilePaths) {
			const canonicalSkillPath = path.resolve(skillFilePath);
			if (seenSkillPaths.has(canonicalSkillPath)) continue;
			seenSkillPaths.add(canonicalSkillPath);
			const skillRealPath = await realpathWithTimeout(canonicalSkillPath);
			if (!skillRealPath) {
				escapedSkillFiles.push({
					workspaceDir: workspacePath,
					skillFilePath: canonicalSkillPath,
					skillRealPath: "(realpath timed out - symlink target unverifiable)"
				});
				continue;
			}
			if (isPathInside(workspaceRealPath, skillRealPath)) continue;
			escapedSkillFiles.push({
				workspaceDir: workspacePath,
				skillFilePath: canonicalSkillPath,
				skillRealPath
			});
		}
	}
	if (escapedSkillFiles.length === 0) return findings;
	findings.push({
		checkId: "skills.workspace.symlink_escape",
		severity: "warn",
		title: "Workspace skill files resolve outside the workspace root",
		detail: "Detected workspace `skills/**/SKILL.md` paths whose realpath escapes their workspace root:\n" + escapedSkillFiles.slice(0, MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS).map((entry) => `- workspace=${entry.workspaceDir}\n  skill=${entry.skillFilePath}\n  realpath=${entry.skillRealPath}`).join("\n") + (escapedSkillFiles.length > MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS ? `\n- +${escapedSkillFiles.length - MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS} more` : ""),
		remediation: "Keep workspace skills inside the workspace root (replace symlinked escapes with real in-workspace files), or move trusted shared skills to managed/bundled skill locations."
	});
	return findings;
}
//#endregion
export { collectAttackSurfaceSummaryFindings, collectExposureMatrixFindings, collectGatewayHttpNoAuthFindings, collectGatewayHttpSessionKeyOverrideFindings, collectHooksHardeningFindings, collectIncludeFilePermFindings, collectLikelyMultiUserSetupFindings, collectMinimalProfileOverrideFindings, collectModelHygieneFindings, collectNodeDangerousAllowCommandFindings, collectNodeDenyCommandPatternFindings, collectPluginsTrustFindings, collectSandboxBrowserHashLabelFindings, collectSandboxDangerousConfigFindings, collectSandboxDockerNoopFindings, collectSecretsInConfigFindings, collectSmallModelRiskFindings, collectStateDeepFilesystemFindings, collectSyncedFolderFindings, collectWorkspaceSkillSymlinkEscapeFindings, readConfigSnapshotForAudit };
