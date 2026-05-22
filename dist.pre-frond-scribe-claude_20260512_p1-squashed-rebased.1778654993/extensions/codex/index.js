import { E as pathExists } from "../../fs-safe-DKdSS9ZL.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir, r as resolveAgentConfig } from "../../agent-scope-config-Du7CC6LK.js";
import { n as readJsonFileWithFallback } from "../../json-store-CgKwi_eE.js";
import { t as definePluginEntry } from "../../plugin-entry-SrJZmI2E.js";
import { n as resolveLivePluginConfigObject } from "../../plugin-config-runtime-727Z09T1.js";
import "../../agent-runtime-C8nZmEo_.js";
import "../../security-runtime-7vEOoyka.js";
import { c as hasMigrationConfigPatchConflict, d as markMigrationItemSkipped, i as applyMigrationManualItem, l as markMigrationItemConflict, m as readMigrationConfigPath, n as MIGRATION_REASON_TARGET_EXISTS, o as createMigrationItem, s as createMigrationManualItem, u as markMigrationItemError, v as summarizeMigrationItems, y as writeMigrationConfigPath } from "../../migration-D8r0JUFO.js";
import { i as writeMigrationReport, n as copyMigrationFileItem, r as withCachedMigrationConfigRuntime, t as archiveMigrationItem } from "../../migration-runtime-D0psPgsO.js";
import { t as createCodexAppServerAgentHarness } from "../../harness-Dmvhqyj0.js";
import { o as readCodexPluginConfig, s as resolveCodexAppServerRuntimeOptions, t as CODEX_PLUGINS_MARKETPLACE_NAME } from "../../config-Cdigy6v1.js";
import { t as buildCodexMediaUnderstandingProvider } from "../../media-understanding-provider-B86u8Gir.js";
import { t as buildCodexProvider } from "../../provider-BAnhA-il.js";
import { r as describeControlFailure, t as requestCodexAppServerJson } from "../../request-ChASCFto.js";
import { r as formatCodexDisplayText } from "../../command-formatters-DECluCaG.js";
import { c as resolveCodexAppServerAuthAccountCacheKey, d as resolveCodexAppServerEnvApiKeyCacheKey, u as resolveCodexAppServerAuthProfileIdForAgent } from "../../shared-client-D4hRQzke.js";
import { n as handleCodexConversationInboundClaim, t as handleCodexConversationBindingResolved } from "../../conversation-binding-DeVTMMA4.js";
import { a as defaultCodexAppInventoryCache, n as pluginReadParams, t as ensureCodexPluginActivation } from "../../plugin-activation-gorHLorW.js";
import { t as buildCodexPluginAppCacheKey } from "../../plugin-app-cache-key-NQ3cA-mT.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region extensions/codex/src/commands.ts
function createCodexCommand(options) {
	return {
		name: "codex",
		description: "Inspect and control the Codex app-server harness",
		ownership: "reserved",
		agentPromptGuidance: ["Native Codex app-server plugin is available (`/codex ...`). For Codex bind/control/thread/resume/steer/stop requests, prefer `/codex bind`, `/codex threads`, `/codex resume`, `/codex steer`, and `/codex stop` over ACP.", "Use ACP for Codex only when the user explicitly asks for ACP/acpx or wants to test the ACP path."],
		acceptsArgs: true,
		requireAuth: true,
		handler: (ctx) => handleCodexCommand(ctx, options)
	};
}
async function handleCodexCommand(ctx, options = {}) {
	const { loadSubcommandHandler, ...subcommandOptions } = options;
	try {
		return await (loadSubcommandHandler ? await loadSubcommandHandler() : await loadDefaultCodexSubcommandHandler())(ctx, subcommandOptions);
	} catch (error) {
		return { text: `Codex command failed: ${formatCodexDisplayText(describeControlFailure(error))}` };
	}
}
async function loadDefaultCodexSubcommandHandler() {
	const { handleCodexSubcommand } = await import("../../command-handlers-CNpNXOCV.js");
	return handleCodexSubcommand;
}
//#endregion
//#region extensions/codex/src/migration/helpers.ts
async function exists(filePath) {
	return await pathExists(filePath);
}
async function isDirectory(filePath) {
	if (!filePath) return false;
	try {
		return (await fs.stat(filePath)).isDirectory();
	} catch {
		return false;
	}
}
function resolveUserHomeDir() {
	return process.env.HOME?.trim() || os.homedir();
}
function resolveHomePath(value) {
	if (value === "~") return resolveUserHomeDir();
	if (value.startsWith("~/")) return path.join(resolveUserHomeDir(), value.slice(2));
	return path.resolve(value);
}
function sanitizeName(value) {
	return value.trim().toLowerCase().replaceAll(/[^a-z0-9._-]+/gu, "-").replaceAll(/^-+|-+$/gu, "").slice(0, 64);
}
async function readJsonObject(filePath) {
	if (!filePath) return {};
	const { value: parsed } = await readJsonFileWithFallback(filePath, {});
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}
//#endregion
//#region extensions/codex/src/migration/source.ts
const SKILL_FILENAME = "SKILL.md";
const MAX_SCAN_DEPTH = 6;
const MAX_DISCOVERED_DIRS = 2e3;
function defaultCodexHome() {
	return resolveHomePath(process.env.CODEX_HOME?.trim() || "~/.codex");
}
function personalAgentsSkillsDir() {
	return path.join(resolveUserHomeDir(), ".agents", "skills");
}
async function safeReadDir(dir) {
	return await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}
