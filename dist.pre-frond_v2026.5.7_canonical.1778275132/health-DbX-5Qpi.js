import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { t as isTruthyEnvValue } from "./env-BkGYa0ve.js";
import { n as isRich } from "./theme-CVJvORNs.js";
import { t as createLazyImportLoader } from "./lazy-promise-AiZRy56y.js";
import { c as normalizeAgentId } from "./session-key-C0K0uhmG.js";
import { S as resolveDefaultAgentId } from "./agent-scope-CcybJBoN.js";
import { r as writeRuntimeJson } from "./runtime-bzt9CHmD.js";
import { n as info } from "./globals-BHVmraBM.js";
import { i as getRuntimeConfig } from "./io-DOE5w-Qp.js";
import "./config-C_YnpthU.js";
import { i as callGateway, r as buildGatewayConnectionDetails } from "./call-CNyRnB85.js";
import { n as asNullableRecord } from "./record-coerce-BjNW89OI.js";
import { a as getActivePluginRegistry } from "./runtime-hvvIx7oB.js";
import { u as resolveStorePath } from "./paths-B_upRR9g.js";
import { r as resolveHeartbeatSummaryForAgent } from "./heartbeat-summary-t-vjJfyo.js";
import { n as listReadOnlyChannelPluginsForConfig } from "./read-only-DD6yDw9r.js";
import { i as resolveChannelDefaultAccountId } from "./helpers-PfWBHn-b.js";
import { a as resolvePreferredAccountId, t as buildChannelAccountBindings } from "./bindings-CCxenggN.js";
import { a as resolveChannelAccountConfigured, o as resolveChannelAccountEnabled, t as inspectChannelAccount } from "./account-inspection-CraWV1c6.js";
import { r as withProgress } from "./progress-UGUqAH-r.js";
import { t as formatHealthChannelLines } from "./health-format-BN-xYuIg.js";
import { n as buildChannelAccountSnapshotFromAccount } from "./status-Bl2gNkes.js";
import { n as DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS, r as evaluateChannelHealth, t as DEFAULT_CHANNEL_CONNECT_GRACE_MS } from "./channel-health-policy-QqCOcX2T.js";
import { t as styleHealthChannelLine } from "./health-style-BTyPutcJ.js";
import { t as logGatewayConnectionDetails } from "./status.gateway-connection-CH463S2W.js";
//#region src/commands/health.ts
const DEFAULT_TIMEOUT_MS = 1e4;
const configModuleLoader = createLazyImportLoader(() => import("./config/config.js"));
function loadConfigModule() {
	return configModuleLoader.load();
}
const debugHealth = (...args) => {
	if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_HEALTH)) console.warn("[health:debug]", ...args);
};
const formatDurationParts = (ms) => {
	if (!Number.isFinite(ms)) return "unknown";
	if (ms < 1e3) return `${Math.max(0, Math.round(ms))}ms`;
	const units = [
		{
			label: "w",
			size: 10080 * 60 * 1e3
		},
		{
			label: "d",
			size: 1440 * 60 * 1e3
		},
		{
			label: "h",
			size: 3600 * 1e3
		},
		{
			label: "m",
			size: 60 * 1e3
		},
		{
			label: "s",
			size: 1e3
		}
	];
	let remaining = Math.max(0, Math.floor(ms));
	const parts = [];
	for (const unit of units) {
		const value = Math.floor(remaining / unit.size);
		if (value > 0) {
			parts.push(`${value}${unit.label}`);
			remaining -= value * unit.size;
		}
	}
	if (parts.length === 0) return "0s";
	return parts.join(" ");
};
function formatEventLoopHealthLine(summary) {
	const eventLoop = summary.eventLoop;
	if (!eventLoop) return null;
	return `Gateway event loop: ${eventLoop.degraded ? "degraded" : "ok"}${eventLoop.reasons.length > 0 ? ` reasons=${eventLoop.reasons.join(",")}` : ""} max=${Math.round(eventLoop.delayMaxMs)}ms p99=${Math.round(eventLoop.delayP99Ms)}ms util=${eventLoop.utilization} cpu=${eventLoop.cpuCoreRatio}`;
}
const resolveHeartbeatSummary = (cfg, agentId) => resolveHeartbeatSummaryForAgent(cfg, agentId);
const resolveAgentOrder = (cfg) => {
	const defaultAgentId = resolveDefaultAgentId(cfg);
	const entries = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	const seen = /* @__PURE__ */ new Set();
	const ordered = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (typeof entry.id !== "string" || !entry.id.trim()) continue;
		const id = normalizeAgentId(entry.id);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ordered.push({
			id,
			name: typeof entry.name === "string" ? entry.name : void 0
		});
	}
	if (!seen.has(defaultAgentId)) ordered.unshift({ id: defaultAgentId });
	if (ordered.length === 0) ordered.push({ id: defaultAgentId });
	return {
		defaultAgentId,
		ordered
	};
};
const buildSessionSummary = async (storePath) => {
	const { loadSessionStore } = await import("./store-CRfIfg0b.js");
	const store = loadSessionStore(storePath);
	const sessions = Object.entries(store).filter(([key]) => key !== "global" && key !== "unknown").map(([key, entry]) => ({
		key,
		updatedAt: entry?.updatedAt ?? 0
	})).toSorted((a, b) => b.updatedAt - a.updatedAt);
	const recent = sessions.slice(0, 5).map((s) => ({
		key: s.key,
		updatedAt: s.updatedAt || null,
		age: s.updatedAt ? Date.now() - s.updatedAt : null
	}));
	return {
		path: storePath,
		count: sessions.length,
		recent
	};
};
function buildPluginHealthSummary() {
	const registry = getActivePluginRegistry();
	if (!registry) return;
	const loaded = registry.plugins.filter((plugin) => plugin.status === "loaded").map((plugin) => plugin.id).toSorted((left, right) => left.localeCompare(right));
	const errors = registry.plugins.filter((plugin) => plugin.status === "error").map((plugin) => {
		const error = {
			id: plugin.id,
			origin: plugin.origin,
			activated: plugin.activated === true,
			error: plugin.error ?? "unknown plugin load error"
		};
		if (plugin.activationSource) error.activationSource = plugin.activationSource;
		if (plugin.activationReason) error.activationReason = plugin.activationReason;
		if (plugin.failurePhase) error.failurePhase = plugin.failurePhase;
		return error;
	}).toSorted((left, right) => left.id.localeCompare(right.id));
	if (loaded.length === 0 && errors.length === 0) return;
	return {
		loaded,
		errors
	};
}
function readBooleanField(value, key) {
	const record = asNullableRecord(value);
	if (!record) return;
	return typeof record[key] === "boolean" ? record[key] : void 0;
}
const hasAccountValue = (account) => account !== null && account !== void 0;
function resolveProbeAccountEnabled(params) {
	const fallback = readBooleanField(params.account, "enabled") ?? true;
	try {
		return resolveChannelAccountEnabled({
			plugin: params.plugin,
			account: params.account,
			cfg: params.cfg
		});
	} catch (error) {
		params.diagnostics.push(`${params.plugin.id}:${params.accountId}: failed to evaluate enabled state (${formatErrorMessage(error)}).`);
		return fallback;
	}
}
async function resolveProbeAccountConfigured(params) {
	const fallback = readBooleanField(params.account, "configured") ?? true;
	try {
		return await resolveChannelAccountConfigured({
			plugin: params.plugin,
			account: params.account,
			cfg: params.cfg,
			readAccountConfiguredField: true
		});
	} catch (error) {
		params.diagnostics.push(`${params.plugin.id}:${params.accountId}: failed to evaluate configured state (${formatErrorMessage(error)}).`);
		return fallback;
	}
}
async function resolveHealthAccountContext(params) {
	const diagnostics = [];
	let account;
	try {
		account = params.plugin.config.resolveAccount(params.cfg, params.accountId);
	} catch (error) {
		diagnostics.push(`${params.plugin.id}:${params.accountId}: failed to resolve account (${formatErrorMessage(error)}).`);
	}
	let inspectedAccount;
	try {
		inspectedAccount = await inspectChannelAccount(params);
	} catch (error) {
		diagnostics.push(`${params.plugin.id}:${params.accountId}: failed to inspect account (${formatErrorMessage(error)}).`);
	}
	const probeAccount = hasAccountValue(account) ? account : inspectedAccount;
	if (!hasAccountValue(probeAccount)) return {
		probeAccount: {},
		snapshotAccount: {},
		enabled: false,
		configured: false,
		diagnostics
	};
	return {
		probeAccount,
		snapshotAccount: hasAccountValue(inspectedAccount) ? inspectedAccount : probeAccount,
		enabled: resolveProbeAccountEnabled({
			plugin: params.plugin,
			cfg: params.cfg,
			accountId: params.accountId,
			account: probeAccount,
			diagnostics
		}),
		configured: await resolveProbeAccountConfigured({
			plugin: params.plugin,
			cfg: params.cfg,
			accountId: params.accountId,
			account: probeAccount,
			diagnostics
		}),
		diagnostics
	};
}
async function getHealthSnapshot(params) {
	const timeoutMs = params?.timeoutMs;
	const cfg = getRuntimeConfig();
	const { defaultAgentId, ordered } = resolveAgentOrder(cfg);
	const channelBindings = buildChannelAccountBindings(cfg);
	const sessionCache = /* @__PURE__ */ new Map();
	const agents = [];
	for (const entry of ordered) {
		const storePath = resolveStorePath(cfg.session?.store, { agentId: entry.id });
		const sessions = sessionCache.get(storePath) ?? await buildSessionSummary(storePath);
		sessionCache.set(storePath, sessions);
		agents.push({
			agentId: entry.id,
			name: entry.name,
			isDefault: entry.id === defaultAgentId,
			heartbeat: resolveHeartbeatSummary(cfg, entry.id),
			sessions
		});
	}
	const defaultAgent = agents.find((agent) => agent.isDefault) ?? agents[0];
	const heartbeatSeconds = defaultAgent?.heartbeat.everyMs ? Math.round(defaultAgent.heartbeat.everyMs / 1e3) : 0;
	const sessions = defaultAgent?.sessions ?? await buildSessionSummary(resolveStorePath(cfg.session?.store, { agentId: defaultAgentId }));
	const start = Date.now();
	const cappedTimeout = timeoutMs === void 0 ? DEFAULT_TIMEOUT_MS : Math.max(50, timeoutMs);
	const doProbe = params?.probe !== false;
	const includeSensitive = params?.includeSensitive !== false;
	const channels = {};
	const plugins = listReadOnlyChannelPluginsForConfig(cfg, { includeSetupFallbackPlugins: false });
	const channelOrder = plugins.map((plugin) => plugin.id);
	const channelLabels = {};
	for (const plugin of plugins) {
		channelLabels[plugin.id] = plugin.meta.label ?? plugin.id;
		const accountIds = plugin.config.listAccountIds(cfg);
		const defaultAccountId = resolveChannelDefaultAccountId({
			plugin,
			cfg,
			accountIds
		});
		const boundAccounts = channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [];
		const preferredAccountId = resolvePreferredAccountId({
			accountIds,
			defaultAccountId,
			boundAccounts
		});
		const boundAccountIdsAll = Array.from(new Set(Array.from(channelBindings.get(plugin.id)?.values() ?? []).flatMap((ids) => ids)));
		const accountIdsToProbe = Array.from(new Set([
			preferredAccountId,
			defaultAccountId,
			...accountIds,
			...boundAccountIdsAll
		].filter((value) => value && value.trim())));
		debugHealth("channel", {
			id: plugin.id,
			accountIds,
			defaultAccountId,
			boundAccounts,
			preferredAccountId,
			accountIdsToProbe
		});
		const accountSummaries = {};
		for (const accountId of accountIdsToProbe) {
			const { probeAccount, snapshotAccount, enabled, configured, diagnostics } = await resolveHealthAccountContext({
				plugin,
				cfg,
				accountId
			});
			if (diagnostics.length > 0) debugHealth("account.diagnostics", {
				channel: plugin.id,
				accountId,
				diagnostics
			});
			let probe;
			let lastProbeAt = null;
			if (enabled && configured && doProbe && plugin.status?.probeAccount) try {
				probe = await plugin.status.probeAccount({
					account: probeAccount,
					timeoutMs: cappedTimeout,
					cfg
				});
				lastProbeAt = Date.now();
			} catch (err) {
				probe = {
					ok: false,
					error: formatErrorMessage(err)
				};
				lastProbeAt = Date.now();
			}
			const probeRecord = probe && typeof probe === "object" ? probe : null;
			const bot = probeRecord && typeof probeRecord.bot === "object" ? probeRecord.bot : null;
			if (bot?.username) debugHealth("probe.bot", {
				channel: plugin.id,
				accountId,
				username: bot.username
			});
			const snapshot = await buildChannelAccountSnapshotFromAccount({
				plugin,
				cfg,
				accountId,
				account: snapshotAccount,
				runtime: params?.runtimeSnapshot?.channelAccounts[plugin.id]?.[accountId] ?? (accountId === defaultAccountId ? params?.runtimeSnapshot?.channels[plugin.id] : void 0),
				probe: includeSensitive ? probe : void 0,
				enabledFallback: enabled,
				configuredFallback: configured
			});
			if (lastProbeAt) snapshot.lastProbeAt = lastProbeAt;
			const health = evaluateChannelHealth(snapshot, {
				channelId: plugin.id,
				now: Date.now(),
				staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
				channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS
			});
			if (!health.healthy) snapshot.healthState = health.reason;
			const summary = plugin.status?.buildChannelSummary ? await plugin.status.buildChannelSummary({
				account: probeAccount,
				cfg,
				defaultAccountId: accountId,
				snapshot
			}) : void 0;
			const record = summary && typeof summary === "object" ? {
				...snapshot,
				...summary
			} : {
				...snapshot,
				accountId,
				configured
			};
			if (record.configured === void 0) record.configured = configured;
			if (includeSensitive && record.probe === void 0 && probe !== void 0) record.probe = probe;
			if (!includeSensitive) delete record.probe;
			if (record.lastProbeAt === void 0 && lastProbeAt) record.lastProbeAt = lastProbeAt;
			record.accountId = accountId;
			accountSummaries[accountId] = record;
		}
		const fallbackSummary = accountSummaries[preferredAccountId] ?? accountSummaries[defaultAccountId] ?? accountSummaries[accountIdsToProbe[0] ?? preferredAccountId] ?? accountSummaries[Object.keys(accountSummaries)[0]];
		if (fallbackSummary) channels[plugin.id] = {
			...fallbackSummary,
			accounts: accountSummaries
		};
	}
	const pluginHealth = buildPluginHealthSummary();
	return {
		ok: true,
		ts: Date.now(),
		durationMs: Date.now() - start,
		...params?.eventLoop ? { eventLoop: params.eventLoop } : {},
		...pluginHealth ? { plugins: pluginHealth } : {},
		channels,
		channelOrder,
		channelLabels,
		heartbeatSeconds,
		defaultAgentId,
		agents,
		sessions: {
			path: sessions.path,
			count: sessions.count,
			recent: sessions.recent
		}
	};
}
async function healthCommand(opts, runtime) {
	const cfg = opts.config ?? await readBestEffortHealthConfig();
	const summary = await withProgress({
		label: "Checking gateway health…",
		indeterminate: true,
		enabled: opts.json !== true
	}, async () => await callGateway({
		method: "health",
		params: opts.verbose ? { probe: true } : void 0,
		timeoutMs: opts.timeoutMs,
		config: cfg,
		token: opts.token,
		password: opts.password
	}));
	if (opts.json) writeRuntimeJson(runtime, summary);
	else {
		const debugEnabled = isTruthyEnvValue(process.env.OPENCLAW_DEBUG_HEALTH);
		const rich = isRich();
		if (opts.verbose) logGatewayConnectionDetails({
			runtime,
			info,
			message: buildGatewayConnectionDetails({ config: cfg }).message
		});
		const localAgents = resolveAgentOrder(cfg);
		const defaultAgentId = summary.defaultAgentId ?? localAgents.defaultAgentId;
		const agents = Array.isArray(summary.agents) ? summary.agents : [];
		const fallbackAgents = [];
		for (const entry of localAgents.ordered) {
			const storePath = resolveStorePath(cfg.session?.store, { agentId: entry.id });
			fallbackAgents.push({
				agentId: entry.id,
				name: entry.name,
				isDefault: entry.id === localAgents.defaultAgentId,
				heartbeat: resolveHeartbeatSummary(cfg, entry.id),
				sessions: await buildSessionSummary(storePath)
			});
		}
		const resolvedAgents = agents.length > 0 ? agents : fallbackAgents;
		const displayAgents = opts.verbose ? resolvedAgents : resolvedAgents.filter((agent) => agent.agentId === defaultAgentId);
		const channelBindings = buildChannelAccountBindings(cfg);
		const displayPlugins = listReadOnlyChannelPluginsForConfig(cfg, { includeSetupFallbackPlugins: false });
		if (debugEnabled) {
			runtime.log(info("[debug] local channel accounts"));
			for (const plugin of displayPlugins) {
				const accountIds = plugin.config.listAccountIds(cfg);
				const defaultAccountId = resolveChannelDefaultAccountId({
					plugin,
					cfg,
					accountIds
				});
				runtime.log(`  ${plugin.id}: accounts=${accountIds.join(", ") || "(none)"} default=${defaultAccountId}`);
				for (const accountId of accountIds) {
					const { snapshotAccount, configured, diagnostics } = await resolveHealthAccountContext({
						plugin,
						cfg,
						accountId
					});
					const record = asNullableRecord(snapshotAccount);
					const tokenSource = record && typeof record.tokenSource === "string" ? record.tokenSource : void 0;
					runtime.log(`    - ${accountId}: configured=${configured}${tokenSource ? ` tokenSource=${tokenSource}` : ""}`);
					for (const diagnostic of diagnostics) runtime.log(`      ! ${diagnostic}`);
				}
			}
			runtime.log(info("[debug] bindings map"));
			for (const [channelId, byAgent] of channelBindings.entries()) {
				const entries = Array.from(byAgent.entries()).map(([agentId, ids]) => `${agentId}=[${ids.join(", ")}]`);
				runtime.log(`  ${channelId}: ${entries.join(" ")}`);
			}
			runtime.log(info("[debug] gateway channel probes"));
			for (const [channelId, channelSummary] of Object.entries(summary.channels ?? {})) {
				const accounts = channelSummary.accounts ?? {};
				const probes = Object.entries(accounts).map(([accountId, accountSummary]) => {
					const probe = asNullableRecord(accountSummary.probe);
					const bot = probe ? asNullableRecord(probe.bot) : null;
					return `${accountId}=${(bot && typeof bot.username === "string" ? bot.username : null) ?? "(no bot)"}`;
				});
				runtime.log(`  ${channelId}: ${probes.join(", ") || "(none)"}`);
			}
		}
		const channelAccountFallbacks = Object.fromEntries(displayPlugins.map((plugin) => {
			const accountIds = plugin.config.listAccountIds(cfg);
			const preferred = resolvePreferredAccountId({
				accountIds,
				defaultAccountId: resolveChannelDefaultAccountId({
					plugin,
					cfg,
					accountIds
				}),
				boundAccounts: channelBindings.get(plugin.id)?.get(defaultAgentId) ?? []
			});
			return [plugin.id, [preferred]];
		}));
		const accountIdsByChannel = (() => {
			const entries = displayAgents.length > 0 ? displayAgents : resolvedAgents;
			const byChannel = {};
			for (const [channelId, byAgent] of channelBindings.entries()) {
				const accountIds = [];
				for (const agent of entries) {
					const ids = byAgent.get(agent.agentId) ?? [];
					for (const id of ids) if (!accountIds.includes(id)) accountIds.push(id);
				}
				if (accountIds.length > 0) byChannel[channelId] = accountIds;
			}
			for (const [channelId, fallbackIds] of Object.entries(channelAccountFallbacks)) if (!byChannel[channelId] || byChannel[channelId].length === 0) byChannel[channelId] = fallbackIds;
			return byChannel;
		})();
		const channelLines = Object.keys(accountIdsByChannel).length > 0 ? formatHealthChannelLines(summary, {
			accountMode: opts.verbose ? "all" : "default",
			accountIdsByChannel
		}) : formatHealthChannelLines(summary, { accountMode: opts.verbose ? "all" : "default" });
		for (const line of channelLines) runtime.log(styleHealthChannelLine(line, rich));
		const eventLoopLine = formatEventLoopHealthLine(summary);
		if (eventLoopLine) runtime.log(styleHealthChannelLine(eventLoopLine, rich));
		for (const plugin of displayPlugins) {
			const channelSummary = summary.channels?.[plugin.id];
			if (!channelSummary || channelSummary.linked !== true) continue;
			if (!plugin.status?.logSelfId) continue;
			const boundAccounts = channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [];
			const accountIds = plugin.config.listAccountIds(cfg);
			const accountId = resolvePreferredAccountId({
				accountIds,
				defaultAccountId: resolveChannelDefaultAccountId({
					plugin,
					cfg,
					accountIds
				}),
				boundAccounts
			});
			const accountContext = await resolveHealthAccountContext({
				plugin,
				cfg,
				accountId
			});
			if (!accountContext.enabled || !accountContext.configured) continue;
			if (accountContext.diagnostics.length > 0) continue;
			try {
				plugin.status.logSelfId({
					account: accountContext.probeAccount,
					cfg,
					runtime,
					includeChannelPrefix: true
				});
			} catch (error) {
				debugHealth("logSelfId.failed", {
					channel: plugin.id,
					accountId,
					error: formatErrorMessage(error)
				});
			}
		}
		if (resolvedAgents.length > 0) {
			const agentLabels = resolvedAgents.map((agent) => agent.isDefault ? `${agent.agentId} (default)` : agent.agentId);
			runtime.log(info(`Agents: ${agentLabels.join(", ")}`));
		}
		const heartbeatParts = displayAgents.map((agent) => {
			const everyMs = agent.heartbeat?.everyMs;
			return `${everyMs ? formatDurationParts(everyMs) : "disabled"} (${agent.agentId})`;
		}).filter(Boolean);
		if (heartbeatParts.length > 0) runtime.log(info(`Heartbeat interval: ${heartbeatParts.join(", ")}`));
		if (displayAgents.length === 0) {
			runtime.log(info(`Session store: ${summary.sessions.path} (${summary.sessions.count} entries)`));
			if (summary.sessions.recent.length > 0) for (const r of summary.sessions.recent) runtime.log(`- ${r.key} (${r.updatedAt ? `${Math.round((Date.now() - r.updatedAt) / 6e4)}m ago` : "no activity"})`);
		} else for (const agent of displayAgents) {
			runtime.log(info(`Session store (${agent.agentId}): ${agent.sessions.path} (${agent.sessions.count} entries)`));
			if (agent.sessions.recent.length > 0) for (const r of agent.sessions.recent) runtime.log(`- ${r.key} (${r.updatedAt ? `${Math.round((Date.now() - r.updatedAt) / 6e4)}m ago` : "no activity"})`);
		}
	}
}
async function readBestEffortHealthConfig() {
	const { readBestEffortConfig } = await loadConfigModule();
	return await readBestEffortConfig();
}
//#endregion
export { healthCommand as n, getHealthSnapshot as t };
