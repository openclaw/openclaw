import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { a as resolveDefaultPluginNpmDir, i as resolveDefaultPluginGitDir, o as resolvePluginInstallDir } from "./install-paths-B32RY-Gz.js";
import { n as defaultSlotIdForKey } from "./slots-DT22cOei.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { n as createSafeNpmInstallEnv } from "./safe-package-install-CZ0VYBja.js";
import { c as syncManagedNpmRootPeerDependencies, r as readOpenClawManagedNpmRootOverrides } from "./npm-managed-root-rRx0glyx.js";
import { i as relinkOpenClawPeerDependenciesInManagedNpmRoot } from "./plugin-peer-link-Ckh-dj0J.js";
import { realpathSync } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
//#region src/plugins/uninstall.ts
const UNINSTALL_ACTION_LABELS = {
	entry: "config entry",
	install: "install record",
	allowlist: "allowlist entry",
	denylist: "denylist entry",
	loadPath: "load path",
	memorySlot: "memory slot",
	contextEngineSlot: "context engine slot",
	channelConfig: "channel config",
	directory: "directory"
};
const UNINSTALL_ACTION_ORDER = [
	"entry",
	"install",
	"allowlist",
	"denylist",
	"loadPath",
	"memorySlot",
	"contextEngineSlot",
	"channelConfig",
	"directory"
];
function createEmptyUninstallActions(overrides = {}) {
	return {
		entry: false,
		install: false,
		allowlist: false,
		denylist: false,
		loadPath: false,
		memorySlot: false,
		contextEngineSlot: false,
		channelConfig: false,
		directory: false,
		...overrides
	};
}
function createEmptyConfigUninstallActions() {
	const { directory: _directory, ...actions } = createEmptyUninstallActions();
	return actions;
}
function formatUninstallActionLabels(actions) {
	return UNINSTALL_ACTION_ORDER.flatMap((key) => actions[key] ? [UNINSTALL_ACTION_LABELS[key]] : []);
}
function hasUninstallAction(actions) {
	return Object.values(actions).some(Boolean);
}
function formatUninstallSlotResetPreview(slotKey) {
	return `${UNINSTALL_ACTION_LABELS[slotKey === "memory" ? "memorySlot" : "contextEngineSlot"]} (will reset to "${defaultSlotIdForKey(slotKey)}")`;
}
function resolveUninstallDirectoryTarget(params) {
	if (!params.hasInstall) return null;
	if (isLinkedPathInstallRecord(params.installRecord)) return null;
	const npmManagedInstall = resolveNpmManagedInstall({
		installRecord: params.installRecord,
		extensionsDir: params.extensionsDir
	});
	if (npmManagedInstall) return npmManagedInstall.installPath;
	const gitManagedInstall = resolveGitManagedInstall({
		installRecord: params.installRecord,
		extensionsDir: params.extensionsDir
	});
	if (gitManagedInstall) return gitManagedInstall.installPath;
	let defaultPath;
	try {
		defaultPath = resolvePluginInstallDir(params.pluginId, params.extensionsDir);
	} catch {
		return null;
	}
	const configuredPath = params.installRecord?.installPath;
	if (!configuredPath) return defaultPath;
	if (path.resolve(configuredPath) === path.resolve(defaultPath)) return configuredPath;
	if (params.extensionsDir && isPathInsideOrEqual(params.extensionsDir, configuredPath)) return configuredPath;
	const recordedManagedPath = resolveRecordedManagedInstallPath({
		pluginId: params.pluginId,
		installPath: configuredPath
	});
	if (recordedManagedPath) return recordedManagedPath;
	return defaultPath;
}
function resolveNpmManagedInstall(params) {
	const installPath = params.installRecord?.installPath?.trim();
	if (params.installRecord?.source !== "npm" || !installPath) return null;
	const npmRoots = /* @__PURE__ */ new Set();
	if (params.extensionsDir) npmRoots.add(path.join(path.dirname(path.resolve(params.extensionsDir)), "npm"));
	npmRoots.add(resolveDefaultPluginNpmDir());
	for (const npmRoot of npmRoots) {
		const nodeModulesRoot = path.join(npmRoot, "node_modules");
		if (isPathInsideOrEqual(nodeModulesRoot, installPath) && resolveComparablePath(nodeModulesRoot) !== resolveComparablePath(installPath)) {
			const packageName = resolveNpmPackageNameFromInstallPath({
				installPath,
				nodeModulesRoot
			});
			return packageName ? {
				installPath,
				npmRoot,
				packageName
			} : null;
		}
	}
	return null;
}
function resolveNpmPackageNameFromInstallPath(params) {
	const relativePath = path.relative(path.resolve(params.nodeModulesRoot), path.resolve(params.installPath));
	if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
	const segments = relativePath.split(path.sep).filter(Boolean);
	if (segments.length < 1) return null;
	if (segments[0]?.startsWith("@")) return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
	return segments[0] ?? null;
}
function resolveGitManagedInstall(params) {
	const installPath = params.installRecord?.installPath?.trim();
	if (params.installRecord?.source !== "git" || !installPath) return null;
	const gitRoots = /* @__PURE__ */ new Set();
	if (params.extensionsDir) gitRoots.add(path.join(path.dirname(path.resolve(params.extensionsDir)), "git"));
	gitRoots.add(resolveDefaultPluginGitDir());
	for (const gitRoot of gitRoots) if (isPathInsideOrEqual(gitRoot, installPath) && resolveComparablePath(gitRoot) !== resolveComparablePath(installPath)) return {
		installPath,
		parentDir: path.dirname(installPath)
	};
	return null;
}
function resolveRecordedManagedInstallPath(params) {
	const resolvedInstallPath = path.resolve(params.installPath);
	const recordedExtensionsDir = path.dirname(resolvedInstallPath);
	if (path.basename(recordedExtensionsDir) !== "extensions") return null;
	try {
		return path.resolve(resolvePluginInstallDir(params.pluginId, recordedExtensionsDir)) === resolvedInstallPath ? params.installPath : null;
	} catch {
		return null;
	}
}
function isLinkedPathInstallRecord(installRecord) {
	if (installRecord?.source !== "path") return false;
	if (!installRecord.sourcePath || !installRecord.installPath) return true;
	return resolveComparablePath(installRecord.sourcePath) === resolveComparablePath(installRecord.installPath);
}
const SHARED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
/**
* Resolve the channel config keys owned by a plugin during uninstall.
* - `channelIds === undefined`: fall back to the plugin id for backward compatibility.
* - `channelIds === []`: explicit "owns no channels" signal; remove nothing.
*/
function resolveUninstallChannelConfigKeys(pluginId, opts) {
	const rawKeys = opts?.channelIds ?? [pluginId];
	const seen = /* @__PURE__ */ new Set();
	const keys = [];
	for (const key of rawKeys) {
		if (SHARED_CHANNEL_CONFIG_KEYS.has(key) || seen.has(key)) continue;
		seen.add(key);
		keys.push(key);
	}
	return keys;
}
function loadPathMatchesInstallSourcePath(loadPath, sourcePath) {
	if (loadPath === sourcePath) return true;
	return resolveComparablePath(loadPath) === resolveComparablePath(sourcePath);
}
function resolveComparablePath(value) {
	const resolved = path.resolve(value);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}
