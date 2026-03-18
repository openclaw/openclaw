import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import "./globals-B6h30oSy.js";
import { i as init_paths, v as resolveStateDir } from "./paths-DqbqmTPe.js";
import { i as theme, n as init_theme } from "./theme-CL08MjAq.js";
import { d as defaultRuntime, f as init_runtime } from "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import { C as shortenHomePath, S as shortenHomeInString, b as resolveUserPath, d as init_utils } from "./utils-BiUV1eIQ.js";
import { t as formatDocsLink } from "./links-DPi3kBux.js";
import { Jb as writeConfigFile, zb as loadConfig, zu as resolveArchiveKind } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import { Gn as applyExclusiveSlotSelection, Kn as defaultSlotIdForKey, qn as init_slots } from "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import { o as resolvePluginSourceRoots, t as clearPluginManifestRegistryCache } from "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import { B as promptYesNo } from "./config-DZ3oWznn.js";
import "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-BGZZcqHp.js";
import "./skill-scanner-PR6IiKx6.js";
import "./install-target-RUKPUVdS.js";
import { i as buildPluginStatusReport, n as resolvePinnedNpmInstallRecordForCli, r as looksLikeLocalInstallSpec } from "./npm-resolution-BZVmqUov.js";
import { a as installPluginFromPath, i as installPluginFromNpmSpec, n as recordPluginInstall, o as resolvePluginInstallDir, s as findBundledPluginSource } from "./installs-DSXtJar6.js";
import { n as setPluginEnabledInConfig, t as enablePluginInConfig } from "./enable-Fw1VqrSH.js";
import { a as resolveMarketplaceInstallShortcut, i as listMarketplacePlugins, n as updateNpmInstalledPlugins, r as installPluginFromMarketplace } from "./update-DSzeB1Ud.js";
import { r as resolveBundledInstallPlanForNpmFailure, t as resolveBundledInstallPlanBeforeNpm } from "./plugin-install-plan-idGL8Mdm.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import fs$1 from "node:fs/promises";
//#region src/plugins/source-display.ts
init_slots();
init_paths();
init_utils();
function tryRelative(root, filePath) {
	const rel = path.relative(root, filePath);
	if (!rel || rel === ".") return null;
	if (rel === "..") return null;
	if (rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || rel.startsWith("..\\")) return null;
	if (path.isAbsolute(rel)) return null;
	return rel.replaceAll("\\", "/");
}
function formatPluginSourceForTable(plugin, roots) {
	const raw = plugin.source;
	if (plugin.origin === "bundled" && roots.stock) {
		const rel = tryRelative(roots.stock, raw);
		if (rel) return {
			value: `stock:${rel}`,
			rootKey: "stock"
		};
	}
	if (plugin.origin === "workspace" && roots.workspace) {
		const rel = tryRelative(roots.workspace, raw);
		if (rel) return {
			value: `workspace:${rel}`,
			rootKey: "workspace"
		};
	}
	if (plugin.origin === "global" && roots.global) {
		const rel = tryRelative(roots.global, raw);
		if (rel) return {
			value: `global:${rel}`,
			rootKey: "global"
		};
	}
	return { value: shortenHomeInString(raw) };
}
//#endregion
//#region src/plugins/uninstall.ts
function resolveUninstallDirectoryTarget(params) {
	if (!params.hasInstall) return null;
	if (params.installRecord?.source === "path") return null;
	let defaultPath;
	try {
		defaultPath = resolvePluginInstallDir(params.pluginId, params.extensionsDir);
	} catch {
		return null;
	}
	const configuredPath = params.installRecord?.installPath;
	if (!configuredPath) return defaultPath;
	if (path.resolve(configuredPath) === path.resolve(defaultPath)) return configuredPath;
	return defaultPath;
}
/**
* Remove plugin references from config (pure config mutation).
* Returns a new config with the plugin removed from entries, installs, allow, load.paths, and slots.
*/
function removePluginFromConfig(cfg, pluginId) {
	const actions = {
		entry: false,
		install: false,
		allowlist: false,
		loadPath: false,
		memorySlot: false
	};
	const pluginsConfig = cfg.plugins ?? {};
	let entries = pluginsConfig.entries;
	if (entries && pluginId in entries) {
		const { [pluginId]: _, ...rest } = entries;
		entries = Object.keys(rest).length > 0 ? rest : void 0;
		actions.entry = true;
	}
	let installs = pluginsConfig.installs;
	const installRecord = installs?.[pluginId];
	if (installs && pluginId in installs) {
		const { [pluginId]: _, ...rest } = installs;
		installs = Object.keys(rest).length > 0 ? rest : void 0;
		actions.install = true;
	}
	let allow = pluginsConfig.allow;
	if (Array.isArray(allow) && allow.includes(pluginId)) {
		allow = allow.filter((id) => id !== pluginId);
		if (allow.length === 0) allow = void 0;
		actions.allowlist = true;
	}
	let load = pluginsConfig.load;
	if (installRecord?.source === "path" && installRecord.sourcePath) {
		const sourcePath = installRecord.sourcePath;
		const loadPaths = load?.paths;
		if (Array.isArray(loadPaths) && loadPaths.includes(sourcePath)) {
			const nextLoadPaths = loadPaths.filter((p) => p !== sourcePath);
			load = nextLoadPaths.length > 0 ? {
				...load,
				paths: nextLoadPaths
			} : void 0;
			actions.loadPath = true;
		}
	}
	let slots = pluginsConfig.slots;
	if (slots?.memory === pluginId) {
		slots = {
			...slots,
			memory: defaultSlotIdForKey("memory")
		};
		actions.memorySlot = true;
	}
	if (slots && Object.keys(slots).length === 0) slots = void 0;
	const cleanedPlugins = {
		...pluginsConfig,
		entries,
		installs,
		allow,
		load,
		slots
	};
	if (cleanedPlugins.entries === void 0) delete cleanedPlugins.entries;
	if (cleanedPlugins.installs === void 0) delete cleanedPlugins.installs;
	if (cleanedPlugins.allow === void 0) delete cleanedPlugins.allow;
	if (cleanedPlugins.load === void 0) delete cleanedPlugins.load;
	if (cleanedPlugins.slots === void 0) delete cleanedPlugins.slots;
	return {
		config: {
			...cfg,
			plugins: Object.keys(cleanedPlugins).length > 0 ? cleanedPlugins : void 0
		},
		actions
	};
}
/**
* Uninstall a plugin by removing it from config and optionally deleting installed files.
* Linked plugins (source === "path") never have their source directory deleted.
*/
async function uninstallPlugin(params) {
	const { config, pluginId, deleteFiles = true, extensionsDir } = params;
	const hasEntry = pluginId in (config.plugins?.entries ?? {});
	const hasInstall = pluginId in (config.plugins?.installs ?? {});
	if (!hasEntry && !hasInstall) return {
		ok: false,
		error: `Plugin not found: ${pluginId}`
	};
	const installRecord = config.plugins?.installs?.[pluginId];
	const isLinked = installRecord?.source === "path";
	const { config: newConfig, actions: configActions } = removePluginFromConfig(config, pluginId);
	const actions = {
		...configActions,
		directory: false
	};
	const warnings = [];
	const deleteTarget = deleteFiles && !isLinked ? resolveUninstallDirectoryTarget({
		pluginId,
		hasInstall,
		installRecord,
		extensionsDir
	}) : null;
	if (deleteTarget) {
		const existed = await fs$1.access(deleteTarget).then(() => true).catch(() => false) ?? false;
		try {
			await fs$1.rm(deleteTarget, {
				recursive: true,
				force: true
			});
			actions.directory = existed;
		} catch (error) {
			warnings.push(`Failed to remove plugin directory ${deleteTarget}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		ok: true,
		config: newConfig,
		pluginId,
		actions,
		warnings
	};
}
//#endregion
//#region src/cli/plugins-config.ts
init_runtime();
init_theme();
//#endregion
//#region src/cli/plugins-cli.ts
init_slots();
init_utils();
function resolveFileNpmSpecToLocalPath(raw) {
	const trimmed = raw.trim();
	if (!trimmed.toLowerCase().startsWith("file:")) return null;
	const rest = trimmed.slice(5);
	if (!rest) return {
		ok: false,
		error: "unsupported file: spec: missing path"
	};
	if (rest.startsWith("///")) return {
		ok: true,
		path: rest.slice(2)
	};
	if (rest.startsWith("//localhost/")) return {
		ok: true,
		path: rest.slice(11)
	};
	if (rest.startsWith("//")) return {
		ok: false,
		error: "unsupported file: URL host (expected \"file:<path>\" or \"file:///abs/path\")"
	};
	return {
		ok: true,
		path: rest
	};
}
function formatPluginLine(plugin, verbose = false) {
	const status = plugin.status === "loaded" ? theme.success("loaded") : plugin.status === "disabled" ? theme.warn("disabled") : theme.error("error");
	const name = theme.command(plugin.name || plugin.id);
	const idSuffix = plugin.name && plugin.name !== plugin.id ? theme.muted(` (${plugin.id})`) : "";
	const desc = plugin.description ? theme.muted(plugin.description.length > 60 ? `${plugin.description.slice(0, 57)}...` : plugin.description) : theme.muted("(no description)");
	const format = plugin.format ?? "openclaw";
	if (!verbose) return `${name}${idSuffix} ${status} ${theme.muted(`[${format}]`)} - ${desc}`;
	const parts = [
		`${name}${idSuffix} ${status}`,
		`  format: ${format}`,
		`  source: ${theme.muted(shortenHomeInString(plugin.source))}`,
		`  origin: ${plugin.origin}`
	];
	if (plugin.bundleFormat) parts.push(`  bundle format: ${plugin.bundleFormat}`);
	if (plugin.version) parts.push(`  version: ${plugin.version}`);
	if (plugin.providerIds.length > 0) parts.push(`  providers: ${plugin.providerIds.join(", ")}`);
	if (plugin.error) parts.push(theme.error(`  error: ${plugin.error}`));
	return parts.join("\n");
}
function applySlotSelectionForPlugin(config, pluginId) {
	const report = buildPluginStatusReport({ config });
	const plugin = report.plugins.find((entry) => entry.id === pluginId);
	if (!plugin) return {
		config,
		warnings: []
	};
	const result = applyExclusiveSlotSelection({
		config,
		selectedId: plugin.id,
		selectedKind: plugin.kind,
		registry: report
	});
	return {
		config: result.config,
		warnings: result.warnings
	};
}
function createPluginInstallLogger() {
	return {
		info: (msg) => defaultRuntime.log(msg),
		warn: (msg) => defaultRuntime.log(theme.warn(msg))
	};
}
function logSlotWarnings(warnings) {
	if (warnings.length === 0) return;
	for (const warning of warnings) defaultRuntime.log(theme.warn(warning));
}
async function installBundledPluginSource(params) {
	const existing = params.config.plugins?.load?.paths ?? [];
	const mergedPaths = Array.from(new Set([...existing, params.bundledSource.localPath]));
	let next = {
		...params.config,
		plugins: {
			...params.config.plugins,
			load: {
				...params.config.plugins?.load,
				paths: mergedPaths
			},
			entries: {
				...params.config.plugins?.entries,
				[params.bundledSource.pluginId]: {
					...params.config.plugins?.entries?.[params.bundledSource.pluginId],
					enabled: true
				}
			}
		}
	};
	next = recordPluginInstall(next, {
		pluginId: params.bundledSource.pluginId,
		source: "path",
		spec: params.rawSpec,
		sourcePath: params.bundledSource.localPath,
		installPath: params.bundledSource.localPath
	});
	const slotResult = applySlotSelectionForPlugin(next, params.bundledSource.pluginId);
	next = slotResult.config;
	await writeConfigFile(next);
	logSlotWarnings(slotResult.warnings);
	defaultRuntime.log(theme.warn(params.warning));
	defaultRuntime.log(`Installed plugin: ${params.bundledSource.pluginId}`);
	defaultRuntime.log(`Restart the gateway to load plugins.`);
}
async function runPluginInstallCommand(params) {
	const shorthand = !params.opts.marketplace ? await resolveMarketplaceInstallShortcut(params.raw) : null;
	if (shorthand?.ok === false) {
		defaultRuntime.error(shorthand.error);
		process.exit(1);
	}
	const raw = shorthand?.ok ? shorthand.plugin : params.raw;
	const opts = {
		...params.opts,
		marketplace: params.opts.marketplace ?? (shorthand?.ok ? shorthand.marketplaceSource : void 0)
	};
	if (opts.marketplace) {
		if (opts.link) {
			defaultRuntime.error("`--link` is not supported with `--marketplace`.");
			process.exit(1);
		}
		if (opts.pin) {
			defaultRuntime.error("`--pin` is not supported with `--marketplace`.");
			process.exit(1);
		}
		const cfg = loadConfig();
		const result = await installPluginFromMarketplace({
			marketplace: opts.marketplace,
			plugin: raw,
			logger: createPluginInstallLogger()
		});
		if (!result.ok) {
			defaultRuntime.error(result.error);
			process.exit(1);
		}
		clearPluginManifestRegistryCache();
		let next = enablePluginInConfig(cfg, result.pluginId).config;
		next = recordPluginInstall(next, {
			pluginId: result.pluginId,
			source: "marketplace",
			installPath: result.targetDir,
			version: result.version,
			marketplaceName: result.marketplaceName,
			marketplaceSource: result.marketplaceSource,
			marketplacePlugin: result.marketplacePlugin
		});
		const slotResult = applySlotSelectionForPlugin(next, result.pluginId);
		next = slotResult.config;
		await writeConfigFile(next);
		logSlotWarnings(slotResult.warnings);
		defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
		defaultRuntime.log(`Restart the gateway to load plugins.`);
		return;
	}
	const fileSpec = resolveFileNpmSpecToLocalPath(raw);
	if (fileSpec && !fileSpec.ok) {
		defaultRuntime.error(fileSpec.error);
		process.exit(1);
	}
	const resolved = resolveUserPath(fileSpec && fileSpec.ok ? fileSpec.path : raw);
	const cfg = loadConfig();
	if (fs.existsSync(resolved)) {
		if (opts.link) {
			const existing = cfg.plugins?.load?.paths ?? [];
			const merged = Array.from(new Set([...existing, resolved]));
			const probe = await installPluginFromPath({
				path: resolved,
				dryRun: true
			});
			if (!probe.ok) {
				defaultRuntime.error(probe.error);
				process.exit(1);
			}
			let next = enablePluginInConfig({
				...cfg,
				plugins: {
					...cfg.plugins,
					load: {
						...cfg.plugins?.load,
						paths: merged
					}
				}
			}, probe.pluginId).config;
			next = recordPluginInstall(next, {
				pluginId: probe.pluginId,
				source: "path",
				sourcePath: resolved,
				installPath: resolved,
				version: probe.version
			});
			const slotResult = applySlotSelectionForPlugin(next, probe.pluginId);
			next = slotResult.config;
			await writeConfigFile(next);
			logSlotWarnings(slotResult.warnings);
			defaultRuntime.log(`Linked plugin path: ${shortenHomePath(resolved)}`);
			defaultRuntime.log(`Restart the gateway to load plugins.`);
			return;
		}
		const result = await installPluginFromPath({
			path: resolved,
			logger: createPluginInstallLogger()
		});
		if (!result.ok) {
			defaultRuntime.error(result.error);
			process.exit(1);
		}
		clearPluginManifestRegistryCache();
		let next = enablePluginInConfig(cfg, result.pluginId).config;
		const source = resolveArchiveKind(resolved) ? "archive" : "path";
		next = recordPluginInstall(next, {
			pluginId: result.pluginId,
			source,
			sourcePath: resolved,
			installPath: result.targetDir,
			version: result.version
		});
		const slotResult = applySlotSelectionForPlugin(next, result.pluginId);
		next = slotResult.config;
		await writeConfigFile(next);
		logSlotWarnings(slotResult.warnings);
		defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
		defaultRuntime.log(`Restart the gateway to load plugins.`);
		return;
	}
	if (opts.link) {
		defaultRuntime.error("`--link` requires a local path.");
		process.exit(1);
	}
	if (looksLikeLocalInstallSpec(raw, [
		".ts",
		".js",
		".mjs",
		".cjs",
		".tgz",
		".tar.gz",
		".tar",
		".zip"
	])) {
		defaultRuntime.error(`Path not found: ${resolved}`);
		process.exit(1);
	}
	const bundledPreNpmPlan = resolveBundledInstallPlanBeforeNpm({
		rawSpec: raw,
		findBundledSource: (lookup) => findBundledPluginSource({ lookup })
	});
	if (bundledPreNpmPlan) {
		await installBundledPluginSource({
			config: cfg,
			rawSpec: raw,
			bundledSource: bundledPreNpmPlan.bundledSource,
			warning: bundledPreNpmPlan.warning
		});
		return;
	}
	const result = await installPluginFromNpmSpec({
		spec: raw,
		logger: createPluginInstallLogger()
	});
	if (!result.ok) {
		const bundledFallbackPlan = resolveBundledInstallPlanForNpmFailure({
			rawSpec: raw,
			code: result.code,
			findBundledSource: (lookup) => findBundledPluginSource({ lookup })
		});
		if (!bundledFallbackPlan) {
			defaultRuntime.error(result.error);
			process.exit(1);
		}
		await installBundledPluginSource({
			config: cfg,
			rawSpec: raw,
			bundledSource: bundledFallbackPlan.bundledSource,
			warning: bundledFallbackPlan.warning
		});
		return;
	}
	clearPluginManifestRegistryCache();
	let next = enablePluginInConfig(cfg, result.pluginId).config;
	const installRecord = resolvePinnedNpmInstallRecordForCli(raw, Boolean(opts.pin), result.targetDir, result.version, result.npmResolution, defaultRuntime.log, theme.warn);
	next = recordPluginInstall(next, {
		pluginId: result.pluginId,
		...installRecord
	});
	const slotResult = applySlotSelectionForPlugin(next, result.pluginId);
	next = slotResult.config;
	await writeConfigFile(next);
	logSlotWarnings(slotResult.warnings);
	defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
	defaultRuntime.log(`Restart the gateway to load plugins.`);
}
function registerPluginsCli(program) {
	const plugins = program.command("plugins").description("Manage OpenClaw plugins and extensions").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/plugins", "docs.openclaw.ai/cli/plugins")}\n`);
	plugins.command("list").description("List discovered plugins").option("--json", "Print JSON").option("--enabled", "Only show enabled plugins", false).option("--verbose", "Show detailed entries", false).action((opts) => {
		const report = buildPluginStatusReport();
		const list = opts.enabled ? report.plugins.filter((p) => p.status === "loaded") : report.plugins;
		if (opts.json) {
			const payload = {
				workspaceDir: report.workspaceDir,
				plugins: list,
				diagnostics: report.diagnostics
			};
			defaultRuntime.log(JSON.stringify(payload, null, 2));
			return;
		}
		if (list.length === 0) {
			defaultRuntime.log(theme.muted("No plugins found."));
			return;
		}
		const loaded = list.filter((p) => p.status === "loaded").length;
		defaultRuntime.log(`${theme.heading("Plugins")} ${theme.muted(`(${loaded}/${list.length} loaded)`)}`);
		if (!opts.verbose) {
			const tableWidth = getTerminalTableWidth();
			const sourceRoots = resolvePluginSourceRoots({ workspaceDir: report.workspaceDir });
			const usedRoots = /* @__PURE__ */ new Set();
			const rows = list.map((plugin) => {
				const desc = plugin.description ? theme.muted(plugin.description) : "";
				const formattedSource = formatPluginSourceForTable(plugin, sourceRoots);
				if (formattedSource.rootKey) usedRoots.add(formattedSource.rootKey);
				const sourceLine = desc ? `${formattedSource.value}\n${desc}` : formattedSource.value;
				return {
					Name: plugin.name || plugin.id,
					ID: plugin.name && plugin.name !== plugin.id ? plugin.id : "",
					Format: plugin.format ?? "openclaw",
					Status: plugin.status === "loaded" ? theme.success("loaded") : plugin.status === "disabled" ? theme.warn("disabled") : theme.error("error"),
					Source: sourceLine,
					Version: plugin.version ?? ""
				};
			});
			if (usedRoots.size > 0) {
				defaultRuntime.log(theme.muted("Source roots:"));
				for (const key of [
					"stock",
					"workspace",
					"global"
				]) {
					if (!usedRoots.has(key)) continue;
					const dir = sourceRoots[key];
					if (!dir) continue;
					defaultRuntime.log(`  ${theme.command(`${key}:`)} ${theme.muted(dir)}`);
				}
				defaultRuntime.log("");
			}
			defaultRuntime.log(renderTable({
				width: tableWidth,
				columns: [
					{
						key: "Name",
						header: "Name",
						minWidth: 14,
						flex: true
					},
					{
						key: "ID",
						header: "ID",
						minWidth: 10,
						flex: true
					},
					{
						key: "Format",
						header: "Format",
						minWidth: 9
					},
					{
						key: "Status",
						header: "Status",
						minWidth: 10
					},
					{
						key: "Source",
						header: "Source",
						minWidth: 26,
						flex: true
					},
					{
						key: "Version",
						header: "Version",
						minWidth: 8
					}
				],
				rows
			}).trimEnd());
			return;
		}
		const lines = [];
		for (const plugin of list) {
			lines.push(formatPluginLine(plugin, true));
			lines.push("");
		}
		defaultRuntime.log(lines.join("\n").trim());
	});
	plugins.command("info").description("Show plugin details").argument("<id>", "Plugin id").option("--json", "Print JSON").action((id, opts) => {
		const plugin = buildPluginStatusReport().plugins.find((p) => p.id === id || p.name === id);
		if (!plugin) {
			defaultRuntime.error(`Plugin not found: ${id}`);
			process.exit(1);
		}
		const install = loadConfig().plugins?.installs?.[plugin.id];
		if (opts.json) {
			defaultRuntime.log(JSON.stringify(plugin, null, 2));
			return;
		}
		const lines = [];
		lines.push(theme.heading(plugin.name || plugin.id));
		if (plugin.name && plugin.name !== plugin.id) lines.push(theme.muted(`id: ${plugin.id}`));
		if (plugin.description) lines.push(plugin.description);
		lines.push("");
		lines.push(`${theme.muted("Status:")} ${plugin.status}`);
		lines.push(`${theme.muted("Format:")} ${plugin.format ?? "openclaw"}`);
		if (plugin.bundleFormat) lines.push(`${theme.muted("Bundle format:")} ${plugin.bundleFormat}`);
		lines.push(`${theme.muted("Source:")} ${shortenHomeInString(plugin.source)}`);
		lines.push(`${theme.muted("Origin:")} ${plugin.origin}`);
		if (plugin.version) lines.push(`${theme.muted("Version:")} ${plugin.version}`);
		if (plugin.toolNames.length > 0) lines.push(`${theme.muted("Tools:")} ${plugin.toolNames.join(", ")}`);
		if (plugin.hookNames.length > 0) lines.push(`${theme.muted("Hooks:")} ${plugin.hookNames.join(", ")}`);
		if (plugin.gatewayMethods.length > 0) lines.push(`${theme.muted("Gateway methods:")} ${plugin.gatewayMethods.join(", ")}`);
		if (plugin.providerIds.length > 0) lines.push(`${theme.muted("Providers:")} ${plugin.providerIds.join(", ")}`);
		if ((plugin.bundleCapabilities?.length ?? 0) > 0) lines.push(`${theme.muted("Bundle capabilities:")} ${plugin.bundleCapabilities?.join(", ")}`);
		if (plugin.cliCommands.length > 0) lines.push(`${theme.muted("CLI commands:")} ${plugin.cliCommands.join(", ")}`);
		if (plugin.services.length > 0) lines.push(`${theme.muted("Services:")} ${plugin.services.join(", ")}`);
		if (plugin.error) lines.push(`${theme.error("Error:")} ${plugin.error}`);
		if (install) {
			lines.push("");
			lines.push(`${theme.muted("Install:")} ${install.source}`);
			if (install.spec) lines.push(`${theme.muted("Spec:")} ${install.spec}`);
			if (install.sourcePath) lines.push(`${theme.muted("Source path:")} ${shortenHomePath(install.sourcePath)}`);
			if (install.installPath) lines.push(`${theme.muted("Install path:")} ${shortenHomePath(install.installPath)}`);
			if (install.version) lines.push(`${theme.muted("Recorded version:")} ${install.version}`);
			if (install.installedAt) lines.push(`${theme.muted("Installed at:")} ${install.installedAt}`);
		}
		defaultRuntime.log(lines.join("\n"));
	});
	plugins.command("enable").description("Enable a plugin in config").argument("<id>", "Plugin id").action(async (id) => {
		const enableResult = enablePluginInConfig(loadConfig(), id);
		let next = enableResult.config;
		const slotResult = applySlotSelectionForPlugin(next, id);
		next = slotResult.config;
		await writeConfigFile(next);
		logSlotWarnings(slotResult.warnings);
		if (enableResult.enabled) {
			defaultRuntime.log(`Enabled plugin "${id}". Restart the gateway to apply.`);
			return;
		}
		defaultRuntime.log(theme.warn(`Plugin "${id}" could not be enabled (${enableResult.reason ?? "unknown reason"}).`));
	});
	plugins.command("disable").description("Disable a plugin in config").argument("<id>", "Plugin id").action(async (id) => {
		await writeConfigFile(setPluginEnabledInConfig(loadConfig(), id, false));
		defaultRuntime.log(`Disabled plugin "${id}". Restart the gateway to apply.`);
	});
	plugins.command("uninstall").description("Uninstall a plugin").argument("<id>", "Plugin id").option("--keep-files", "Keep installed files on disk", false).option("--keep-config", "Deprecated alias for --keep-files", false).option("--force", "Skip confirmation prompt", false).option("--dry-run", "Show what would be removed without making changes", false).action(async (id, opts) => {
		const cfg = loadConfig();
		const report = buildPluginStatusReport({ config: cfg });
		const extensionsDir = path.join(resolveStateDir(process.env, os.homedir), "extensions");
		const keepFiles = Boolean(opts.keepFiles || opts.keepConfig);
		if (opts.keepConfig) defaultRuntime.log(theme.warn("`--keep-config` is deprecated, use `--keep-files`."));
		const plugin = report.plugins.find((p) => p.id === id || p.name === id);
		const pluginId = plugin?.id ?? id;
		const hasEntry = pluginId in (cfg.plugins?.entries ?? {});
		const hasInstall = pluginId in (cfg.plugins?.installs ?? {});
		if (!hasEntry && !hasInstall) {
			if (plugin) defaultRuntime.error(`Plugin "${pluginId}" is not managed by plugins config/install records and cannot be uninstalled.`);
			else defaultRuntime.error(`Plugin not found: ${id}`);
			process.exit(1);
		}
		const install = cfg.plugins?.installs?.[pluginId];
		const isLinked = install?.source === "path";
		const preview = [];
		if (hasEntry) preview.push("config entry");
		if (hasInstall) preview.push("install record");
		if (cfg.plugins?.allow?.includes(pluginId)) preview.push("allowlist entry");
		if (isLinked && install?.sourcePath && cfg.plugins?.load?.paths?.includes(install.sourcePath)) preview.push("load path");
		if (cfg.plugins?.slots?.memory === pluginId) preview.push(`memory slot (will reset to "memory-core")`);
		const deleteTarget = !keepFiles ? resolveUninstallDirectoryTarget({
			pluginId,
			hasInstall,
			installRecord: install,
			extensionsDir
		}) : null;
		if (deleteTarget) preview.push(`directory: ${shortenHomePath(deleteTarget)}`);
		const pluginName = plugin?.name || pluginId;
		defaultRuntime.log(`Plugin: ${theme.command(pluginName)}${pluginName !== pluginId ? theme.muted(` (${pluginId})`) : ""}`);
		defaultRuntime.log(`Will remove: ${preview.length > 0 ? preview.join(", ") : "(nothing)"}`);
		if (opts.dryRun) {
			defaultRuntime.log(theme.muted("Dry run, no changes made."));
			return;
		}
		if (!opts.force) {
			if (!await promptYesNo(`Uninstall plugin "${pluginId}"?`)) {
				defaultRuntime.log("Cancelled.");
				return;
			}
		}
		const result = await uninstallPlugin({
			config: cfg,
			pluginId,
			deleteFiles: !keepFiles,
			extensionsDir
		});
		if (!result.ok) {
			defaultRuntime.error(result.error);
			process.exit(1);
		}
		for (const warning of result.warnings) defaultRuntime.log(theme.warn(warning));
		await writeConfigFile(result.config);
		const removed = [];
		if (result.actions.entry) removed.push("config entry");
		if (result.actions.install) removed.push("install record");
		if (result.actions.allowlist) removed.push("allowlist");
		if (result.actions.loadPath) removed.push("load path");
		if (result.actions.memorySlot) removed.push("memory slot");
		if (result.actions.directory) removed.push("directory");
		defaultRuntime.log(`Uninstalled plugin "${pluginId}". Removed: ${removed.length > 0 ? removed.join(", ") : "nothing"}.`);
		defaultRuntime.log("Restart the gateway to apply changes.");
	});
	plugins.command("install").description("Install a plugin (path, archive, npm spec, or marketplace entry)").argument("<path-or-spec-or-plugin>", "Path (.ts/.js/.zip/.tgz/.tar.gz), npm package spec, or marketplace plugin name").option("-l, --link", "Link a local path instead of copying", false).option("--pin", "Record npm installs as exact resolved <name>@<version>", false).option("--marketplace <source>", "Install a Claude marketplace plugin from a local repo/path or git/GitHub source").action(async (raw, opts) => {
		await runPluginInstallCommand({
			raw,
			opts
		});
	});
	plugins.command("update").description("Update installed plugins (npm and marketplace installs)").argument("[id]", "Plugin id (omit with --all)").option("--all", "Update all tracked plugins", false).option("--dry-run", "Show what would change without writing", false).action(async (id, opts) => {
		const cfg = loadConfig();
		const installs = cfg.plugins?.installs ?? {};
		const targets = opts.all ? Object.keys(installs) : id ? [id] : [];
		if (targets.length === 0) {
			if (opts.all) {
				defaultRuntime.log("No tracked plugins to update.");
				return;
			}
			defaultRuntime.error("Provide a plugin id or use --all.");
			process.exit(1);
		}
		const result = await updateNpmInstalledPlugins({
			config: cfg,
			pluginIds: targets,
			dryRun: opts.dryRun,
			logger: {
				info: (msg) => defaultRuntime.log(msg),
				warn: (msg) => defaultRuntime.log(theme.warn(msg))
			},
			onIntegrityDrift: async (drift) => {
				const specLabel = drift.resolvedSpec ?? drift.spec;
				defaultRuntime.log(theme.warn(`Integrity drift detected for "${drift.pluginId}" (${specLabel})\nExpected: ${drift.expectedIntegrity}\nActual:   ${drift.actualIntegrity}`));
				if (drift.dryRun) return true;
				return await promptYesNo(`Continue updating "${drift.pluginId}" with this artifact?`);
			}
		});
		for (const outcome of result.outcomes) {
			if (outcome.status === "error") {
				defaultRuntime.log(theme.error(outcome.message));
				continue;
			}
			if (outcome.status === "skipped") {
				defaultRuntime.log(theme.warn(outcome.message));
				continue;
			}
			defaultRuntime.log(outcome.message);
		}
		if (!opts.dryRun && result.changed) {
			await writeConfigFile(result.config);
			defaultRuntime.log("Restart the gateway to load plugins.");
		}
	});
	plugins.command("doctor").description("Report plugin load issues").action(() => {
		const report = buildPluginStatusReport();
		const errors = report.plugins.filter((p) => p.status === "error");
		const diags = report.diagnostics.filter((d) => d.level === "error");
		if (errors.length === 0 && diags.length === 0) {
			defaultRuntime.log("No plugin issues detected.");
			return;
		}
		const lines = [];
		if (errors.length > 0) {
			lines.push(theme.error("Plugin errors:"));
			for (const entry of errors) lines.push(`- ${entry.id}: ${entry.error ?? "failed to load"} (${entry.source})`);
		}
		if (diags.length > 0) {
			if (lines.length > 0) lines.push("");
			lines.push(theme.warn("Diagnostics:"));
			for (const diag of diags) {
				const target = diag.pluginId ? `${diag.pluginId}: ` : "";
				lines.push(`- ${target}${diag.message}`);
			}
		}
		const docs = formatDocsLink("/plugin", "docs.openclaw.ai/plugin");
		lines.push("");
		lines.push(`${theme.muted("Docs:")} ${docs}`);
		defaultRuntime.log(lines.join("\n"));
	});
	plugins.command("marketplace").description("Inspect Claude-compatible plugin marketplaces").command("list").description("List plugins published by a marketplace source").argument("<source>", "Local marketplace path/repo or git/GitHub source").option("--json", "Print JSON").action(async (source, opts) => {
		const result = await listMarketplacePlugins({
			marketplace: source,
			logger: createPluginInstallLogger()
		});
		if (!result.ok) {
			defaultRuntime.error(result.error);
			process.exit(1);
		}
		if (opts.json) {
			defaultRuntime.log(JSON.stringify({
				source: result.sourceLabel,
				name: result.manifest.name,
				version: result.manifest.version,
				plugins: result.manifest.plugins
			}, null, 2));
			return;
		}
		if (result.manifest.plugins.length === 0) {
			defaultRuntime.log(`No plugins found in marketplace ${result.sourceLabel}.`);
			return;
		}
		defaultRuntime.log(`${theme.heading("Marketplace")} ${theme.muted(result.manifest.name ?? result.sourceLabel)}`);
		for (const plugin of result.manifest.plugins) {
			const suffix = plugin.version ? theme.muted(` v${plugin.version}`) : "";
			const desc = plugin.description ? ` - ${theme.muted(plugin.description)}` : "";
			defaultRuntime.log(`${theme.command(plugin.name)}${suffix}${desc}`);
		}
	});
}
//#endregion
export { registerPluginsCli };
