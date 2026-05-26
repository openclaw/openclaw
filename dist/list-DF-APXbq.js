import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { n as isChannelVisibleInConfiguredLists } from "./channel-meta-COEgfCjE.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { t as resolveMissingOfficialExternalChannelPluginRepairHint } from "./official-external-plugin-repair-hints-CS7WhtMH.js";
import { n as listReadOnlyChannelPluginsForConfig } from "./read-only-CHBMrkWp.js";
import { r as listTrustedChannelPluginCatalogEntries } from "./trusted-catalog-ax5bRVns.js";
import { t as isCatalogChannelInstalled } from "./discovery-nftDBpqu.js";
import { o as formatChannelAccountLabel, s as requireValidConfig } from "./shared-DxOkFLYA.js";
import { t as buildChannelAccountSnapshot } from "./status-DQVTMawq.js";
import { a as resolveChannelAccountStatusRows, i as normalizeRuntimeChannelAccountSnapshots } from "./read-model-CKhbU6QB.js";
//#region src/commands/channels/list.ts
async function readGatewayChannelStatus() {
	try {
		return await callGateway({
			method: "channels.status",
			params: {
				probe: false,
				timeoutMs: 5e3
			},
			timeoutMs: 5e3
		});
	} catch {
		return null;
	}
}
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
function formatCredentialSource(source, status) {
	const value = source || "none";
	if (status === "configured_unavailable" && value !== "none") return theme.warn(`${value}-unavailable`);
	return colorValue(value);
}
function formatTokenSource(source, status) {
	return `token=${formatCredentialSource(source, status)}`;
}
function formatSource(label, source, status) {
	return `${label}=${formatCredentialSource(source, status)}`;
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
	if (snapshot.tokenSource) bits.push(formatTokenSource(snapshot.tokenSource, snapshot.tokenStatus));
	if (snapshot.botTokenSource) bits.push(formatSource("bot", snapshot.botTokenSource, snapshot.botTokenStatus));
	if (snapshot.appTokenSource) bits.push(formatSource("app", snapshot.appTokenSource, snapshot.appTokenStatus));
	if (snapshot.baseUrl) bits.push(`base=${theme.muted(snapshot.baseUrl)}`);
	return `- ${label}: ${bits.join(", ")}`;
}
function formatCatalogOnlyLine(params) {
	const { entry, installed, configured, repairHint } = params;
	const channelText = theme.accent(entry.meta.label ?? entry.id);
	const bits = [
		formatInstalled(installed),
		formatConfigured(configured),
		formatEnabled(false)
	];
	if (repairHint) bits.push(repairHint);
	return `- ${channelText}: ${bits.join(", ")}`;
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
	const runtimeAccountsByChannel = opts.json === true ? /* @__PURE__ */ new Map() : normalizeRuntimeChannelAccountSnapshots(await readGatewayChannelStatus());
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
			const rows = await resolveChannelAccountStatusRows({
				localAccountIds: accountIds,
				runtimeAccounts: runtimeAccountsByChannel.get(plugin.id) ?? [],
				resolveLocalSnapshot: (accountId) => buildChannelAccountSnapshot({
					plugin,
					cfg,
					accountId
				})
			});
			for (const row of rows) accountLines.push({
				plugin,
				snapshot: row.snapshot,
				installed: isInstalled(plugin.id)
			});
			continue;
		}
		if (!showAll) continue;
		if (!shouldShowConfigured(plugin)) continue;
		const snapshot = await buildChannelAccountSnapshot({
			plugin,
			cfg,
			accountId: "default"
		});
		const runtimeSnapshot = runtimeAccountsByChannel.get(plugin.id)?.find((account) => account.accountId === "default");
		renderedChannelIds.add(plugin.id);
		accountLines.push({
			plugin,
			snapshot: runtimeSnapshot ?? snapshot,
			installed: isInstalled(plugin.id)
		});
	}
	const catalogOnlyLines = catalogEntries.filter((entry) => !renderedChannelIds.has(entry.id)).map((entry) => {
		const hint = resolveMissingOfficialExternalChannelPluginRepairHint({
			config: cfg,
			channelId: entry.id,
			...workspaceDir ? { workspaceDir } : {}
		});
		return {
			entry,
			installed: isInstalled(entry.id),
			configured: Boolean(hint),
			repairHint: hint ? `run ${hint.installCommand} or ${hint.doctorFixCommand}` : void 0
		};
	}).filter((line) => showAll || line.configured);
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
		for (const line of catalogOnlyLines) chat[line.entry.id] = {
			accounts: [],
			installed: line.installed,
			origin: line.configured ? "configured" : line.installed ? "available" : "installable"
		};
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
		for (const line of catalogOnlyLines) lines.push(formatCatalogOnlyLine({
			entry: line.entry,
			installed: line.installed,
			configured: line.configured,
			...line.repairHint ? { repairHint: line.repairHint } : {}
		}));
	}
	runtime.log(lines.join("\n"));
	runtime.log("");
	runtime.log(theme.muted("Model provider usage moved out of `channels list` — see `openclaw status` or `openclaw models list`."));
	runtime.log(`Docs: ${formatDocsLink("/gateway/configuration", "gateway/configuration")}`);
}
//#endregion
export { channelsListCommand as t };
