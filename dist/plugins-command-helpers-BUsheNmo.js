import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { i as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { t as applyExclusiveSlotSelection } from "./slots-DT22cOei.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { a as buildPluginDiagnosticsReport } from "./status-BvY0BMpM.js";
//#region src/cli/plugins-command-helpers.ts
const quietPluginJsonLogger = {
	debug: () => void 0,
	info: () => void 0,
	warn: () => void 0,
	error: () => void 0
};
function mergeRuntimeKinds(report, runtimeReport) {
	const runtimeKinds = new Map(runtimeReport.plugins.filter((plugin) => plugin.kind).map((plugin) => [plugin.id, plugin.kind]));
	return { plugins: report.plugins.map((plugin) => {
		if (plugin.kind) return plugin;
		const runtimeKind = runtimeKinds.get(plugin.id);
		return runtimeKind ? {
			...plugin,
			kind: runtimeKind
		} : plugin;
	}) };
}
function loadRuntimeKindReportForPlugins(config, pluginIds) {
	return buildPluginDiagnosticsReport({
		config,
		onlyPluginIds: [...pluginIds]
	});
}
function buildSlotSelectionRegistry(config, pluginId) {
	return { plugins: loadPluginMetadataSnapshot({
		config,
		env: process.env
	}).plugins.filter((plugin) => plugin.id === pluginId).map((plugin) => ({
		id: plugin.id,
		kind: plugin.kind
	})) };
}
function resolveFileNpmSpecToLocalPath(raw) {
	const trimmed = raw.trim();
	if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("file:")) return null;
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
function applySlotSelectionForPlugin(config, pluginId) {
	const report = buildSlotSelectionRegistry(config, pluginId);
	const plugin = report.plugins.find((entry) => entry.id === pluginId);
	if (!plugin) return {
		config,
		warnings: []
	};
	if (!plugin.kind) {
		const runtimeReport = loadRuntimeKindReportForPlugins(config, [plugin.id]);
		const runtimePlugin = runtimeReport.plugins.find((entry) => entry.id === plugin.id);
		if (runtimePlugin?.kind) {
			const result = applyExclusiveSlotSelection({
				config,
				selectedId: runtimePlugin.id,
				selectedKind: runtimePlugin.kind,
				registry: mergeRuntimeKinds(report, runtimeReport)
			});
			return {
				config: result.config,
				warnings: result.warnings
			};
		}
	}
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
function createPluginInstallLogger(runtime = defaultRuntime) {
	return {
		info: (msg) => runtime.log(msg),
		warn: (msg) => runtime.log(theme.warn(msg))
	};
}
function createHookPackInstallLogger(runtime = defaultRuntime) {
	return {
		info: (msg) => runtime.log(msg),
		warn: (msg) => runtime.log(theme.warn(msg))
	};
}
function enableInternalHookEntries(config, hookNames) {
	const entries = { ...config.hooks?.internal?.entries };
	for (const hookName of hookNames) entries[hookName] = {
		...entries[hookName],
		enabled: true
	};
	return {
		...config,
		hooks: {
			...config.hooks,
			internal: {
				...config.hooks?.internal,
				enabled: true,
				entries
			}
		}
	};
}
function formatPluginInstallWithHookFallbackError(pluginError, hookError) {
	const formattedPluginError = formatPluginInstallAttemptError(pluginError);
	const formattedHookError = formatPluginInstallAttemptError(hookError);
	if (/plugin already exists: .+ \(delete it first\)/.test(pluginError)) return `${formattedPluginError}\nUse \`openclaw plugins update <id-or-npm-spec>\` to upgrade the tracked plugin, or rerun install with \`--force\` to replace it.`;
	if (pluginError.startsWith("Invalid extensions directory:") || pluginError === "Invalid path: must stay within extensions directory") return formattedPluginError;
	return `${formattedPluginError}\nAlso not a valid hook pack: ${formattedHookError}`;
}
const MISSING_GIT_FOR_NPM_DEPENDENCY_HINT = "Git is required because one of this plugin's npm dependencies is fetched from a git URL, but `git` was not found on PATH. Install Git and rerun the install. On Windows, use `winget install --id Git.Git -e` or add a portable Git `bin` directory to PATH.";
function formatPluginInstallAttemptError(error) {
	if (!isMissingGitForNpmDependencyError(error)) return error;
	if (error.includes(MISSING_GIT_FOR_NPM_DEPENDENCY_HINT)) return error;
	return `${error}\n\n${MISSING_GIT_FOR_NPM_DEPENDENCY_HINT}`;
}
function isMissingGitForNpmDependencyError(error) {
	const normalized = normalizeLowercaseStringOrEmpty(error);
	return /\bspawn\s+git\b/u.test(normalized) && /\benoent\b/u.test(normalized);
}
function logHookPackRestartHint(runtime = defaultRuntime) {
	runtime.log("Restart the gateway to load hooks.");
}
function logSlotWarnings(warnings, runtime = defaultRuntime) {
	if (warnings.length === 0) return;
	for (const warning of warnings) runtime.log(theme.warn(warning));
}
function parseNpmPrefixSpec(raw) {
	const trimmed = raw.trim();
	if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("npm:")) return null;
	return trimmed.slice(4).trim();
}
function parseNpmPackPrefixPath(raw) {
	const trimmed = raw.trim();
	if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("npm-pack:")) return null;
	return trimmed.slice(9).trim();
}
//#endregion
export { formatPluginInstallWithHookFallbackError as a, parseNpmPackPrefixPath as c, resolveFileNpmSpecToLocalPath as d, enableInternalHookEntries as i, parseNpmPrefixSpec as l, createHookPackInstallLogger as n, logHookPackRestartHint as o, createPluginInstallLogger as r, logSlotWarnings as s, applySlotSelectionForPlugin as t, quietPluginJsonLogger as u };
