import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { s as resolveRuntimeServiceVersion } from "./version-B2G3zXnp.js";
import { o as parseAgentSessionKey } from "./session-key-utils-qD-NZHCY.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-BGwElg4C.js";
import "./config-CzeRK-GW.js";
import { i as resolveMainSessionKey } from "./main-session-BkilxHe0.js";
import { u as resolveStorePath } from "./paths-kGAxo7MN.js";
import { l as resolveSessionTotalTokens } from "./types-k3POMgTC.js";
import { l as peekSystemEvents } from "./system-events-D_-_Inav.js";
import { r as resolveCronStorePath } from "./store-CghHeK-D.js";
import { r as resolveHeartbeatSummaryForAgent } from "./heartbeat-summary-DK108U9s.js";
import { a as createLazyRuntimeSurface } from "./lazy-runtime-Dh47Iq4d.js";
import { l as hasConfiguredChannelsForReadOnlyScope } from "./channel-plugin-ids-C3NqlKLT.js";
import { n as readSessionStoreReadOnly, t as listGatewayAgentsBasic } from "./agent-list-CGTod7sP.js";
//#region src/commands/status.summary.ts
const channelSummaryModuleLoader = createLazyImportLoader(() => import("./channel-summary-Byjbb-Zy.js"));
const linkChannelModuleLoader = createLazyImportLoader(() => import("./status.link-channel-BK3OG460.js"));
const taskRegistryMaintenanceModuleLoader = createLazyImportLoader(() => import("./task-registry.maintenance-B-jsfe-3.js"));
function loadChannelSummaryModule() {
	return channelSummaryModuleLoader.load();
}
function loadLinkChannelModule() {
	return linkChannelModuleLoader.load();
}
const loadStatusSummaryRuntimeModule = createLazyRuntimeSurface(() => import("./commands/status.summary.runtime.js"), ({ statusSummaryRuntime }) => statusSummaryRuntime);
function loadTaskRegistryMaintenanceModule() {
	return taskRegistryMaintenanceModuleLoader.load();
}
const buildFlags = (entry) => {
	if (!entry) return [];
	const flags = [];
	const think = entry?.thinkingLevel;
	if (typeof think === "string" && think.length > 0) flags.push(`think:${think}`);
	const verbose = entry?.verboseLevel;
	if (typeof verbose === "string" && verbose.length > 0) flags.push(`verbose:${verbose}`);
	if (typeof entry?.fastMode === "boolean") flags.push(entry.fastMode ? "fast" : "fast:off");
	const reasoning = entry?.reasoningLevel;
	if (typeof reasoning === "string" && reasoning.length > 0) flags.push(`reasoning:${reasoning}`);
	const elevated = entry?.elevatedLevel;
	if (typeof elevated === "string" && elevated.length > 0) flags.push(`elevated:${elevated}`);
	if (entry?.systemSent) flags.push("system");
	if (entry?.abortedLastRun) flags.push("aborted");
	const sessionId = entry?.sessionId;
	if (typeof sessionId === "string" && sessionId.length > 0) flags.push(`id:${sessionId}`);
	return flags;
};
function redactSensitiveStatusSummary(summary) {
	return {
		...summary,
		sessions: {
			...summary.sessions,
			paths: [],
			defaults: {
				model: null,
				contextTokens: null
			},
			recent: [],
			byAgent: summary.sessions.byAgent.map((entry) => ({
				...entry,
				path: "[redacted]",
				recent: []
			}))
		}
	};
}
async function getStatusSummary(options = {}) {
	const { includeSensitive = true, includeChannelSummary = true } = options;
	const { classifySessionKey, resolveConfiguredStatusModelRef, resolveContextTokensForModel, resolveSessionRuntimeLabel, resolveSessionModelRef } = await loadStatusSummaryRuntimeModule();
	const cfg = options.config ?? getRuntimeConfig();
	const channelScopeConfig = options.sourceConfig === void 0 ? { config: cfg } : {
		config: cfg,
		activationSourceConfig: options.sourceConfig
	};
	const needsChannelPlugins = includeChannelSummary && hasConfiguredChannelsForReadOnlyScope(channelScopeConfig);
	const linkContext = needsChannelPlugins ? await loadLinkChannelModule().then(({ resolveLinkChannelContext }) => resolveLinkChannelContext(cfg, { sourceConfig: options.sourceConfig })) : null;
	const agentList = listGatewayAgentsBasic(cfg);
	const heartbeatAgents = agentList.agents.map((agent) => {
		const summary = resolveHeartbeatSummaryForAgent(cfg, agent.id);
		return {
			agentId: agent.id,
			enabled: summary.enabled,
			every: summary.every,
			everyMs: summary.everyMs
		};
	});
	const channelSummary = needsChannelPlugins ? await loadChannelSummaryModule().then(({ buildChannelSummary }) => buildChannelSummary(cfg, {
		colorize: true,
		includeAllowFrom: true,
		sourceConfig: options.sourceConfig
	})) : [];
	const queuedSystemEvents = peekSystemEvents(resolveMainSessionKey(cfg));
	const taskMaintenanceModule = await loadTaskRegistryMaintenanceModule();
	taskMaintenanceModule.configureTaskRegistryMaintenance({ cronStorePath: resolveCronStorePath(cfg.cron?.store) });
	const tasks = taskMaintenanceModule.getInspectableTaskRegistrySummary();
	const taskAudit = taskMaintenanceModule.getInspectableTaskAuditSummary();
	const resolved = resolveConfiguredStatusModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const configModel = resolved.model ?? "gpt-5.5";
	const configContextTokens = resolveContextTokensForModel({
		cfg,
		provider: resolved.provider ?? "openai",
		model: configModel,
		contextTokensOverride: cfg.agents?.defaults?.contextTokens,
		fallbackContextTokens: 2e5,
		allowAsyncLoad: false
	}) ?? 2e5;
	const now = Date.now();
	const storeCache = /* @__PURE__ */ new Map();
	const loadStore = (storePath) => {
		const cached = storeCache.get(storePath);
		if (cached) return cached;
		const store = readSessionStoreReadOnly(storePath);
		storeCache.set(storePath, store);
		return store;
	};
	const buildSessionRows = (store, opts = {}) => Object.entries(store).filter(([key]) => key !== "global" && key !== "unknown").map(([key, entry]) => {
		const updatedAt = entry?.updatedAt ?? null;
		const age = updatedAt ? now - updatedAt : null;
		const parsedAgentId = parseAgentSessionKey(key)?.agentId;
		const agentId = opts.agentIdOverride ?? parsedAgentId;
		const resolvedModel = resolveSessionModelRef(cfg, entry, opts.agentIdOverride);
		const model = resolvedModel.model ?? configModel ?? null;
		const contextTokens = resolveContextTokensForModel({
			cfg,
			provider: resolvedModel.provider,
			model,
			contextTokensOverride: entry?.contextTokens,
			fallbackContextTokens: configContextTokens ?? void 0,
			allowAsyncLoad: false
		}) ?? null;
		const total = resolveSessionTotalTokens(entry);
		const totalTokensFresh = typeof entry?.totalTokens === "number" ? entry?.totalTokensFresh !== false : false;
		const remaining = contextTokens != null && total !== void 0 ? Math.max(0, contextTokens - total) : null;
		const pct = contextTokens && contextTokens > 0 && total !== void 0 ? Math.min(999, Math.round(total / contextTokens * 100)) : null;
		const runtime = resolveSessionRuntimeLabel({
			cfg,
			entry,
			provider: resolvedModel.provider,
			model: model ?? "",
			agentId,
			sessionKey: key
		});
		return {
			agentId,
			key,
			kind: classifySessionKey(key, entry),
			sessionId: entry?.sessionId,
			updatedAt,
			age,
			thinkingLevel: entry?.thinkingLevel,
			fastMode: entry?.fastMode,
			verboseLevel: entry?.verboseLevel,
			traceLevel: entry?.traceLevel,
			reasoningLevel: entry?.reasoningLevel,
			elevatedLevel: entry?.elevatedLevel,
			systemSent: entry?.systemSent,
			abortedLastRun: entry?.abortedLastRun,
			inputTokens: entry?.inputTokens,
			outputTokens: entry?.outputTokens,
			cacheRead: entry?.cacheRead,
			cacheWrite: entry?.cacheWrite,
			totalTokens: total ?? null,
			totalTokensFresh,
			remainingTokens: remaining,
			percentUsed: pct,
			model,
			runtime,
			contextTokens,
			flags: buildFlags(entry)
		};
	}).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	const paths = /* @__PURE__ */ new Set();
	const byAgent = agentList.agents.map((agent) => {
		const storePath = resolveStorePath(cfg.session?.store, { agentId: agent.id });
		paths.add(storePath);
		const sessions = buildSessionRows(loadStore(storePath), { agentIdOverride: agent.id });
		return {
			agentId: agent.id,
			path: storePath,
			count: sessions.length,
			recent: sessions.slice(0, 10)
		};
	});
	const allSessions = Array.from(paths).flatMap((storePath) => buildSessionRows(loadStore(storePath))).toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	const recent = allSessions.slice(0, 10);
	const totalSessions = allSessions.length;
	const summary = {
		runtimeVersion: resolveRuntimeServiceVersion(process.env),
		linkChannel: linkContext ? {
			id: linkContext.plugin.id,
			label: linkContext.plugin.meta.label ?? "Channel",
			linked: linkContext.linked,
			authAgeMs: linkContext.authAgeMs
		} : void 0,
		heartbeat: {
			defaultAgentId: agentList.defaultId,
			agents: heartbeatAgents
		},
		channelSummary,
		queuedSystemEvents,
		tasks,
		taskAudit,
		sessions: {
			paths: Array.from(paths),
			count: totalSessions,
			defaults: {
				model: configModel ?? null,
				contextTokens: configContextTokens ?? null
			},
			recent,
			byAgent
		}
	};
	return includeSensitive ? summary : redactSensitiveStatusSummary(summary);
}
//#endregion
export { redactSensitiveStatusSummary as n, getStatusSummary as t };
