import { t as formatDocsLink } from "./links-BszRQhGa.js";
import { r as theme } from "./theme-B128avno.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-CFpTi2zA.js";
import { n as isChannelVisibleInConfiguredLists } from "./channel-meta-Dhd3kW9F.js";
import { l as loadAuthProfileStoreWithoutExternalProfiles } from "./store-H1X3llav.js";
import "./auth-profiles-Ch3QVcfx.js";
import { n as listReadOnlyChannelPluginsForConfig } from "./read-only-CsWj5i0c.js";
import { r as withProgress } from "./progress-Cwglgs0e.js";
import { n as formatUsageReportLines, t as loadProviderUsageSummary } from "./provider-usage-DdNPUzAT.js";
import { t as buildChannelAccountSnapshot } from "./status-fMeDAt7J.js";
import { o as formatChannelAccountLabel, s as requireValidConfig } from "./shared-D7yG3xej.js";
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
	const { channel, snapshot } = params;
	const label = formatChannelAccountLabel({
		channel: channel.id,
		accountId: snapshot.accountId,
		name: snapshot.name,
		channelLabel: channel.meta.label ?? channel.id,
		channelStyle: theme.accent,
		accountStyle: theme.heading
	});
	const bits = [];
	if (snapshot.linked !== void 0) bits.push(formatLinked(snapshot.linked));
	if (shouldShowConfigured(channel) && typeof snapshot.configured === "boolean") bits.push(formatConfigured(snapshot.configured));
	if (snapshot.tokenSource) bits.push(formatTokenSource(snapshot.tokenSource));
	if (snapshot.botTokenSource) bits.push(formatSource("bot", snapshot.botTokenSource));
	if (snapshot.appTokenSource) bits.push(formatSource("app", snapshot.appTokenSource));
	if (snapshot.baseUrl) bits.push(`base=${theme.muted(snapshot.baseUrl)}`);
	if (typeof snapshot.enabled === "boolean") bits.push(formatEnabled(snapshot.enabled));
	return `- ${label}: ${bits.join(", ")}`;
}
async function loadUsageWithProgress(runtime, progress = true) {
	try {
		return await withProgress({
			label: "Fetching usage snapshot…",
			indeterminate: true,
			enabled: progress
		}, async () => await loadProviderUsageSummary({ skipPluginAuthWithoutCredentialSource: true }));
	} catch (err) {
		if (progress) runtime.error(String(err));
		return null;
	}
}
async function channelsListCommand(opts, runtime = defaultRuntime) {
	const cfg = await requireValidConfig(runtime);
	if (!cfg) return;
	const includeUsage = opts.usage !== false;
	const plugins = listReadOnlyChannelPluginsForConfig(cfg, { includeSetupFallbackPlugins: true });
	const authStore = loadAuthProfileStoreWithoutExternalProfiles();
	const authProfiles = Object.entries(authStore.profiles).map(([profileId, profile]) => ({
		id: profileId,
		provider: profile.provider,
		type: profile.type,
		isExternal: false
	}));
	if (opts.json) {
		const usage = includeUsage ? await loadUsageWithProgress(runtime, false) : void 0;
		const chat = {};
		for (const plugin of plugins) chat[plugin.id] = plugin.config.listAccountIds(cfg);
		writeRuntimeJson(runtime, {
			chat,
			auth: authProfiles,
			...usage ? { usage } : {}
		});
		return;
	}
	const lines = [];
	lines.push(theme.heading("Chat channels:"));
	for (const plugin of plugins) {
		const accounts = plugin.config.listAccountIds(cfg);
		if (!accounts || accounts.length === 0) continue;
		for (const accountId of accounts) {
			const snapshot = await buildChannelAccountSnapshot({
				plugin,
				cfg,
				accountId
			});
			lines.push(formatAccountLine({
				channel: plugin,
				snapshot
			}));
		}
	}
	lines.push("");
	lines.push(theme.heading("Auth providers (OAuth + API keys):"));
	if (authProfiles.length === 0) lines.push(theme.muted("- none"));
	else for (const profile of authProfiles) {
		const external = profile.isExternal ? theme.muted(" (synced)") : "";
		lines.push(`- ${theme.accent(profile.id)} (${theme.success(profile.type)}${external})`);
	}
	runtime.log(lines.join("\n"));
	if (includeUsage) {
		runtime.log("");
		const usage = await loadUsageWithProgress(runtime);
		if (usage) {
			const usageLines = formatUsageReportLines(usage);
			if (usageLines.length > 0) {
				usageLines[0] = theme.accent(usageLines[0]);
				runtime.log(usageLines.join("\n"));
			}
		}
	}
	runtime.log("");
	runtime.log(`Docs: ${formatDocsLink("/gateway/configuration", "gateway/configuration")}`);
}
//#endregion
export { channelsListCommand as t };
