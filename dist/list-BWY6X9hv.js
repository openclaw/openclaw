import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { r as theme } from "./theme-CStEj1vt.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-DDH_zqCr.js";
import { n as isChannelVisibleInConfiguredLists } from "./channel-meta-BIgMUfKa.js";
import { n as listReadOnlyChannelPluginsForConfig } from "./read-only--nr5YM31.js";
import { r as listTrustedChannelPluginCatalogEntries } from "./trusted-catalog-DTYINkq9.js";
import { t as isCatalogChannelInstalled } from "./discovery-B1mS13Hz.js";
import { t as buildChannelAccountSnapshot } from "./status-BXLZ0qsY.js";
import { o as formatChannelAccountLabel, s as requireValidConfig } from "./shared-CzqNjJDS.js";
//#region src/commands/channels/list.ts
const colorValue = (value) => {
	if (value === "none") return theme.error(value);
	if (value === "env") return theme.accent(value);
	return theme.success(value);
};
function formatEnabled(value) {
	return value === false ? theme.error("disabled") : theme.success("enabled");
}
function formatConfigured(value) {
	return value ? theme.success("configured") : theme.warn("not configured");
}
function formatInstalled(value) {
	return value ? theme.success("installed") : theme.warn("not installed");
}
function formatTokenSource(source) {
	return `token=${colorValue(source || "none")}`;
}
function formatSource(label, source) {
	return `${label}=${colorValue(source || "none")}`;
}
function formatLinked(value) {
	return value ? theme.success("linked") : theme.warn("not linked");
}
function shouldShowConfigured(channel) {
	return isChannelVisibleInConfiguredLists(channel.meta);
}
function formatAccountLine(params) {
	const { channel, snapshot, installed } = params;
	const label = formatChannelAccountLabel({
		channel: channel.id,
		accountId: snapshot.accountId,
		name: snapshot.name,
		channelLabel: channel.meta.label ?? channel.id,
		channelStyle: theme.accent,
		accountStyle: theme.heading
	});
	const bits = [];
	bits.push(formatInstalled(installed));
	if (shouldShowConfigured(channel) && typeof snapshot.configured === "boolean") bits.push(formatConfigured(snapshot.configured));
	if (typeof snapshot.enabled === "boolean") bits.push(formatEnabled(snapshot.enabled));
	if (snapshot.linked !== void 0) bits.push(formatLinked(snapshot.linked));
	if (snapshot.tokenSource) bits.push(formatTokenSource(snapshot.tokenSource));
	if (snapshot.botTokenSource) bits.push(formatSource("bot", snapshot.botTokenSource));
	if (snapshot.appTokenSource) bits.push(formatSource("app", snapshot.appTokenSource));
	if (snapshot.baseUrl) bits.push(`base=${theme.muted(snapshot.baseUrl)}`);
	return `- ${label}: ${bits.join(", ")}`;
}
function formatCatalogOnlyLine(params) {
	const { entry, installed } = params;
	return `- ${theme.accent(entry.meta.label ?? entry.id)}: ${[
		formatInstalled(installed),
		formatConfigured(false),
		formatEnabled(false)
	].join(", ")}`;
}
async function channelsListCommand(opts, runtime = defaultRuntime) {
	const cfg = await requireValidConfig(runtime);
	if (!cfg) return;
	const showAll = opts.all === true;
	const plugins = listReadOnlyChannelPluginsForConfig(cfg, { includeSetupFallbackPlugins: true });
	const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
	const catalogEntries = listTrustedChannelPluginCatalogEntries({
		cfg,
		...workspaceDir ? { workspaceDir } : {}
	});
	const installedByChannelId = /* @__PURE__ */ new Map();
	for (const entry of catalogEntries) installedByChannelId.set(entry.id, isCatalogChannelInstalled({
		cfg,
		entry,
		...workspaceDir ? { workspaceDir } : {}
	}));
	const isInstalled = (channelId) => installedByChannelId.get(channelId) ?? true;
	const accountLines = [];
	const renderedChannelIds = /* @__PURE__ */ new Set();
	for (const plugin of plugins) {
		const accountIds = plugin.config.listAccountIds(cfg);
		if (accountIds && accountIds.length > 0) {
			renderedChannelIds.add(plugin.id);
			for (const accountId of accountIds) {
				const snapshot = await buildChannelAccountSnapshot({
					plugin,
					cfg,
					accountId
				});
				accountLines.push({
					plugin,
					snapshot,
					installed: isInstalled(plugin.id)
				});
			}
			continue;
		}
		if (!showAll) continue;
		if (!shouldShowConfigured(plugin)) continue;
		const snapshot = await buildChannelAccountSnapshot({
			plugin,
			cfg,
			accountId: "default"
		});
		renderedChannelIds.add(plugin.id);
		accountLines.push({
			plugin,
			snapshot,
			installed: isInstalled(plugin.id)
		});
	}
	const catalogOnlyLines = showAll ? catalogEntries.filter((entry) => !renderedChannelIds.has(entry.id)) : [];
	if (opts.json) {
		const chat = {};
		for (const plugin of plugins) {
			const accountIds = plugin.config.listAccountIds(cfg);
			const installed = isInstalled(plugin.id);
			if (accountIds && accountIds.length > 0) chat[plugin.id] = {
				accounts: accountIds,
				installed,
				origin: "configured"
			};
			else if (showAll && shouldShowConfigured(plugin)) chat[plugin.id] = {
				accounts: [],
				installed,
				origin: "available"
			};
		}
		if (showAll) for (const entry of catalogOnlyLines) {
			const installed = isInstalled(entry.id);
			chat[entry.id] = {
				accounts: [],
				installed,
				origin: installed ? "available" : "installable"
			};
		}
		writeRuntimeJson(runtime, { chat });
		return;
	}
	const lines = [];
	lines.push(theme.heading("Chat channels:"));
	if (accountLines.length === 0 && catalogOnlyLines.length === 0) lines.push(theme.muted(showAll ? "- no chat channels found" : "- no configured chat channels (run `openclaw channels list --all` to see installable channels)"));
	else {
		for (const line of accountLines) lines.push(formatAccountLine({
			channel: line.plugin,
			snapshot: line.snapshot,
			installed: line.installed
		}));
		for (const entry of catalogOnlyLines) lines.push(formatCatalogOnlyLine({
			entry,
			installed: isInstalled(entry.id)
		}));
	}
	runtime.log(lines.join("\n"));
	runtime.log("");
	runtime.log(theme.muted("Model provider usage moved out of `channels list` — see `openclaw status` or `openclaw models list`."));
	runtime.log(`Docs: ${formatDocsLink("/gateway/configuration", "gateway/configuration")}`);
}
//#endregion
export { channelsListCommand as t };
