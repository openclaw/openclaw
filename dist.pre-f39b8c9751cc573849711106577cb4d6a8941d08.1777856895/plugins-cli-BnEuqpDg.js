import { t as formatDocsLink } from "./links-BszRQhGa.js";
import { r as theme } from "./theme-B128avno.js";
import { s as tracePluginLifecyclePhaseAsync } from "./discovery-B19Xdk1_.js";
import { n as defaultRuntime } from "./runtime-Dv8n03pi.js";
import { i as getRuntimeConfig, u as readConfigFileSnapshot } from "./io-DJ0qH7nz.js";
import { r as replaceConfigFile } from "./mutate-Dq353wbI.js";
import "./config-BxdAfCU3.js";
import { t as applyParentDefaultHelpAction } from "./parent-default-help-C2QhuOIv.js";
//#region src/cli/plugins-cli.ts
function countEnabledPlugins(plugins) {
	return plugins.filter((plugin) => plugin.enabled).length;
}
function formatRegistryState(state) {
	if (state === "fresh") return theme.success(state);
	if (state === "stale") return theme.warn(state);
	return theme.warn(state);
}
function registerPluginsCli(program) {
	const plugins = program.command("plugins").description("Manage OpenClaw plugins and extensions").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/plugins", "docs.openclaw.ai/cli/plugins")}\n`);
	plugins.command("list").description("List discovered plugins").option("--json", "Print JSON").option("--enabled", "Only show enabled plugins", false).option("--verbose", "Show detailed entries", false).action(async (opts) => {
		const { runPluginsListCommand } = await import("./plugins-list-command-CxsWDbk1.js");
		await runPluginsListCommand(opts);
	});
	plugins.command("search").description("Search ClawHub plugin packages").argument("[query...]", "Search query").option("--limit <n>", "Max results", (value) => Number.parseInt(value, 10)).option("--json", "Print JSON", false).action(async (queryParts, opts) => {
		const { runPluginsSearchCommand } = await import("./plugins-search-command-Cyx7dbsS.js");
		await runPluginsSearchCommand(queryParts, opts);
	});
	plugins.command("inspect").alias("info").description("Inspect plugin details").argument("[id]", "Plugin id").option("--all", "Inspect all plugins").option("--runtime", "Load plugin runtime for hooks/tools/diagnostics").option("--json", "Print JSON").action(async (id, opts) => {
		const { runPluginsInspectCommand } = await import("./plugins-inspect-command-ByqRHFZM.js");
		await runPluginsInspectCommand(id, opts);
	});
	plugins.command("enable").description("Enable a plugin in config").argument("<id>", "Plugin id").action(async (id) => {
		const { enablePluginInConfig } = await import("./enable-CIczRObc.js");
		const { applySlotSelectionForPlugin, logSlotWarnings } = await import("./plugins-command-helpers-DowfrDUI.js");
		const { refreshPluginRegistryAfterConfigMutation } = await import("./plugins-registry-refresh-BqpWyz-V.js");
		const snapshot = await readConfigFileSnapshot();
		const enableResult = enablePluginInConfig(snapshot.sourceConfig ?? snapshot.config, id);
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
	});
	plugins.command("disable").description("Disable a plugin in config").argument("<id>", "Plugin id").action(async (id) => {
		const { setPluginEnabledInConfig } = await import("./plugins-config-DPs6-pqL.js");
		const { refreshPluginRegistryAfterConfigMutation } = await import("./plugins-registry-refresh-BqpWyz-V.js");
		const snapshot = await readConfigFileSnapshot();
		const next = setPluginEnabledInConfig(snapshot.sourceConfig ?? snapshot.config, id, false);
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
	});
	plugins.command("uninstall").description("Uninstall a plugin").argument("<id>", "Plugin id").option("--keep-files", "Keep installed files on disk", false).option("--keep-config", "Deprecated alias for --keep-files", false).option("--force", "Skip confirmation prompt", false).option("--dry-run", "Show what would be removed without making changes", false).action(async (id, opts) => {
		const { runPluginUninstallCommand } = await import("./plugins-uninstall-command-Ci5Vxa5K.js");
		await runPluginUninstallCommand(id, opts);
	});
	plugins.command("install").description("Install a plugin or hook pack (path, archive, npm spec, git repo, clawhub:package, or marketplace entry)").argument("<path-or-spec-or-plugin>", "Path (.ts/.js/.zip/.tgz/.tar.gz), npm package spec, or marketplace plugin name").option("-l, --link", "Link a local path instead of copying", false).option("--force", "Overwrite an existing installed plugin or hook pack", false).option("--pin", "Record npm installs as exact resolved <name>@<version>", false).option("--dangerously-force-unsafe-install", "Bypass built-in dangerous-code install blocking (plugin hooks may still block)", false).option("--marketplace <source>", "Install a Claude marketplace plugin from a local repo/path or git/GitHub source").action(async (raw, opts) => {
		await tracePluginLifecyclePhaseAsync("install command", async () => {
			const { runPluginInstallCommand } = await import("./plugins-install-command-CgZcoRlh.js");
			await runPluginInstallCommand({
				raw,
				opts
			});
		}, { command: "install" });
	});
	plugins.command("update").description("Update installed plugins and tracked hook packs").argument("[id]", "Plugin or hook-pack id (omit with --all)").option("--all", "Update all tracked plugins and hook packs", false).option("--dry-run", "Show what would change without writing", false).option("--dangerously-force-unsafe-install", "Bypass built-in dangerous-code update blocking for plugins (plugin hooks may still block)", false).action(async (id, opts) => {
		const { runPluginUpdateCommand } = await import("./plugins-update-command-BkvKtoAs.js");
		await runPluginUpdateCommand({
			id,
			opts
		});
	});
	plugins.command("registry").description("Inspect or rebuild the persisted plugin registry").option("--json", "Print JSON").option("--refresh", "Rebuild the persisted registry from current plugin manifests", false).action(async (opts) => {
		const { inspectPluginRegistry, refreshPluginRegistry } = await import("./plugin-registry-DytO_kTy.js");
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
	});
	plugins.command("doctor").description("Report plugin load issues").action(async () => {
		const { buildPluginCompatibilityNotices, buildPluginDiagnosticsReport, formatPluginCompatibilityNotice } = await import("./status-CI_ZhTti.js");
		const report = buildPluginDiagnosticsReport({ effectiveOnly: true });
		const errors = report.plugins.filter((p) => p.status === "error");
		const diags = report.diagnostics.filter((d) => d.level === "error");
		const compatibility = buildPluginCompatibilityNotices({ report });
		if (errors.length === 0 && diags.length === 0 && compatibility.length === 0) {
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
		if (compatibility.length > 0) {
			if (lines.length > 0) lines.push("");
			lines.push(theme.warn("Compatibility:"));
			for (const notice of compatibility) {
				const marker = notice.severity === "warn" ? theme.warn("warn") : theme.muted("info");
				lines.push(`- ${formatPluginCompatibilityNotice(notice)} [${marker}]`);
			}
		}
		const docs = formatDocsLink("/plugin", "docs.openclaw.ai/plugin");
		lines.push("");
		lines.push(`${theme.muted("Docs:")} ${docs}`);
		defaultRuntime.log(lines.join("\n"));
	});
	plugins.command("marketplace").description("Inspect Claude-compatible plugin marketplaces").command("list").description("List plugins published by a marketplace source").argument("<source>", "Local marketplace path/repo or git/GitHub source").option("--json", "Print JSON").action(async (source, opts) => {
		const { listMarketplacePlugins } = await import("./marketplace-Cc1c44Id.js");
		const { createPluginInstallLogger } = await import("./plugins-command-helpers-DowfrDUI.js");
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
	});
	applyParentDefaultHelpAction(plugins);
}
//#endregion
export { registerPluginsCli };