async function discoverSkillDirs(params) {
	if (!params.root || !await isDirectory(params.root)) return [];
	const discovered = [];
	async function visit(dir, depth) {
		if (discovered.length >= MAX_DISCOVERED_DIRS || depth > MAX_SCAN_DEPTH) return;
		const name = path.basename(dir);
		if (params.excludeSystem && depth === 1 && name === ".system") return;
		if (await exists(path.join(dir, SKILL_FILENAME))) {
			discovered.push({
				name,
				source: dir,
				sourceLabel: params.sourceLabel
			});
			return;
		}
		for (const entry of await safeReadDir(dir)) {
			if (!entry.isDirectory()) continue;
			await visit(path.join(dir, entry.name), depth + 1);
		}
	}
	await visit(params.root, 0);
	return discovered;
}
async function discoverPluginDirs(codexHome) {
	const root = path.join(codexHome, "plugins", "cache");
	if (!await isDirectory(root)) return [];
	const discovered = /* @__PURE__ */ new Map();
	async function visit(dir, depth) {
		if (discovered.size >= MAX_DISCOVERED_DIRS || depth > MAX_SCAN_DEPTH) return;
		const manifestPath = path.join(dir, ".codex-plugin", "plugin.json");
		if (await exists(manifestPath)) {
			const manifest = await readJsonObject(manifestPath);
			const name = (typeof manifest.name === "string" ? manifest.name.trim() : "") || path.basename(dir);
			discovered.set(dir, {
				name,
				source: dir,
				manifestPath,
				sourceKind: "cache",
				migratable: false,
				message: "Cached Codex plugin bundle found. Review manually unless the plugin is also installed in the source Codex app-server inventory."
			});
			return;
		}
		for (const entry of await safeReadDir(dir)) {
			if (!entry.isDirectory()) continue;
			await visit(path.join(dir, entry.name), depth + 1);
		}
	}
	await visit(root, 0);
	return [...discovered.values()].toSorted((a, b) => a.source.localeCompare(b.source));
}
async function discoverInstalledCuratedPlugins(codexHome, options = {}) {
	const requestOptions = { startOptions: sourceCodexAppServerStartOptions(codexHome) };
	try {
		const marketplace = (await requestSourceCodexAppServerJson(requestOptions, {
			method: "plugin/list",
			requestParams: { cwds: [] }
		})).marketplaces.find((entry) => entry.name === CODEX_PLUGINS_MARKETPLACE_NAME);
		if (!marketplace) return {
			plugins: [],
			error: `Codex marketplace ${CODEX_PLUGINS_MARKETPLACE_NAME} was not found in source plugin inventory.`
		};
		const plugins = marketplace.plugins.filter((plugin) => plugin.installed).map((plugin) => buildInstalledPluginSource(plugin)).filter((plugin) => plugin !== void 0);
		return { plugins: (options.evaluatePluginMigrationEligibility === true ? await withPluginMigrationEligibility({
			plugins,
			marketplace: marketplaceRef(marketplace),
			requestOptions,
			verifyPluginApps: options.verifyPluginApps === true
		}) : plugins).toSorted((a, b) => (a.pluginName ?? a.name).localeCompare(b.pluginName ?? b.name)) };
	} catch (error) {
		return {
			plugins: [],
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
function sourceCodexAppServerStartOptions(codexHome) {
	return {
		transport: "stdio",
		command: "codex",
		commandSource: "config",
		args: [
			"app-server",
			"--listen",
			"stdio://"
		],
		headers: {},
		env: {
			CODEX_HOME: codexHome,
			HOME: path.dirname(codexHome)
		}
	};
}
async function requestSourceCodexAppServerJson(options, params) {
	return await requestCodexAppServerJson({
		method: params.method,
		requestParams: params.requestParams,
		timeoutMs: 6e4,
		startOptions: options.startOptions,
		authProfileId: null,
		isolated: true
	});
}
function buildInstalledPluginSource(plugin) {
	const pluginName = pluginNameFromSummary(plugin);
	if (!pluginName) return;
	return {
		name: plugin.name,
		pluginName,
		marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
		source: `${CODEX_PLUGINS_MARKETPLACE_NAME}/${pluginName}`,
		sourceKind: "app-server",
		migratable: true,
		installed: plugin.installed,
		enabled: plugin.enabled
	};
}
function marketplaceRef(marketplace) {
	return {
		name: CODEX_PLUGINS_MARKETPLACE_NAME,
		...marketplace.path ? { path: marketplace.path } : {},
		...!marketplace.path ? { remoteMarketplaceName: marketplace.name } : {}
	};
}
async function withPluginMigrationEligibility(params) {
	const pending = [];
	const evaluated = [];
	for (const plugin of params.plugins) {
		if (plugin.enabled !== true) {
			evaluated.push({
				...plugin,
				migratable: false,
				migrationBlock: { code: "plugin_disabled" },
				message: `Codex plugin "${plugin.pluginName ?? plugin.name}" is installed in Codex but disabled; enable it in Codex before migrating it to OpenClaw.`
			});
			continue;
		}
		const detail = await readPluginDetail(params.requestOptions, params.marketplace, plugin);
		if (!detail.ok) {
			evaluated.push({
				...plugin,
				migratable: false,
				migrationBlock: {
					code: "plugin_read_unavailable",
					error: detail.error
				},
				message: `Codex plugin "${plugin.pluginName ?? plugin.name}" detail could not be read: ${detail.error}`
			});
			continue;
		}
		if (detail.detail.apps.length === 0) {
			evaluated.push({
				...plugin,
				migratable: true
			});
			continue;
		}
		const apps = detail.detail.apps.map(sourcePluginAppFact).toSorted((left, right) => left.id.localeCompare(right.id));
		pending.push({
			plugin,
			apps
		});
	}
	if (pending.length === 0) return evaluated;
	let sourceAccount;
	try {
		sourceAccount = await readSourceCodexAccount(params.requestOptions);
	} catch (error) {
		if (!params.verifyPluginApps) {
			const message = error instanceof Error ? error.message : String(error);
			for (const { plugin, apps } of pending) evaluated.push({
				...plugin,
				migratable: false,
				migrationBlock: {
					code: "codex_account_unavailable",
					apps,
					error: message
				},
				message: `Codex plugin "${plugin.pluginName ?? plugin.name}" owns apps, but the source Codex app-server account could not be read: ${message}`
			});
			return evaluated;
		}
	}
	if (sourceAccount && sourceAccount !== "chatgpt") {
		for (const { plugin, apps } of pending) evaluated.push({
			...plugin,
			migratable: false,
			migrationBlock: {
				code: "codex_subscription_required",
				apps
			},
			message: codexSubscriptionRequiredMessage(plugin)
		});
		return evaluated;
	}
	if (!params.verifyPluginApps) {
		for (const { plugin, apps } of pending) evaluated.push({
			...plugin,
			apps,
			migratable: true
		});
		return evaluated;
	}
	const snapshot = await refreshSourceAppInventory(params.requestOptions).catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		for (const { plugin, apps } of pending) evaluated.push({
			...plugin,
			migratable: false,
			migrationBlock: {
				code: "app_inventory_unavailable",
				apps,
				error: message
			},
			message: `Codex plugin "${plugin.pluginName ?? plugin.name}" owns apps, but source app inventory could not be read: ${message}`
		});
	});
	if (!snapshot) return evaluated;
	const appInfoById = new Map(snapshot.apps.map((app) => [app.id, app]));
	for (const { plugin, apps: declaredApps } of pending) {
		const apps = declaredApps.map((app) => sourcePluginAppFactWithInventory(app, appInfoById.get(app.id))).toSorted((left, right) => left.id.localeCompare(right.id));
		const blockCode = migrationBlockCodeForApps(apps);
		if (!blockCode) {
			evaluated.push({
				...plugin,
				apps,
				migratable: true
			});
			continue;
		}
		evaluated.push({
			...plugin,
			migratable: false,
			migrationBlock: {
				code: blockCode,
				apps
			},
			message: appInventoryBlockMessage(plugin, apps, blockCode)
		});
	}
	return evaluated;
}
async function readSourceCodexAccount(options) {
	const response = await requestSourceCodexAppServerJson(options, {
		method: "account/read",
		requestParams: { refreshToken: false }
	});
	if (!response.account || typeof response.account !== "object" || Array.isArray(response.account)) return "missing";
	return response.account.type === "chatgpt" ? "chatgpt" : "non_chatgpt";
}
async function readPluginDetail(options, marketplace, plugin) {
	try {
		return {
			ok: true,
			detail: (await requestSourceCodexAppServerJson(options, {
				method: "plugin/read",
				requestParams: pluginReadParams(marketplace, plugin.pluginName ?? plugin.name)
			})).plugin
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
async function refreshSourceAppInventory(options) {
	const key = buildCodexPluginAppCacheKey({ appServer: { start: options.startOptions } });
	const request = async (method, requestParams) => await requestSourceCodexAppServerJson(options, {
		method,
		requestParams
	});
	return await defaultCodexAppInventoryCache.refreshNow({
		key,
		request,
		forceRefetch: true
	});
}
function sourcePluginAppFact(app) {
	return {
		id: app.id,
		name: app.name,
		needsAuth: app.needsAuth
	};
}
function sourcePluginAppFactWithInventory(app, info) {
	if (!info) return app;
	return {
		...app,
		isAccessible: info.isAccessible,
		isEnabled: info.isEnabled
	};
}
function migrationBlockCodeForApps(apps) {
	if (apps.some((app) => app.isAccessible === false)) return "app_inaccessible";
	if (apps.some((app) => app.isEnabled === false)) return "app_disabled";
	if (apps.some((app) => app.isAccessible === void 0 || app.isEnabled === void 0)) return "app_missing";
}
function appInventoryBlockMessage(plugin, apps, code) {
	const status = code === "app_inaccessible" ? "inaccessible" : code === "app_disabled" ? "disabled" : "missing";
	const blocking = apps.find((app) => code === "app_inaccessible" ? app.isAccessible === false : code === "app_disabled" ? app.isEnabled === false : app.isAccessible === void 0 || app.isEnabled === void 0) ?? apps[0];
	const appLabel = blocking ? ` app "${blocking.name}"` : " an owned app";
	return `Codex plugin "${plugin.pluginName ?? plugin.name}" owns${appLabel} but the source app inventory reports it is ${status}; authenticate or enable the app in Codex before migrating it to OpenClaw.`;
}
function codexPluginMigrationSubscriptionWarning() {
	return "Codex app-backed plugin migration requires the Codex app-server source account to be logged in with a ChatGPT subscription account. Log in to the Codex app with subscription auth; OpenClaw auth or API-key auth does not satisfy Codex app connector access.";
}
function codexSubscriptionRequiredMessage(plugin) {
	return `Codex plugin "${plugin.pluginName ?? plugin.name}" owns apps, but ${codexPluginMigrationSubscriptionWarning()}`;
}
function pluginNameFromSummary(summary) {
	const candidates = [summary.id, summary.name];
	for (const candidate of candidates) {
		const trimmed = candidate.trim();
		if (!trimmed) continue;
		const normalized = ((trimmed.endsWith(`@openai-curated`) ? trimmed.slice(0, -`@${CODEX_PLUGINS_MARKETPLACE_NAME}`.length) : trimmed).split("/").at(-1)?.trim())?.toLowerCase().replaceAll(/\s+/gu, "-");
		if (normalized) return normalized;
	}
}
async function discoverCodexSource(inputOrOptions) {
	const options = typeof inputOrOptions === "string" || inputOrOptions === void 0 ? { input: inputOrOptions } : inputOrOptions;
	const codexHome = resolveHomePath(options.input?.trim() || defaultCodexHome());
	const codexSkillsDir = path.join(codexHome, "skills");
	const agentsSkillsDir = personalAgentsSkillsDir();
	const configPath = path.join(codexHome, "config.toml");
	const hooksPath = path.join(codexHome, "hooks", "hooks.json");
	const codexSkills = await discoverSkillDirs({
		root: codexSkillsDir,
		sourceLabel: "Codex CLI skill",
		excludeSystem: true
	});
	const personalAgentSkills = await discoverSkillDirs({
		root: agentsSkillsDir,
		sourceLabel: "personal AgentSkill"
	});
	const sourcePluginDiscovery = await discoverInstalledCuratedPlugins(codexHome, options);
	const sourcePluginNames = new Set(sourcePluginDiscovery.plugins.flatMap((plugin) => plugin.pluginName ? [plugin.pluginName] : []));
	const cachedPlugins = (await discoverPluginDirs(codexHome)).filter((plugin) => {
		const normalizedName = sanitizePluginName(plugin.name);
		return !sourcePluginNames.has(normalizedName);
	});
	const plugins = [...sourcePluginDiscovery.plugins, ...cachedPlugins].toSorted((a, b) => a.source.localeCompare(b.source));
	const archivePaths = [];
	if (await exists(configPath)) archivePaths.push({
		id: "archive:config.toml",
		path: configPath,
		relativePath: "config.toml",
		message: "Codex config is archived for manual review; it is not activated automatically."
	});
	if (await exists(hooksPath)) archivePaths.push({
		id: "archive:hooks/hooks.json",
		path: hooksPath,
		relativePath: "hooks/hooks.json",
		message: "Codex native hooks are archived for manual review because they can execute commands."
	});
	const skills = [...codexSkills, ...personalAgentSkills].toSorted((a, b) => a.source.localeCompare(b.source));
	const high = Boolean(codexSkills.length || plugins.length || archivePaths.length);
	const medium = personalAgentSkills.length > 0;
	return {
		root: codexHome,
		confidence: high ? "high" : medium ? "medium" : "low",
		codexHome,
		...await isDirectory(codexSkillsDir) ? { codexSkillsDir } : {},
		...await isDirectory(agentsSkillsDir) ? { personalAgentsSkillsDir: agentsSkillsDir } : {},
		...await exists(configPath) ? { configPath } : {},
		...await exists(hooksPath) ? { hooksPath } : {},
		skills,
		plugins,
		...sourcePluginDiscovery.error ? { pluginDiscoveryError: sourcePluginDiscovery.error } : {},
		archivePaths
	};
}
function hasCodexSource(source) {
	return source.confidence !== "low";
}
function sanitizePluginName(value) {
	return value.trim().toLowerCase().replaceAll(/\s+/gu, "-");
}
//#endregion
//#region extensions/codex/src/migration/targets.ts
function resolveCodexMigrationTargets(ctx) {
	const cfg = ctx.config;
	const agentId = resolveDefaultAgentId(cfg);
	const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
	const configuredAgentDir = resolveAgentConfig(cfg, agentId)?.agentDir?.trim();
	return {
		workspaceDir,
		agentDir: ctx.runtime?.agent?.resolveAgentDir(cfg, agentId) ?? (configuredAgentDir ? resolveHomePath(configuredAgentDir) : void 0) ?? path.join(ctx.stateDir, "agents", agentId, "agent")
	};
}
//#endregion
//#region extensions/codex/src/migration/plan.ts
const CODEX_PLUGIN_CONFIG_ITEM_ID = "config:codex-plugins";
const CODEX_PLUGIN_CONFIG_PATH = [
	"plugins",
	"entries",
	"codex"
];
const CODEX_PLUGIN_ENABLED_PATH = [
	"plugins",
	"entries",
	"codex",
	"enabled"
];
const CODEX_PLUGIN_NATIVE_CONFIG_PATH = [
	"plugins",
	"entries",
	"codex",
	"config",
	"codexPlugins"
];
const MIGRATION_REASON_PLUGIN_EXISTS = "plugin exists";
const CODEX_PLUGIN_SOURCE_APP_VERIFICATION_UNVERIFIED = "not_run";
function uniqueSkillName(skill, counts) {
	const base = sanitizeName(skill.name) || "codex-skill";
	if ((counts.get(base) ?? 0) <= 1) return base;
	return sanitizeName([
		"codex",
		sanitizeName(path.basename(path.dirname(skill.source))),
		base
	].filter(Boolean).join("-")) || base;
}
async function buildSkillItems(params) {
	const baseCounts = /* @__PURE__ */ new Map();
	for (const skill of params.skills) {
		const base = sanitizeName(skill.name) || "codex-skill";
		baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
	}
	const resolvedCounts = /* @__PURE__ */ new Map();
	const planned = params.skills.map((skill) => {
		const name = uniqueSkillName(skill, baseCounts);
		resolvedCounts.set(name, (resolvedCounts.get(name) ?? 0) + 1);
		return {
			skill,
			name,
			target: path.join(params.workspaceDir, "skills", name)
		};
	});
	const items = [];
	for (const item of planned) {
		const collides = (resolvedCounts.get(item.name) ?? 0) > 1;
		const targetExists = await exists(item.target);
		items.push(createMigrationItem({
			id: `skill:${item.name}`,
			kind: "skill",
			action: "copy",
			source: item.skill.source,
			target: item.target,
			status: collides ? "conflict" : targetExists && !params.overwrite ? "conflict" : "planned",
			reason: collides ? `multiple Codex skills normalize to "${item.name}"` : targetExists && !params.overwrite ? MIGRATION_REASON_TARGET_EXISTS : void 0,
			message: `Copy ${item.skill.sourceLabel} into this OpenClaw agent workspace.`,
			details: {
				skillName: item.name,
				sourceLabel: item.skill.sourceLabel
			}
		}));
	}
	return items;
}
function uniquePluginConfigKey(plugin, counts, usedCounts) {
	const base = sanitizeName(plugin.pluginName ?? plugin.name) || "codex-plugin";
	if ((counts.get(base) ?? 0) <= 1) return base;
	const next = (usedCounts.get(base) ?? 0) + 1;
	usedCounts.set(base, next);
	return sanitizeName(`${base}-${next}`) || base;
}
function readExistingCodexPluginEntries(config) {
	const entries = readMigrationConfigPath(config, [...CODEX_PLUGIN_NATIVE_CONFIG_PATH, "plugins"]);
	return isRecord(entries) ? entries : {};
}
function hasExistingCodexPluginEntry(existingEntries, configKey, pluginName) {
	if (existingEntries[configKey] !== void 0) return true;
	return Object.values(existingEntries).some((entry) => {
		if (!isRecord(entry)) return false;
		return entry.pluginName === pluginName;
	});
}
function buildPluginItems(ctx, plugins) {
	const baseCounts = /* @__PURE__ */ new Map();
	for (const plugin of plugins.filter((entry) => entry.migratable)) {
		const base = sanitizeName(plugin.pluginName ?? plugin.name) || "codex-plugin";
		baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
	}
	const existingPluginEntries = readExistingCodexPluginEntries(ctx.config);
	const usedCounts = /* @__PURE__ */ new Map();
	let manualIndex = 0;
	const items = [];
	for (const plugin of plugins) {
		if (plugin.migratable && plugin.marketplaceName === "openai-curated" && plugin.pluginName) {
			const configKey = uniquePluginConfigKey(plugin, baseCounts, usedCounts);
			const conflict = !ctx.overwrite && hasExistingCodexPluginEntry(existingPluginEntries, configKey, plugin.pluginName);
			items.push(createMigrationItem({
				id: `plugin:${configKey}`,
				kind: "plugin",
				action: "install",
				status: conflict ? "conflict" : "planned",
				reason: conflict ? MIGRATION_REASON_PLUGIN_EXISTS : void 0,
				source: plugin.source,
				target: `plugins.entries.codex.config.codexPlugins.plugins.${configKey}`,
				message: `Install Codex plugin "${plugin.pluginName}" in the OpenClaw-managed Codex app-server runtime.`,
				details: {
					configKey,
					marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
					pluginName: plugin.pluginName,
					sourceInstalled: plugin.installed === true,
					sourceEnabled: plugin.enabled === true,
					...plugin.apps && plugin.apps.length > 0 && !shouldVerifyPluginApps(ctx) ? { sourceAppVerification: CODEX_PLUGIN_SOURCE_APP_VERIFICATION_UNVERIFIED } : {}
				}
			}));
			continue;
		}
		manualIndex += 1;
		if (plugin.migrationBlock && plugin.pluginName) {
			const details = {
				pluginName: plugin.pluginName,
				marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
				...plugin.migrationBlock.apps ? { apps: plugin.migrationBlock.apps } : {},
				...plugin.migrationBlock.error ? { error: plugin.migrationBlock.error } : {}
			};
			items.push(createMigrationItem({
				id: `plugin:${sanitizeName(plugin.name) || sanitizeName(path.basename(plugin.source))}:${manualIndex}`,
				kind: "manual",
				action: "manual",
				source: plugin.source,
				status: "skipped",
				reason: plugin.migrationBlock.code,
				message: plugin.message ?? `Codex native plugin "${plugin.name}" was found but not activated automatically.`,
				details: { ...details }
			}));
			continue;
		}
		items.push(createMigrationManualItem({
			id: `plugin:${sanitizeName(plugin.name) || sanitizeName(path.basename(plugin.source))}:${manualIndex}`,
			source: plugin.source,
			message: plugin.message ?? `Codex native plugin "${plugin.name}" was found but not activated automatically.`,
			recommendation: "Review the plugin bundle first, then install trusted compatible plugins with openclaw plugins install <path>."
		}));
	}
	return items;
}
function shouldVerifyPluginApps(ctx) {
	return ctx.providerOptions?.verifyPluginApps === true;
}
function readCodexPluginMigrationConfigEntry(item, enabled) {
	const configKey = item.details?.configKey;
	const marketplaceName = item.details?.marketplaceName;
	const pluginName = item.details?.pluginName;
	if (item.kind !== "plugin" || item.action !== "install" || typeof configKey !== "string" || marketplaceName !== "openai-curated" || typeof pluginName !== "string") return;
	return {
		configKey,
		pluginName,
		enabled
	};
}
function readExistingAllowDestructiveActions(config) {
	const value = readMigrationConfigPath(config, [...CODEX_PLUGIN_NATIVE_CONFIG_PATH, "allow_destructive_actions"]);
	return typeof value === "boolean" ? value : void 0;
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function buildCodexPluginsConfigValue(entries, params = {}) {
	const plugins = Object.fromEntries(entries.toSorted((a, b) => a.configKey.localeCompare(b.configKey)).map((entry) => [entry.configKey, {
		enabled: entry.enabled,
		marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
		pluginName: entry.pluginName
	}]));
	return {
		enabled: true,
		config: { codexPlugins: {
			enabled: true,
			allow_destructive_actions: params.config === void 0 ? true : readExistingAllowDestructiveActions(params.config) ?? true,
			plugins
		} }
	};
}
function hasCodexPluginConfigConflict(config, value) {
	const enabled = readMigrationConfigPath(config, CODEX_PLUGIN_ENABLED_PATH);
	if (enabled !== void 0 && enabled !== true) return true;
	const nativeConfig = value.config?.codexPlugins;
	if (!isRecord(nativeConfig)) return hasMigrationConfigPatchConflict(config, CODEX_PLUGIN_NATIVE_CONFIG_PATH, nativeConfig);
	const existingNativeConfig = readMigrationConfigPath(config, CODEX_PLUGIN_NATIVE_CONFIG_PATH);
	if (existingNativeConfig === void 0) return false;
	if (!isRecord(existingNativeConfig)) return true;
	if (existingNativeConfig.enabled !== void 0 && existingNativeConfig.enabled !== true) return true;
	const allowDestructiveActions = nativeConfig.allow_destructive_actions;
	if (existingNativeConfig.allow_destructive_actions !== void 0 && existingNativeConfig.allow_destructive_actions !== allowDestructiveActions) return true;
	const plugins = nativeConfig.plugins;
	if (!isRecord(plugins)) return false;
	return Object.entries(plugins).some(([configKey, plugin]) => {
		if (!isRecord(plugin)) return existingNativeConfig[configKey] !== void 0;
		return hasExistingCodexPluginEntry(readExistingCodexPluginEntries(config), configKey, typeof plugin.pluginName === "string" ? plugin.pluginName : configKey);
	});
}
function buildPluginConfigItem(ctx, pluginItems) {
	const entries = pluginItems.filter((item) => item.status === "planned").map((item) => readCodexPluginMigrationConfigEntry(item, true)).filter((entry) => entry !== void 0);
	if (entries.length === 0) return;
	const value = buildCodexPluginsConfigValue(entries, { config: ctx.config });
	const conflict = !ctx.overwrite && hasCodexPluginConfigConflict(ctx.config, value);
	return createMigrationItem({
		id: CODEX_PLUGIN_CONFIG_ITEM_ID,
		kind: "config",
		action: "merge",
		target: "plugins.entries.codex.config.codexPlugins",
		status: conflict ? "conflict" : "planned",
		reason: conflict ? MIGRATION_REASON_TARGET_EXISTS : void 0,
		message: "Enable OpenClaw's Codex plugin integration and record migrated source-installed curated plugins.",
		details: {
			path: [...CODEX_PLUGIN_CONFIG_PATH],
			value
		}
	});
}
async function buildCodexMigrationPlan(ctx) {
	const targets = resolveCodexMigrationTargets(ctx);
	const source = await discoverCodexSource({
		input: ctx.source,
		evaluatePluginMigrationEligibility: true,
		verifyPluginApps: shouldVerifyPluginApps(ctx)
	});
	if (!hasCodexSource(source)) throw new Error(`Codex state was not found at ${source.root}. Pass --from <path> if it lives elsewhere.`);
	const items = [];
	items.push(...await buildSkillItems({
		skills: source.skills,
		workspaceDir: targets.workspaceDir,
		overwrite: ctx.overwrite
	}));
	const pluginItems = buildPluginItems(ctx, source.plugins);
	items.push(...pluginItems);
	const pluginConfigItem = buildPluginConfigItem(ctx, pluginItems);
	if (pluginConfigItem) items.push(pluginConfigItem);
	for (const archivePath of source.archivePaths) items.push(createMigrationItem({
		id: archivePath.id,
		kind: "archive",
		action: "archive",
		source: archivePath.path,
		message: archivePath.message ?? "Archived in the migration report for manual review; not imported into live config.",
		details: { archiveRelativePath: archivePath.relativePath }
	}));
	const warnings = [
		...items.some((item) => item.status === "conflict") ? ["Conflicts were found. Re-run with --overwrite to replace conflicting migration targets after item-level backups."] : [],
		...source.plugins.some((plugin) => plugin.migratable) ? ["Codex source-installed openai-curated plugins are planned for native activation; cached plugin bundles remain manual-review only."] : [],
		...source.plugins.some((plugin) => plugin.migratable && plugin.apps && plugin.apps.length > 0) && !shouldVerifyPluginApps(ctx) ? ["Codex app-backed plugins were planned without source app accessibility verification. Re-run with --verify-plugin-apps to force a fresh source app/list check before planning native plugin activation."] : [],
		...source.plugins.some((plugin) => plugin.sourceKind === "cache") ? ["Codex cached plugin bundles remain manual-review only."] : [],
		...source.pluginDiscoveryError ? [`Codex app-server plugin inventory discovery failed: ${source.pluginDiscoveryError}. Cached plugin bundles, if any, are advisory only.`] : [],
		...source.plugins.some((plugin) => plugin.migrationBlock?.code === "codex_subscription_required") ? [codexPluginMigrationSubscriptionWarning()] : [],
		...source.archivePaths.length > 0 ? ["Codex config and hook files are archive-only. They are preserved in the migration report, not loaded into OpenClaw automatically."] : []
	];
	return {
		providerId: "codex",
		source: source.root,
		target: targets.workspaceDir,
		summary: summarizeMigrationItems(items),
		items,
		warnings,
		nextSteps: ["Run openclaw doctor after applying the migration.", "Review skipped or auth-required Codex plugin/config/hook items before exposing them in OpenClaw sessions."],
		metadata: {
			agentDir: targets.agentDir,
			codexHome: source.codexHome,
			codexSkillsDir: source.codexSkillsDir,
			personalAgentsSkillsDir: source.personalAgentsSkillsDir
		}
	};
}
//#endregion
//#region extensions/codex/src/migration/apply.ts
const CODEX_PLUGIN_AUTH_REQUIRED_REASON = "auth_required";
const CODEX_PLUGIN_NOT_SELECTED_REASON = "not selected for migration";
var CodexPluginConfigConflictError = class extends Error {
	constructor(reason) {
		super(reason);
		this.reason = reason;
		this.name = "CodexPluginConfigConflictError";
	}
};
async function applyCodexMigrationPlan(params) {
	const plan = params.plan ?? await buildCodexMigrationPlan(params.ctx);
	const reportDir = params.ctx.reportDir ?? path.join(params.ctx.stateDir, "migration", "codex");
	const items = [];
	const runtime = withCachedMigrationConfigRuntime(params.ctx.runtime ?? params.runtime, params.ctx.config);
	const applyCtx = {
		...params.ctx,
		runtime
	};
	for (const item of plan.items) {
		if (item.status !== "planned") {
			items.push(item);
			continue;
		}
		if (item.id === "config:codex-plugins") items.push(await applyCodexPluginConfigItem(applyCtx, item, items));
		else if (item.kind === "plugin" && item.action === "install") items.push(await applyCodexPluginInstallItem(applyCtx, item));
		else if (item.kind === "manual") items.push(applyMigrationManualItem(item));
		else if (item.action === "archive") items.push(await archiveMigrationItem(item, reportDir));
		else items.push(await copyMigrationFileItem(item, reportDir, { overwrite: params.ctx.overwrite }));
	}
	const result = {
		...plan,
		items,
		summary: summarizeMigrationItems(items),
		backupPath: params.ctx.backupPath,
		reportDir
	};
	await writeMigrationReport(result, { title: "Codex Migration Report" });
	return result;
}
async function applyCodexPluginInstallItem(ctx, item) {
	const policy = readCodexPluginPolicy(item);
	if (!policy) return {
		...markMigrationItemError(item, "invalid Codex plugin migration item"),
		details: {
			...item.details,
			code: "invalid_plugin_item"
		}
	};
	try {
		const appCacheKey = await buildTargetCodexPluginAppCacheKey(ctx);
		const appServer = resolveTargetCodexAppServer(ctx);
		const result = await ensureCodexPluginActivation({
			identity: policy,
			installEvenIfActive: true,
			request: async (method, requestParams) => await requestCodexAppServerJson({
				method,
				requestParams,
				timeoutMs: 6e4,
				startOptions: appServer.start,
				agentDir: resolveCodexMigrationTargets(ctx).agentDir,
				config: ctx.config,
				isolated: true
			}),
			appCache: defaultCodexAppInventoryCache,
			appCacheKey
		});
		const baseDetails = {
			...item.details,
			code: result.reason,
			activationReason: result.reason,
			...codexPluginActivationReportState(result),
			installAttempted: result.installAttempted,
			diagnostics: result.diagnostics.map((diagnostic) => diagnostic.message)
		};
		if (result.ok) return {
			...item,
			status: "migrated",
			...result.reason === "already_active" ? { reason: "already active" } : {},
			details: baseDetails
		};
		if (result.reason === CODEX_PLUGIN_AUTH_REQUIRED_REASON) return {
			...item,
			status: "skipped",
			reason: CODEX_PLUGIN_AUTH_REQUIRED_REASON,
			details: {
				...baseDetails,
				appsNeedingAuth: sanitizeAppsNeedingAuth(result.installResponse?.appsNeedingAuth ?? [])
			}
		};
		return {
			...item,
			status: "error",
			reason: result.reason,
			details: baseDetails
		};
	} catch (error) {
		return {
			...item,
			status: "error",
			reason: error instanceof Error ? error.message : String(error),
			details: {
				...item.details,
				code: "plugin_install_failed"
			}
		};
	}
}
function resolveTargetCodexAppServer(ctx) {
	return resolveCodexAppServerRuntimeOptions({ pluginConfig: readCodexPluginConfig(ctx.config) });
}
async function buildTargetCodexPluginAppCacheKey(ctx) {
	const targets = resolveCodexMigrationTargets(ctx);
	const appServer = resolveTargetCodexAppServer(ctx);
	const authProfileId = resolveCodexAppServerAuthProfileIdForAgent({
		agentDir: targets.agentDir,
		config: ctx.config
	});
	const accountId = await resolveCodexAppServerAuthAccountCacheKey({
		authProfileId,
		agentDir: targets.agentDir,
		config: ctx.config
	});
	const envApiKeyFingerprint = authProfileId ? void 0 : resolveCodexAppServerEnvApiKeyCacheKey({ startOptions: appServer.start });
	return buildCodexPluginAppCacheKey({
		appServer,
		agentDir: targets.agentDir,
		authProfileId,
		accountId,
		envApiKeyFingerprint
	});
}
async function applyCodexPluginConfigItem(ctx, item, appliedItems) {
	const entries = appliedItems.map(readAppliedPluginConfigEntry).filter((entry) => entry !== void 0);
	if (entries.length === 0) return markMigrationItemSkipped(item, "no selected Codex plugins");
	const configApi = ctx.runtime?.config;
	if (!configApi?.current || !configApi.mutateConfigFile) return markMigrationItemError(item, "config runtime unavailable");
	const currentConfig = configApi.current();
	const value = buildCodexPluginsConfigValue(entries, { config: currentConfig });
	if (!ctx.overwrite && hasCodexPluginConfigConflict(currentConfig, value)) return markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS);
	try {
		await configApi.mutateConfigFile({
			base: "runtime",
			afterWrite: { mode: "auto" },
			mutate(draft) {
				if (!ctx.overwrite && hasCodexPluginConfigConflict(draft, value)) throw new CodexPluginConfigConflictError(MIGRATION_REASON_TARGET_EXISTS);
				writeMigrationConfigPath(draft, CODEX_PLUGIN_CONFIG_PATH, value);
			}
		});
		return {
			...item,
			status: "migrated",
			details: {
				...item.details,
				path: [...CODEX_PLUGIN_CONFIG_PATH],
				value
			}
		};
	} catch (error) {
		if (error instanceof CodexPluginConfigConflictError) return markMigrationItemConflict(item, error.reason);
		return markMigrationItemError(item, error instanceof Error ? error.message : String(error));
	}
}
function readAppliedPluginConfigEntry(item) {
	if (item.status === "migrated") return readCodexPluginMigrationConfigEntry(item, true);
	if (item.status === "skipped" && item.reason !== CODEX_PLUGIN_NOT_SELECTED_REASON && item.reason === CODEX_PLUGIN_AUTH_REQUIRED_REASON) return readCodexPluginMigrationConfigEntry(item, false);
}
function readCodexPluginPolicy(item) {
	const configKey = item.details?.configKey;
	const marketplaceName = item.details?.marketplaceName;
	const pluginName = item.details?.pluginName;
	if (typeof configKey !== "string" || marketplaceName !== "openai-curated" || typeof pluginName !== "string") return;
	return {
		configKey,
		marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
		pluginName,
		enabled: true,
		allowDestructiveActions: true
	};
}
function codexPluginActivationReportState(result) {
	switch (result.reason) {
		case "already_active":
		case "installed": return {
			installed: true,
			enabled: true
		};
		case "auth_required": return {
			installed: true,
			enabled: false
		};
		case "disabled":
		case "marketplace_missing":
		case "plugin_missing": return {
			installed: false,
			enabled: false
		};
		case "refresh_failed": return {
			installed: true,
			enabled: false
		};
	}
	return result.reason;
}
function sanitizeAppsNeedingAuth(apps) {
	return apps.map((app) => ({
		id: app.id,
		name: app.name,
		needsAuth: app.needsAuth
	}));
}
//#endregion
//#region extensions/codex/src/migration/provider.ts
function buildCodexMigrationProvider(params = {}) {
	return {
		id: "codex",
		label: "Codex",
		description: "Inventory and promote Codex CLI skills while keeping Codex native plugins and hooks explicit.",
		async detect(ctx) {
			const source = await discoverCodexSource({ input: ctx.source });
			const found = hasCodexSource(source);
			return {
				found,
				source: source.root,
				label: "Codex",
				confidence: found ? source.confidence : "low",
				message: found ? "Codex state found." : "Codex state not found."
			};
		},
		plan: buildCodexMigrationPlan,
		async apply(ctx, plan) {
			return await applyCodexMigrationPlan({
				ctx,
				plan,
				runtime: params.runtime
			});
		}
	};
}
//#endregion
//#region extensions/codex/index.ts
var codex_default = definePluginEntry({
	id: "codex",
	name: "Codex",
	description: "Codex app-server harness and Codex-managed GPT model catalog.",
	register(api) {
		const resolveCurrentPluginConfig = () => resolveLivePluginConfigObject(api.runtime.config?.current ? () => api.runtime.config.current() : void 0, "codex", api.pluginConfig) ?? api.pluginConfig;
		api.registerAgentHarness(createCodexAppServerAgentHarness({ pluginConfig: api.pluginConfig }));
		api.registerProvider(buildCodexProvider({ pluginConfig: api.pluginConfig }));
		api.registerMediaUnderstandingProvider(buildCodexMediaUnderstandingProvider({ pluginConfig: api.pluginConfig }));
		api.registerMigrationProvider(buildCodexMigrationProvider({ runtime: api.runtime }));
		api.registerCommand(createCodexCommand({ pluginConfig: api.pluginConfig }));
		api.on("inbound_claim", (event, ctx) => handleCodexConversationInboundClaim(event, ctx, { pluginConfig: resolveCurrentPluginConfig() }));
		api.onConversationBindingResolved?.(handleCodexConversationBindingResolved);
	}
});
//#endregion
export { codex_default as default };
