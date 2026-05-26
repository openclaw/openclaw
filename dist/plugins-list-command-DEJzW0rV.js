import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { a as resolvePluginSourceRoots } from "./discovery-GEDtU7uI.js";
import { h as shortenHomeInString } from "./utils-sBTEdeml.js";
import "./path-guards-CBe_wA_B.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
import "./config-B6Oplu5W.js";
import { u as quietPluginJsonLogger } from "./plugins-command-helpers-BUsheNmo.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-ockhvL7y.js";
import path from "node:path";
//#region src/plugins/source-display.ts
function tryRelative(root, filePath) {
	if (!isPathInside(root, filePath)) return null;
	const rel = path.relative(root, filePath);
	if (!rel || rel === ".") return null;
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
//#region src/cli/plugins-list-format.ts
function formatPluginLine(plugin, verbose = false) {
	const status = plugin.status === "error" ? theme.error("error") : plugin.enabled ? theme.success("enabled") : theme.warn("disabled");
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
	if (plugin.activated !== void 0) parts.push(`  activated: ${plugin.activated ? "yes" : "no"}`);
	if (plugin.imported !== void 0) parts.push(`  imported: ${plugin.imported ? "yes" : "no"}`);
	if (plugin.explicitlyEnabled !== void 0) parts.push(`  explicitly enabled: ${plugin.explicitlyEnabled ? "yes" : "no"}`);
	if (plugin.activationSource) parts.push(`  activation source: ${plugin.activationSource}`);
	if (plugin.activationReason) parts.push(`  activation reason: ${sanitizeTerminalText(plugin.activationReason)}`);
	if (plugin.providerIds.length > 0) parts.push(`  providers: ${plugin.providerIds.join(", ")}`);
	if (plugin.activated !== void 0 || plugin.activationSource || plugin.activationReason) {
		const activationSummary = plugin.activated === false ? "inactive" : plugin.activationSource ?? (plugin.activated ? "active" : "inactive");
		parts.push(`  activation: ${activationSummary}`);
	}
	if (plugin.error) parts.push(theme.error(`  error: ${plugin.error}`));
	return parts.join("\n");
}
//#endregion
//#region src/cli/plugins-list-command.ts
async function runPluginsListCommand(opts, runtime = defaultRuntime) {
	const { buildPluginRegistrySnapshotReport } = await import("./status-Br3D4-c5.js");
	const report = buildPluginRegistrySnapshotReport({
		config: getRuntimeConfig(),
		...opts.json ? { logger: quietPluginJsonLogger } : {}
	});
	const list = opts.enabled ? report.plugins.filter((p) => p.enabled) : report.plugins;
	if (opts.json) {
		writeRuntimeJson(runtime, {
			workspaceDir: report.workspaceDir,
			registry: {
				source: report.registrySource,
				diagnostics: report.registryDiagnostics
			},
			plugins: list,
			diagnostics: report.diagnostics
		});
		return;
	}
	if (list.length === 0) {
		runtime.log(theme.muted(`No plugins found. Run ${formatCliCommand("openclaw plugins install <plugin>")} to add one, or ${formatCliCommand("openclaw plugins list --json")} to inspect raw discovery state.`));
		return;
	}
	const enabled = list.filter((p) => p.enabled).length;
	runtime.log(`${theme.heading("Plugins")} ${theme.muted(`(${enabled}/${list.length} enabled)`)}`);
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
				Status: plugin.status === "error" ? theme.error("error") : plugin.enabled ? theme.success("enabled") : theme.warn("disabled"),
				Source: sourceLine,
				Version: plugin.version ?? ""
			};
		});
		if (usedRoots.size > 0) {
			runtime.log(theme.muted("Source roots:"));
			for (const key of [
				"stock",
				"workspace",
				"global"
			]) {
				if (!usedRoots.has(key)) continue;
				const dir = sourceRoots[key];
				if (!dir) continue;
				runtime.log(`  ${theme.command(`${key}:`)} ${theme.muted(dir)}`);
			}
			runtime.log("");
		}
		runtime.log(renderTable({
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
	runtime.log(lines.join("\n").trim());
}
//#endregion
export { runPluginsListCommand };
