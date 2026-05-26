import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { o as redactSensitiveUrlLikeString } from "./redact-sensitive-url-NNYIE41N.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { a as normalizeChannelId } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { f as listConfiguredChannelIdsForReadOnlyScope, p as listExplicitConfiguredChannelIdsForConfig } from "./channel-plugin-ids-nB-ga3MN.js";
import { t as resolveMissingOfficialExternalChannelPluginRepairHint } from "./official-external-plugin-repair-hints-CS7WhtMH.js";
import { n as listReadOnlyChannelPluginsForConfig } from "./read-only-CHBMrkWp.js";
import { s as getConfiguredChannelsCommandSecretTargetIds } from "./command-secret-targets-UUlaHEu2.js";
import { n as formatTimeAgo } from "./format-relative-Bjc3l98W.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
import { n as hasResolvedCredentialValue, t as hasConfiguredUnavailableCredentialStatus } from "./account-snapshot-fields-YzCGlwrq.js";
import { t as resolveCommandConfigWithSecrets } from "./command-config-resolution-QySEqFLr.js";
import { n as requireValidConfigSnapshot } from "./config-validation-CSay_Jnk.js";
import { a as buildChannelAccountLine, i as appendTokenSourceBits, n as appendEnabledConfiguredLinkedBits, r as appendModeBit, t as appendBaseUrlBit } from "./shared-DxOkFLYA.js";
import { r as buildReadOnlySourceChannelAccountSnapshot, t as buildChannelAccountSnapshot } from "./status-DQVTMawq.js";
import { t as collectChannelStatusIssues } from "./channels-status-issues-C_XpqXR-.js";
//#region src/commands/channels/status-config-format.ts
async function formatConfigChannelsStatusLines(cfg, meta, opts) {
	const lines = [];
	lines.push(theme.warn("Gateway not reachable; showing config-only status."));
	if (meta.path) lines.push(`Config: ${meta.path}`);
	if (meta.mode) lines.push(`Mode: ${meta.mode}`);
	if (meta.path || meta.mode) lines.push("");
	const accountLines = (plugin, accounts) => accounts.map((account) => {
		const bits = [];
		appendEnabledConfiguredLinkedBits(bits, account);
		appendModeBit(bits, account);
		appendTokenSourceBits(bits, account);
		appendBaseUrlBit(bits, account);
		return buildChannelAccountLine(plugin.id, account, bits, { channelLabel: plugin.meta.label ?? plugin.id });
	});
	const sourceConfig = opts?.sourceConfig ?? cfg;
	const requestedChannel = opts?.channel ? normalizeChannelId(opts.channel) : null;
	const plugins = listReadOnlyChannelPluginsForConfig(cfg, {
		activationSourceConfig: sourceConfig,
		includeSetupFallbackPlugins: true
	}).filter((plugin) => !requestedChannel || plugin.id === requestedChannel);
	const visibleChannelIds = /* @__PURE__ */ new Set();
	for (const plugin of plugins) {
		visibleChannelIds.add(plugin.id);
		const accountIds = plugin.config.listAccountIds(cfg);
		if (!accountIds.length) continue;
		const snapshots = [];
		for (const accountId of accountIds) {
			const sourceSnapshot = await buildReadOnlySourceChannelAccountSnapshot({
				plugin,
				cfg: sourceConfig,
				accountId
			});
			const resolvedSnapshot = await buildChannelAccountSnapshot({
				plugin,
				cfg,
				accountId
			});
			snapshots.push(sourceSnapshot && hasConfiguredUnavailableCredentialStatus(sourceSnapshot) && (!hasResolvedCredentialValue(resolvedSnapshot) || sourceSnapshot.configured === true && resolvedSnapshot.configured === false) ? sourceSnapshot : resolvedSnapshot);
		}
		if (snapshots.length > 0) lines.push(...accountLines(plugin, snapshots));
	}
	const missingHints = [];
	const missingChannelIds = [...new Set([...listExplicitConfiguredChannelIdsForConfig(sourceConfig), ...listExplicitConfiguredChannelIdsForConfig(cfg)])];
	for (const channelId of missingChannelIds) {
		if (requestedChannel && channelId !== requestedChannel) continue;
		if (visibleChannelIds.has(channelId)) continue;
		const hint = resolveMissingOfficialExternalChannelPluginRepairHint({
			config: cfg,
			activationSourceConfig: sourceConfig,
			channelId
		});
		if (!hint?.channelId || visibleChannelIds.has(hint.channelId)) continue;
		missingHints.push(hint);
		visibleChannelIds.add(hint.channelId);
	}
	if (missingHints.length > 0) {
		lines.push("");
		lines.push(theme.warn("Missing official external plugins:"));
		for (const hint of missingHints) lines.push(`- ${hint.label}: ${hint.repairHint}`);
	}
	lines.push("");
	lines.push(`Tip: ${formatDocsLink("/cli#status", "status --deep")} adds gateway health probes to status output (requires a reachable gateway).`);
	return lines;
}
//#endregion
//#region src/commands/channels/status.ts
function redactGatewayUrlSecretsInText(text) {
	return text.replace(/\b(?:wss?|https?):\/\/[^\s"'<>]+/gi, (rawUrl) => {
		return redactSensitiveUrlLikeString(rawUrl);
	});
}
function formatChannelsStatusError(err) {
	return redactGatewayUrlSecretsInText(formatErrorMessage(err));
}
function formatEventLoopBits(value) {
	if (!value || typeof value !== "object") return null;
	const record = value;
	if (record.degraded !== true) return null;
	const reasons = Array.isArray(record.reasons) ? record.reasons.filter((reason) => typeof reason === "string") : [];
	const delayMaxMs = typeof record.delayMaxMs === "number" && Number.isFinite(record.delayMaxMs) ? Math.round(record.delayMaxMs) : null;
	const utilization = typeof record.utilization === "number" && Number.isFinite(record.utilization) ? record.utilization : null;
	const cpuCoreRatio = typeof record.cpuCoreRatio === "number" && Number.isFinite(record.cpuCoreRatio) ? record.cpuCoreRatio : null;
	return [
		reasons.length ? `reasons=${reasons.join(",")}` : null,
		delayMaxMs != null ? `eventLoopDelayMaxMs=${delayMaxMs}` : null,
		utilization != null ? `eventLoopUtilization=${utilization}` : null,
		cpuCoreRatio != null ? `cpuCoreRatio=${cpuCoreRatio}` : null
	].filter((part) => Boolean(part)).join(" ");
}
function formatGatewayChannelsStatusLines(payload) {
	const lines = [];
	lines.push(theme.success("Gateway reachable."));
	const eventLoopLine = formatEventLoopBits(payload.eventLoop);
	if (eventLoopLine) lines.push(theme.warn(`Gateway event loop degraded: ${eventLoopLine}`));
	const channelLabels = payload.channelLabels && typeof payload.channelLabels === "object" ? payload.channelLabels : {};
	const accountLines = (provider, accounts) => accounts.map((account) => {
		const bits = [];
		appendEnabledConfiguredLinkedBits(bits, account);
		if (typeof account.running === "boolean") bits.push(account.running ? "running" : "stopped");
		if (typeof account.connected === "boolean") bits.push(account.connected ? "connected" : "disconnected");
		const inboundAt = typeof account.lastInboundAt === "number" && Number.isFinite(account.lastInboundAt) ? account.lastInboundAt : null;
		const outboundAt = typeof account.lastOutboundAt === "number" && Number.isFinite(account.lastOutboundAt) ? account.lastOutboundAt : null;
		const transportAt = typeof account.lastTransportActivityAt === "number" && Number.isFinite(account.lastTransportActivityAt) ? account.lastTransportActivityAt : null;
		if (inboundAt) bits.push(`in:${formatTimeAgo(Date.now() - inboundAt)}`);
		if (outboundAt) bits.push(`out:${formatTimeAgo(Date.now() - outboundAt)}`);
		if (transportAt) bits.push(`transport:${formatTimeAgo(Date.now() - transportAt)}`);
		appendModeBit(bits, account);
		const botUsername = (() => {
			const bot = account.bot;
			const probeBot = account.probe?.bot;
			const raw = bot?.username ?? probeBot?.username ?? "";
			if (typeof raw !== "string") return "";
			const trimmed = raw.trim();
			if (!trimmed) return "";
			return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
		})();
		if (botUsername) bits.push(`bot:${botUsername}`);
		if (typeof account.dmPolicy === "string" && account.dmPolicy.length > 0) bits.push(`dm:${account.dmPolicy}`);
		if (Array.isArray(account.allowFrom) && account.allowFrom.length > 0) bits.push(`allow:${account.allowFrom.slice(0, 2).join(",")}`);
		appendTokenSourceBits(bits, account);
		const messageContent = account.application?.intents?.messageContent;
		if (typeof messageContent === "string" && messageContent.length > 0 && messageContent !== "enabled") bits.push(`intents:content=${messageContent}`);
		if (account.allowUnmentionedGroups === true) bits.push("groups:unmentioned");
		if (typeof account.healthState === "string" && account.healthState) bits.push(`health:${account.healthState}`);
		appendBaseUrlBit(bits, account);
		const probe = account.probe;
		if (probe && typeof probe.ok === "boolean") bits.push(probe.ok ? "works" : "probe failed");
		const audit = account.audit;
		if (audit && typeof audit.ok === "boolean") bits.push(audit.ok ? "audit ok" : "audit failed");
		if (typeof account.lastError === "string" && account.lastError) bits.push(`error:${account.lastError}`);
		const rawChannelLabel = channelLabels[provider];
		return buildChannelAccountLine(provider, account, bits, { channelLabel: typeof rawChannelLabel === "string" ? rawChannelLabel : provider });
	});
	const accountsByChannel = payload.channelAccounts;
	const accountPayloads = {};
	for (const channelId of Object.keys(accountsByChannel ?? {}).toSorted()) {
		const raw = accountsByChannel?.[channelId];
		if (Array.isArray(raw)) accountPayloads[channelId] = raw;
	}
	for (const channelId of Object.keys(accountPayloads).toSorted()) {
		const accounts = accountPayloads[channelId];
		if (accounts && accounts.length > 0) lines.push(...accountLines(channelId, accounts));
	}
	lines.push("");
	const issues = collectChannelStatusIssues(payload);
	if (issues.length > 0) {
		lines.push(theme.warn("Warnings:"));
		for (const issue of issues) lines.push(`- ${issue.channel} ${issue.accountId}: ${issue.message}${issue.fix ? ` (${issue.fix})` : ""}`);
		lines.push(`- Run: ${formatCliCommand("openclaw doctor")}`);
		lines.push("");
	}
	lines.push(`Tip: ${formatDocsLink("/cli#status", "status --deep")} adds gateway health probes to status output (requires a reachable gateway).`);
	return lines;
}
async function channelsStatusCommand(opts, runtime = defaultRuntime) {
	const timeoutMs = Number(opts.timeout ?? (opts.probe ? 3e4 : 1e4));
	const requestedChannel = opts.channel ? normalizeChannelId(opts.channel) : null;
	const statusLabel = opts.probe ? "Checking channel status (probe)…" : "Checking channel status…";
	if (opts.json !== true && !process.stderr.isTTY) runtime.log(statusLabel);
	try {
		const payload = await withProgress({
			label: statusLabel,
			indeterminate: true,
			enabled: opts.json !== true
		}, async () => {
			const params = {
				probe: Boolean(opts.probe),
				timeoutMs
			};
			if (opts.channel) params.channel = opts.channel;
			return await callGateway({
				method: "channels.status",
				params,
				timeoutMs
			});
		});
		if (opts.json) {
			writeRuntimeJson(runtime, payload);
			return;
		}
		runtime.log(formatGatewayChannelsStatusLines(payload).join("\n"));
	} catch (err) {
		const safeError = formatChannelsStatusError(err);
		runtime.error(`Gateway not reachable: ${safeError}`);
		const cfg = await requireValidConfigSnapshot(runtime);
		if (!cfg) return;
		const { resolvedConfig } = await resolveCommandConfigWithSecrets({
			config: cfg,
			commandName: "channels status",
			targetIds: getConfiguredChannelsCommandSecretTargetIds(cfg),
			mode: "read_only_status",
			runtime
		});
		const snapshot = await readConfigFileSnapshot();
		const mode = cfg.gateway?.mode === "remote" ? "remote" : "local";
		if (opts.json) {
			writeRuntimeJson(runtime, {
				gatewayReachable: false,
				error: safeError,
				configOnly: true,
				config: {
					path: snapshot.path,
					mode
				},
				configuredChannels: listConfiguredChannelIdsForReadOnlyScope({
					config: resolvedConfig,
					activationSourceConfig: cfg,
					env: process.env,
					includePersistedAuthState: false
				}).filter((channelId) => !requestedChannel || channelId === requestedChannel)
			});
			return;
		}
		runtime.log((await formatConfigChannelsStatusLines(resolvedConfig, {
			path: snapshot.path,
			mode
		}, {
			sourceConfig: cfg,
			channel: opts.channel
		})).join("\n"));
	}
}
//#endregion
export { formatGatewayChannelsStatusLines as n, channelsStatusCommand as t };
