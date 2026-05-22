import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { r as theme } from "./theme-CStEj1vt.js";
import { s as tracePluginLifecyclePhaseAsync } from "./discovery-BYD6b0rQ.js";
import { h as shortenHomeInString } from "./utils-CpmNtyoq.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { i as getRuntimeConfig, u as readConfigFileSnapshot } from "./io-ByDvK3jv.js";
import { n as assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard-tBrn0obI.js";
import { i as replaceConfigFile } from "./mutate-CM7Vq-cJ.js";
import "./config-CIM_gEq1.js";
import { a as formatMissingPluginMessage } from "./error-format-C27-4rQ7.js";
//#region src/cli/plugins-cli.runtime.ts
function countEnabledPlugins(plugins) {
	return plugins.filter((plugin) => plugin.enabled).length;
}
function formatRegistryState(state) {
	if (state === "fresh") return theme.success(state);
	if (state === "stale") return theme.warn(state);
	return theme.warn(state);
}
function reportMissingPlugin(id) {
	defaultRuntime.error(formatMissingPluginMessage({
		id,
		includeSearch: true
	}));
	return defaultRuntime.exit(1);
}
function matchesPluginId(plugin, id) {
	return plugin.id === id;
}
function isConfigSelectedShadowDiagnostic(entry) {
	return entry.level === "warn" && typeof entry.message === "string" && entry.message.includes("duplicate plugin id resolved by explicit config-selected plugin");
}
function isErroredConfigSelectedShadowDiagnostic(params) {
	if (!params.entry.pluginId || !isConfigSelectedShadowDiagnostic(params.entry)) return false;
	return params.plugins.some((plugin) => plugin.id === params.entry.pluginId && plugin.origin === "config" && plugin.status === "error");
}
async function runPluginsEnableCommand(id) {
	assertConfigWriteAllowedInCurrentMode();
	const { enablePluginInConfig } = await import("./enable-DmIcAGaG.js");
	const { normalizePluginId } = await import("./config-state-CDowxzeJ.js");
	const { buildPluginRegistrySnapshotReport } = await import("./status-BZZgjJ6H.js");
	const { applySlotSelectionForPlugin, logSlotWarnings } = await import("./plugins-command-helpers-BDDMqZBM.js");
	const { refreshPluginRegistryAfterConfigMutation } = await import("./plugins-registry-refresh-D_3VPerH.js");
	const snapshot = await readConfigFileSnapshot();
	const cfg = snapshot.sourceConfig ?? snapshot.config;
	const report = buildPluginRegistrySnapshotReport({ config: cfg });
	id = normalizePluginId(id);
	if (!report.plugins.some((plugin) => matchesPluginId(plugin, id))) return reportMissingPlugin(id);
	const enableResult = enablePluginInConfig(cfg, id, { updateChannelConfig: false });
	let next = enableResult.config;
	const slotResult = applySlotSelectionForPlugin(next, id);
	next = slotResult.config;
	await replaceConfigFile({
		nextConfig: next,
		...snapshot.hash !== void 0 ? { baseHash: snapshot.hash } : {}
	});
	await refreshPluginRegistryAfterConfigMutation({
		config: next,
		reason: "policy-changed",
		policyPluginIds: [enableResult.pluginId],
		logger: { warn: (message) => defaultRuntime.log(theme.warn(message)) }
	});
	logSlotWarnings(slotResult.warnings);
	if (enableResult.enabled) {
		defaultRuntime.log(`Enabled plugin "${id}". Restart the gateway to apply.`);
		return;
	}
	defaultRuntime.log(theme.warn(`Plugin "${id}" could not be enabled (${enableResult.reason ?? "unknown reason"}).`));
}
async function runPluginsDisableCommand(id) {
	assertConfigWriteAllowedInCurrentMode();
	const { normalizePluginId } = await import("./config-state-CDowxzeJ.js");
	const { buildPluginRegistrySnapshotReport } = await import("./status-BZZgjJ6H.js");
	const { setPluginEnabledInConfig } = await import("./plugins-config-BoHU5uDD.js");
	const { refreshPluginRegistryAfterConfigMutation } = await import("./plugins-registry-refresh-D_3VPerH.js");
	const snapshot = await readConfigFileSnapshot();
	const cfg = snapshot.sourceConfig ?? snapshot.config;
	const report = buildPluginRegistrySnapshotReport({ config: cfg });
	id = normalizePluginId(id);
	if (!report.plugins.some((plugin) => matchesPluginId(plugin, id))) return reportMissingPlugin(id);
	const next = setPluginEnabledInConfig(cfg, id, false, { updateChannelConfig: false });
	await replaceConfigFile({
		nextConfig: next,
		...snapshot.hash !== void 0 ? { baseHash: snapshot.hash } : {}
	});
	await refreshPluginRegistryAfterConfigMutation({
		config: next,
		reason: "policy-changed",
		policyPluginIds: [id],
		logger: { warn: (message) => defaultRuntime.log(theme.warn(message)) }
	});
	defaultRuntime.log(`Disabled plugin "${id}". Restart the gateway to apply.`);
}
async function runPluginsInstallAction(raw, opts) {
	await tracePluginLifecyclePhaseAsync("install command", async () => {
		const { runPluginInstallCommand } = await import("./plugins-install-command-BtFgEDTz.js");
		await runPluginInstallCommand({
			raw,
			opts
		});
	}, { command: "install" });
}
async function runPluginsRegistryCommand(opts) {
	const { inspectPluginRegistry, refreshPluginRegistry } = await import("./plugin-registry-DnUtDL2k.js");
	const cfg = getRuntimeConfig();
	if (opts.refresh) {
		const index = await refreshPluginRegistry({
			config: cfg,
			reason: "manual"
		});
		if (opts.json) {
			defaultRuntime.writeJson({
				refreshed: true,
				registry: index
			});
			return;
		}
		const total = index.plugins.length;
		const enabled = countEnabledPlugins(index.plugins);
		defaultRuntime.log(`Plugin registry refreshed: ${enabled}/${total} enabled plugins indexed.`);
		return;
	}
	const inspection = await inspectPluginRegistry({ config: cfg });
	if (opts.json) {
		defaultRuntime.writeJson({
			state: inspection.state,
			refreshReasons: inspection.refreshReasons,
			persisted: inspection.persisted,
			current: inspection.current
		});
		return;
	}
	const currentTotal = inspection.current.plugins.length;
	const currentEnabled = countEnabledPlugins(inspection.current.plugins);
	const persistedTotal = inspection.persisted?.plugins.length ?? 0;
	const persistedEnabled = inspection.persisted ? countEnabledPlugins(inspection.persisted.plugins) : 0;
	const lines = [
		`${theme.muted("State:")} ${formatRegistryState(inspection.state)}`,
		`${theme.muted("Current:")} ${currentEnabled}/${currentTotal} enabled plugins`,
		`${theme.muted("Persisted:")} ${persistedEnabled}/${persistedTotal} enabled plugins`
	];
	if (inspection.refreshReasons.length > 0) {
		lines.push(`${theme.muted("Refresh reasons:")} ${inspection.refreshReasons.join(", ")}`);
		lines.push(`${theme.muted("Repair:")} ${theme.command("openclaw plugins registry --refresh")}`);
	}
	defaultRuntime.log(lines.join("\n"));
}
async function runPluginsDoctorCommand() {
	const { buildPluginCompatibilityNotices, buildPluginDiagnosticsReport, formatPluginCompatibilityNotice } = await import("./status-BZZgjJ6H.js");
	const { collectStalePluginConfigWarnings, isStalePluginAutoRepairBlocked, scanStalePluginConfig } = await import("./stale-plugin-config-C3YjJxld.js");
	const cfg = getRuntimeConfig();
	const configSnapshot = await readConfigFileSnapshot().catch(() => null);
	const sourceCfg = configSnapshot?.sourceConfig ?? configSnapshot?.config ?? cfg;
	const report = buildPluginDiagnosticsReport({
		config: cfg,
		effectiveOnly: true
	});
	const errors = report.plugins.filter((p) => p.status === "error");
	const diags = report.diagnostics.filter((d) => d.level === "error");
	const shadowed = report.diagnostics.filter((entry) => isErroredConfigSelectedShadowDiagnostic({
		entry,
		plugins: report.plugins
	}));
	const compatibility = buildPluginCompatibilityNotices({ report });
	const stalePluginConfigWarnings = collectStalePluginConfigWarnings({
		hits: scanStalePluginConfig(sourceCfg ?? cfg, process.env),
		doctorFixCommand: "openclaw doctor --fix",
		autoRepairBlocked: isStalePluginAutoRepairBlocked(sourceCfg ?? cfg, process.env)
	});
	const hasInstallTreeIssues = errors.length > 0 || diags.length > 0 || shadowed.length > 0 || compatibility.length > 0;
	if (!hasInstallTreeIssues && stalePluginConfigWarnings.length === 0) {
		defaultRuntime.log("No plugin issues detected.");
		return;
	}
	const lines = [];
	if (errors.length > 0) {
		lines.push(theme.error("Plugin errors:"));
		for (const entry of errors) {
			const phase = entry.failurePhase ? ` [${entry.failurePhase}]` : "";
			lines.push(`- ${entry.id}${phase}: ${entry.error ?? "failed to load"} (${entry.source})`);
		}
	}
	if (diags.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(theme.warn("Diagnostics:"));
		for (const diag of diags) {
			const target = diag.pluginId ? `${diag.pluginId}: ` : "";
			lines.push(`- ${target}${diag.message}`);
		}
	}
	if (shadowed.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(theme.warn("Plugin source shadowing:"));
		for (const diag of shadowed) {
			const active = report.plugins.find((plugin) => plugin.id === diag.pluginId);
			const target = diag.pluginId ? `${diag.pluginId}: ` : "";
			lines.push(`- ${target}${diag.message}`);
			if (active) {
				lines.push(`  active: ${shortenHomeInString(active.source)} (${active.origin})`);
				if (active.status === "error") lines.push(`  active status: error${active.error ? `: ${active.error}` : ""}`);
			}
			if (diag.source) lines.push(`  shadowed: ${shortenHomeInString(diag.source)}`);
			lines.push("  repair:");
			lines.push("    openclaw plugins inspect " + (diag.pluginId ?? "<plugin-id>"));
			lines.push("    edit or remove the config-selected plugin source");
			lines.push("    openclaw plugins registry --refresh");
			lines.push("    openclaw gateway restart --force");
		}
	}
	if (compatibility.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(theme.warn("Compatibility:"));
		for (const notice of compatibility) {
			const marker = notice.severity === "warn" ? theme.warn("warn") : theme.muted("info");
			lines.push(`- ${formatPluginCompatibilityNotice(notice)} [${marker}]`);
		}
	}
	if (stalePluginConfigWarnings.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(theme.warn("Plugin configuration:"));
		lines.push(...stalePluginConfigWarnings);
	}
	if (!hasInstallTreeIssues && stalePluginConfigWarnings.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("No plugin install-tree issues detected; configuration warnings remain.");
	}
	const docs = formatDocsLink("/plugin", "docs.openclaw.ai/plugin");
	lines.push("");
	lines.push(`${theme.muted("Docs:")} ${docs}`);
	defaultRuntime.log(lines.join("\n"));
}
async function runPluginMarketplaceListCommand(source, opts) {
	const { listMarketplacePlugins } = await import("./marketplace-CRnhBWBm.js");
	const { createPluginInstallLogger } = await import("./plugins-command-helpers-BDDMqZBM.js");
	const result = await listMarketplacePlugins({
		marketplace: source,
		logger: createPluginInstallLogger()
	});
	if (!result.ok) {
		defaultRuntime.error(result.error);
		return defaultRuntime.exit(1);
	}
	if (opts.json) {
		defaultRuntime.writeJson({
			source: result.sourceLabel,
			name: result.manifest.name,
			version: result.manifest.version,
			plugins: result.manifest.plugins
		});
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
}
//#endregion
export { runPluginMarketplaceListCommand, runPluginsDisableCommand, runPluginsDoctorCommand, runPluginsEnableCommand, runPluginsInstallAction, runPluginsRegistryCommand };
