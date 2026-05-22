import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { t as formatDocsLink } from "./links-BszRQhGa.js";
import { r as theme } from "./theme-B128avno.js";
import { t as formatCliCommand } from "./command-format-DXo6xcsW.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-Dv8n03pi.js";
import { u as readConfigFileSnapshot } from "./io-BD1XQ5lD.js";
import "./config-CshcuIUd.js";
import { i as callGateway } from "./call-BolF1jqz.js";
import { o as redactSensitiveUrlLikeString } from "./redact-sensitive-url-DfXvroKj.js";
import { f as listConfiguredChannelIdsForReadOnlyScope } from "./channel-plugin-ids-BS3RJ9If.js";
import { n as listReadOnlyChannelPluginsForConfig } from "./read-only-CwnV1R3v.js";
import { r as getConfiguredChannelsCommandSecretTargetIds } from "./command-secret-targets-Bc0uCisN.js";
import { n as hasResolvedCredentialValue, t as hasConfiguredUnavailableCredentialStatus } from "./account-snapshot-fields-sjgMIMZQ.js";
import { n as formatTimeAgo } from "./format-relative-9--P3uwG.js";
import { r as withProgress } from "./progress-CA-UKFN8.js";
import { t as resolveCommandConfigWithSecrets } from "./command-config-resolution-T41wHGUK.js";
import { n as requireValidConfigSnapshot } from "./config-validation-Dwzg42Y_.js";
import { r as buildReadOnlySourceChannelAccountSnapshot, t as buildChannelAccountSnapshot } from "./status-BiAIUgps.js";
import { a as buildChannelAccountLine, i as appendTokenSourceBits, n as appendEnabledConfiguredLinkedBits, r as appendModeBit, t as appendBaseUrlBit } from "./shared-Kgdd6AK2.js";
import { t as collectChannelStatusIssues } from "./channels-status-issues-Dk3Rz5Rw.js";
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
	const plugins = listReadOnlyChannelPluginsForConfig(cfg, {
		activationSourceConfig: sourceConfig,
		includeSetupFallbackPlugins: true
	});
	for (const plugin of plugins) {
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
function formatGatewayChannelsStatusLines(payload) {
	const lines = [];
	lines.push(theme.success("Gateway reachable."));
	const channelLabels = payload.channelLabels && typeof payload.channelLabels === "object" ? payload.channelLabels : {};
	const accountLines = (provider, accounts) => accounts.map((account) => {
		const bits = [];
		appendEnabledConfiguredLinkedBits(bits, account);
		if (typeof account.running === "boolean") bits.push(account.running ? "running" : "stopped");
		if (typeof account.connected === "boolean") bits.push(account.connected ? "connected" : "disconnected");
		const inboundAt = typeof account.lastInboundAt === "number" && Number.isFinite(account.lastInboundAt) ? account.lastInboundAt : null;
		const outboundAt = typeof account.lastOutboundAt === "number" && Number.isFinite(account.lastOutboundAt) ? account.lastOutboundAt : null;
		if (inboundAt) bits.push(`in:${formatTimeAgo(Date.now() - inboundAt)}`);
		if (outboundAt) bits.push(`out:${formatTimeAgo(Date.now() - outboundAt)}`);
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
	const statusLabel = opts.probe ? "Checking channel status (probe)…" : "Checking channel status…";
	if (opts.json !== true && !process.stderr.isTTY) runtime.log(statusLabel);
	try {
		const payload = await withProgress({
			label: statusLabel,
			indeterminate: true,
			enabled: opts.json !== true
		}, async () => await callGateway({
			method: "channels.status",
			params: {
				probe: Boolean(opts.probe),
				timeoutMs
			},
			timeoutMs
		}));
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
				})
			});
			return;
		}
		runtime.log((await formatConfigChannelsStatusLines(resolvedConfig, {
			path: snapshot.path,
			mode
		}, { sourceConfig: cfg })).join("\n"));
	}
}
//#endregion
export { formatGatewayChannelsStatusLines as n, channelsStatusCommand as t };