function isPathInsideOrEqual(parent, child) {
	const relative = path.relative(resolveComparablePath(parent), resolveComparablePath(child));
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
/**
* Remove plugin references from config (pure config mutation).
* Returns a new config with the plugin removed from entries, installs, allow, load.paths, slots,
* and owned channel config.
*/
function removePluginFromConfig(cfg, pluginId, opts) {
	const actions = createEmptyConfigUninstallActions();
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
	let deny = pluginsConfig.deny;
	if (Array.isArray(deny) && deny.includes(pluginId)) {
		deny = deny.filter((id) => id !== pluginId);
		if (deny.length === 0) deny = void 0;
		actions.denylist = true;
	}
	let load = pluginsConfig.load;
	if (installRecord?.source === "path" && installRecord.sourcePath) {
		const sourcePath = installRecord.sourcePath;
		const loadPaths = load?.paths;
		if (Array.isArray(loadPaths) && loadPaths.some((p) => loadPathMatchesInstallSourcePath(p, sourcePath))) {
			const nextLoadPaths = loadPaths.filter((p) => !loadPathMatchesInstallSourcePath(p, sourcePath));
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
	if (slots?.contextEngine === pluginId) {
		slots = {
			...slots,
			contextEngine: defaultSlotIdForKey("contextEngine")
		};
		actions.contextEngineSlot = true;
	}
	if (slots && Object.keys(slots).length === 0) slots = void 0;
	const cleanedPlugins = {
		...pluginsConfig,
		entries,
		installs,
		allow,
		deny,
		load,
		slots
	};
	if (cleanedPlugins.entries === void 0) delete cleanedPlugins.entries;
	if (cleanedPlugins.installs === void 0) delete cleanedPlugins.installs;
	if (cleanedPlugins.allow === void 0) delete cleanedPlugins.allow;
	if (cleanedPlugins.deny === void 0) delete cleanedPlugins.deny;
	if (cleanedPlugins.load === void 0) delete cleanedPlugins.load;
	if (cleanedPlugins.slots === void 0) delete cleanedPlugins.slots;
	const hasInstallRecord = Object.hasOwn(cfg.plugins?.installs ?? {}, pluginId);
	let channels = cfg.channels;
	if (hasInstallRecord && channels) for (const key of resolveUninstallChannelConfigKeys(pluginId, opts)) {
		if (!Object.hasOwn(channels, key)) continue;
		const { [key]: _removed, ...rest } = channels;
		channels = Object.keys(rest).length > 0 ? rest : void 0;
		actions.channelConfig = true;
		if (!channels) break;
	}
	return {
		config: {
			...cfg,
			plugins: Object.keys(cleanedPlugins).length > 0 ? cleanedPlugins : void 0,
			channels
		},
		actions
	};
}
/**
* Plan a plugin uninstall by removing it from config and resolving a safe file-removal target.
* Linked path plugins never have their source directory deleted. Copied path installs still remove
* their managed install directory.
*/
function planPluginUninstall(params) {
	const { config, pluginId, channelIds, deleteFiles = true, extensionsDir } = params;
	const hasEntry = pluginId in (config.plugins?.entries ?? {});
	const hasInstall = pluginId in (config.plugins?.installs ?? {});
	const installRecord = config.plugins?.installs?.[pluginId];
	const isLinked = isLinkedPathInstallRecord(installRecord);
	const { config: newConfig, actions: configActions } = removePluginFromConfig(config, pluginId, { channelIds });
	if (!hasEntry && !hasInstall && !hasUninstallAction(configActions)) return {
		ok: false,
		error: `Plugin not found: ${pluginId}`
	};
	const actions = {
		...configActions,
		directory: false
	};
	const npmManagedInstall = deleteFiles && !isLinked ? resolveNpmManagedInstall({
		installRecord,
		extensionsDir
	}) : null;
	const gitManagedInstall = deleteFiles && !isLinked ? resolveGitManagedInstall({
		installRecord,
		extensionsDir
	}) : null;
	const deleteTarget = deleteFiles && !isLinked ? resolveUninstallDirectoryTarget({
		pluginId,
		hasInstall,
		installRecord,
		extensionsDir
	}) : null;
	return {
		ok: true,
		config: newConfig,
		pluginId,
		actions,
		directoryRemoval: deleteTarget ? {
			target: deleteTarget,
			...npmManagedInstall ? { cleanup: {
				kind: "npm",
				npmRoot: npmManagedInstall.npmRoot,
				packageName: npmManagedInstall.packageName
			} } : gitManagedInstall && deleteTarget === gitManagedInstall.installPath ? { cleanup: {
				kind: "git",
				parentDir: gitManagedInstall.parentDir
			} } : {}
		} : null
	};
}
async function applyPluginUninstallDirectoryRemoval(removal) {
	if (!removal) return {
		directoryRemoved: false,
		warnings: []
	};
	const existed = await fs$1.access(removal.target).then(() => true).catch(() => false) ?? false;
	const warnings = [];
	if (!existed && removal.cleanup?.kind !== "npm") return {
		directoryRemoved: false,
		warnings
	};
	const npmCleanupManifestExists = removal.cleanup?.kind === "npm" ? await fs$1.access(path.join(removal.cleanup.npmRoot, "package.json")).then(() => true).catch(() => false) : false;
	if (!existed && removal.cleanup?.kind === "npm" && !npmCleanupManifestExists) return {
		directoryRemoved: false,
		warnings
	};
	if (removal.cleanup?.kind === "npm" && npmCleanupManifestExists) {
		const uninstall = await runCommandWithTimeout([
			"npm",
			"uninstall",
			"--loglevel=error",
			"--legacy-peer-deps",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			removal.cleanup.packageName
		], {
			cwd: removal.cleanup.npmRoot,
			timeoutMs: 3e5,
			env: createSafeNpmInstallEnv(process.env, {
				legacyPeerDeps: true,
				npmConfigCwd: removal.cleanup.npmRoot,
				packageLock: true,
				quiet: true
			})
		});
		if (uninstall.code !== 0) warnings.push(`Failed to prune npm dependencies for plugin package ${removal.cleanup.packageName}: ${uninstall.stderr.trim() || uninstall.stdout.trim() || `npm exited with code ${uninstall.code}`}`);
		try {
			const managedOverrides = await readOpenClawManagedNpmRootOverrides();
			if (await syncManagedNpmRootPeerDependencies({
				npmRoot: removal.cleanup.npmRoot,
				managedOverrides
			})) {
				const cleanup = await runCommandWithTimeout([
					"npm",
					"install",
					"--omit=dev",
					"--omit=peer",
					"--loglevel=error",
					"--legacy-peer-deps",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund"
				], {
					cwd: removal.cleanup.npmRoot,
					timeoutMs: 3e5,
					env: createSafeNpmInstallEnv(process.env, {
						legacyPeerDeps: true,
						npmConfigCwd: removal.cleanup.npmRoot,
						packageLock: true,
						quiet: true
					})
				});
				if (cleanup.code !== 0) warnings.push(`Failed to prune managed peer dependencies after uninstalling ${removal.cleanup.packageName}: ${cleanup.stderr.trim() || cleanup.stdout.trim() || `npm exited with code ${cleanup.code}`}`);
			}
		} catch (error) {
			warnings.push(`Failed to sync managed peer dependencies after uninstalling ${removal.cleanup.packageName}: ${formatErrorMessage(error)}`);
		}
		try {
			await relinkOpenClawPeerDependenciesInManagedNpmRoot({
				npmRoot: removal.cleanup.npmRoot,
				logger: { warn: (message) => warnings.push(message) }
			});
		} catch (error) {
			warnings.push(`Failed to repair managed npm peer links after uninstalling ${removal.cleanup.packageName}: ${formatErrorMessage(error)}`);
		}
	}
	try {
		await fs$1.rm(removal.target, {
			recursive: true,
			force: true
		});
		if (removal.cleanup?.kind === "git") try {
			await fs$1.rmdir(removal.cleanup.parentDir);
		} catch (error) {
			const code = error.code;
			if (code !== "ENOENT" && code !== "ENOTEMPTY") warnings.push(`Failed to remove empty git plugin install parent ${removal.cleanup.parentDir}: ${formatErrorMessage(error)}`);
		}
		return {
			directoryRemoved: existed,
			warnings
		};
	} catch (error) {
		return {
			directoryRemoved: false,
			warnings: [...warnings, `Failed to remove plugin directory ${removal.target}: ${formatErrorMessage(error)}`]
		};
	}
}
//#endregion
export { formatUninstallSlotResetPreview as a, resolveUninstallChannelConfigKeys as c, formatUninstallActionLabels as i, resolveUninstallDirectoryTarget as l, applyPluginUninstallDirectoryRemoval as n, planPluginUninstall as o, createEmptyUninstallActions as r, removePluginFromConfig as s, UNINSTALL_ACTION_LABELS as t };
