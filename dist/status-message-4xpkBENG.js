import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { C as hasSessionAutoModelFallbackProvenance } from "./agent-scope-CtLXGcWm.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { i as resolveMainSessionKey } from "./main-session-D3q_5w0B.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath } from "./paths-Bg3PO6Gj.js";
import { c as resolveSessionPluginTraceLines, o as resolveFreshSessionTotalTokens, s as resolveSessionPluginStatusLines } from "./types-BgvyBC-3.js";
import "./sessions-CQHHcgC_.js";
import { i as buildModelAliasIndex, v as resolveConfiguredModelRef, x as resolveModelRefFromString } from "./model-selection-shared-ClxdEp4X.js";
import "./model-selection-P-81eBKx.js";
import { s as readRecentSessionUsageFromTranscript } from "./session-utils.fs-CsnHXIqH.js";
import { o as resolveContextTokensForModel } from "./context-L0xQd5wI.js";
import { a as resolveModelCostConfig, n as formatTokenCount$1, r as formatUsd, t as estimateUsageCost } from "./usage-format-BEywPhmZ.js";
import { n as resolveSandboxRuntimeStatus } from "./runtime-status-BtoDvmSR.js";
import { t as resolveCommitHash } from "./git-commit-ZxWO4cFl.js";
import { d as resolveModelAuthMode } from "./model-auth-Db-JGIrg.js";
import { t as areRuntimeModelRefsEquivalent } from "./model-runtime-aliases-D35Lx2no.js";
import { n as findDecisionReason, s as summarizeDecisionReason } from "./runner.entries-CxY7Q-di.js";
import "./sandbox-DiI74XYF.js";
import { y as resolveOpenAITextVerbosity } from "./proxy-stream-wrappers-B-pawBvX.js";
import { i as resolveExtraParams } from "./extra-params-S591BMjA.js";
import { t as resolveChannelModelOverride } from "./model-overrides-CFY_AkZm.js";
import { t as resolveAgentRuntimeLabel } from "./agent-runtime-label-DPvzpWzS.js";
import { n as formatTimeAgo } from "./format-relative-Bjc3l98W.js";
import { n as resolveSelectedAndActiveModel, t as formatProviderModelRef } from "./model-runtime-NSmvD3mm.js";
import { t as resolveActiveFallbackState } from "./fallback-notice-state-FL2GDkL-.js";
import { t as resolveStatusTtsSnapshot } from "./status-config-Cqgj59Dn.js";
import fs from "node:fs";
//#region src/status/status-labels.ts
const formatFastModeLabel = (enabled) => {
	if (!enabled) return null;
	return "Fast";
};
//#endregion
//#region src/status/status-message.ts
const formatTokenCount = formatTokenCount$1;
function normalizeAuthMode(value) {
	const normalized = normalizeOptionalLowercaseString(value);
	if (!normalized) return;
	if (normalized === "api-key" || normalized.startsWith("api-key ")) return "api-key";
	if (normalized === "oauth" || normalized.startsWith("oauth ")) return "oauth";
	if (normalized === "token" || normalized.startsWith("token ")) return "token";
	if (normalized === "aws-sdk" || normalized.startsWith("aws-sdk ")) return "aws-sdk";
	if (normalized === "mixed" || normalized.startsWith("mixed ")) return "mixed";
	if (normalized === "unknown") return "unknown";
}
function resolveConfiguredTextVerbosity(params) {
	const provider = params.provider?.trim();
	const model = params.model?.trim();
	if (!provider || !model || provider !== "openai" && provider !== "openai-codex") return;
	return resolveOpenAITextVerbosity(resolveExtraParams({
		cfg: params.config,
		provider,
		modelId: model,
		agentId: params.agentId
	}));
}
function resolveExecutionLabel(args) {
	const sessionKey = args.sessionKey?.trim();
	if (args.config && sessionKey) {
		const runtimeStatus = resolveSandboxRuntimeStatus({
			cfg: args.config,
			sessionKey
		});
		const sandboxMode = runtimeStatus.mode ?? "off";
		if (sandboxMode === "off") return "direct";
		return `${runtimeStatus.sandboxed ? "docker" : sessionKey ? "direct" : "unknown"}/${sandboxMode}`;
	}
	const sandboxMode = args.agent?.sandbox?.mode ?? "off";
	if (sandboxMode === "off") return "direct";
	return `${(() => {
		if (!sessionKey) return false;
		if (sandboxMode === "all") return true;
		if (args.config) return resolveSandboxRuntimeStatus({
			cfg: args.config,
			sessionKey
		}).sandboxed;
		return sessionKey !== resolveMainSessionKey({ session: { scope: args.sessionScope ?? "per-sender" } }).trim();
	})() ? "docker" : sessionKey ? "direct" : "unknown"}/${sandboxMode}`;
}
const formatTokens = (total, contextTokens) => {
	const ctx = contextTokens ?? null;
	if (total == null) return `?/${ctx ? formatTokenCount(ctx) : "?"}`;
	const pct = ctx ? Math.min(999, Math.round(total / ctx * 100)) : null;
	return `${formatTokenCount(total)}/${ctx ? formatTokenCount(ctx) : "?"}${pct !== null ? ` (${pct}%)` : ""}`;
};
const formatContextUsageShort = (total, contextTokens) => `Context ${formatTokens(total, contextTokens ?? null)}`;
const formatQueueDetails = (queue) => {
	if (!queue) return "";
	const depth = typeof queue.depth === "number" ? `depth ${queue.depth}` : null;
	if (!queue.showDetails) return depth ? ` (${depth})` : "";
	const detailParts = [];
	if (depth) detailParts.push(depth);
	if (typeof queue.debounceMs === "number") {
		const ms = Math.max(0, Math.round(queue.debounceMs));
		const label = ms >= 1e3 ? `${ms % 1e3 === 0 ? ms / 1e3 : (ms / 1e3).toFixed(1)}s` : `${ms}ms`;
		detailParts.push(`debounce ${label}`);
	}
	if (typeof queue.cap === "number") detailParts.push(`cap ${queue.cap}`);
	if (queue.dropPolicy) detailParts.push(`drop ${queue.dropPolicy}`);
	return detailParts.length ? ` (${detailParts.join(" · ")})` : "";
};
const readUsageFromSessionLog = (sessionId, sessionEntry, agentId, sessionKey, storePath) => {
	if (!sessionId) return;
	let logPath;
	try {
		logPath = resolveSessionFilePath(sessionId, sessionEntry, resolveSessionFilePathOptions({
			agentId: agentId ?? (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : void 0),
			storePath
		}));
	} catch {
		return;
	}
	if (!fs.existsSync(logPath)) return;
	try {
		const snapshot = readRecentSessionUsageFromTranscript(sessionId, storePath, sessionEntry?.sessionFile, agentId ?? (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : void 0), 256 * 1024);
		if (!snapshot) return;
		const input = snapshot.inputTokens ?? 0;
		const output = snapshot.outputTokens ?? 0;
		const cacheRead = snapshot.cacheRead ?? 0;
		const cacheWrite = snapshot.cacheWrite ?? 0;
		const promptTokens = snapshot.totalTokens ?? input + cacheRead + cacheWrite;
		const total = promptTokens + output;
		if (promptTokens === 0 && total === 0) return;
		return {
			input,
			output,
			cacheRead,
			cacheWrite,
			promptTokens,
			total,
			model: snapshot.modelProvider ? snapshot.model ? `${snapshot.modelProvider}/${snapshot.model}` : snapshot.modelProvider : snapshot.model
		};
	} catch {
		return;
	}
};
const formatUsagePair = (input, output) => {
	if (input == null && output == null) return null;
	return `🧮 Tokens: ${typeof input === "number" ? formatTokenCount(input) : "?"} in / ${typeof output === "number" ? formatTokenCount(output) : "?"} out`;
};
const formatCacheLine = (input, cacheRead, cacheWrite) => {
	if (!cacheRead && !cacheWrite) return null;
	if ((typeof cacheRead !== "number" || cacheRead <= 0) && (typeof cacheWrite !== "number" || cacheWrite <= 0)) return null;
	const cachedLabel = typeof cacheRead === "number" ? formatTokenCount(cacheRead) : "0";
	const newLabel = typeof cacheWrite === "number" ? formatTokenCount(cacheWrite) : "0";
	const totalInput = (typeof cacheRead === "number" ? cacheRead : 0) + (typeof cacheWrite === "number" ? cacheWrite : 0) + (typeof input === "number" ? input : 0);
	return `🗄️ Cache: ${totalInput > 0 && typeof cacheRead === "number" ? Math.round(cacheRead / totalInput * 100) : 0}% hit · ${cachedLabel} cached, ${newLabel} new`;
};
const formatMediaUnderstandingLine = (decisions) => {
	if (!decisions || decisions.length === 0) return null;
	const parts = decisions.map((decision) => {
		const count = decision.attachments.length;
		const countLabel = count > 1 ? ` x${count}` : "";
		if (decision.outcome === "success") {
			const chosen = decision.attachments.find((entry) => entry.chosen)?.chosen;
			const provider = chosen?.provider?.trim();
			const model = chosen?.model?.trim();
			const modelLabel = provider ? model ? `${provider}/${model}` : provider : null;
			return `${decision.capability}${countLabel} ok${modelLabel ? ` (${modelLabel})` : ""}`;
		}
		if (decision.outcome === "no-attachment") return `${decision.capability} none`;
		if (decision.outcome === "disabled") return `${decision.capability} off`;
		if (decision.outcome === "scope-deny") return `${decision.capability} denied`;
		if (decision.outcome === "skipped") {
			const shortReason = summarizeDecisionReason(findDecisionReason(decision));
			return `${decision.capability} skipped${shortReason ? ` (${shortReason})` : ""}`;
		}
		if (decision.outcome === "failed") {
			const shortReason = summarizeDecisionReason(findDecisionReason(decision, "failed"));
			return `${decision.capability} failed${shortReason ? ` (${shortReason})` : ""}`;
		}
		return null;
	}).filter((part) => part != null);
	if (parts.length === 0) return null;
	if (parts.every((part) => part.endsWith(" none"))) return null;
	return `📎 Media: ${parts.join(" · ")}`;
};
const formatVoiceModeLine = (config, sessionEntry, agentId) => {
	if (!config) return null;
	const snapshot = resolveStatusTtsSnapshot({
		cfg: config,
		sessionAuto: sessionEntry?.ttsAuto,
		agentId
	});
	if (!snapshot) return null;
	const parts = [`🔊 Voice: ${snapshot.autoMode}`, `provider=${snapshot.provider}`];
	if (snapshot.persona) parts.push(`persona=${snapshot.persona}`);
	if (snapshot.displayName) parts.push(`name=${snapshot.displayName}`);
	if (snapshot.model) parts.push(`model=${snapshot.model}`);
	if (snapshot.voice) parts.push(`voice=${snapshot.voice}`);
	if (snapshot.baseUrl) parts.push(snapshot.customBaseUrl ? `endpoint=custom(${snapshot.baseUrl})` : `endpoint=${snapshot.baseUrl}`);
	parts.push(`limit=${snapshot.maxLength}`, `summary=${snapshot.summarize ? "on" : "off"}`);
	return parts.join(" · ");
};
function resolveChannelModelNote(params) {
	if (!params.config || !params.entry) return;
	if (normalizeOptionalString(params.entry.modelOverride) || normalizeOptionalString(params.entry.providerOverride)) return;
	const channelOverride = resolveChannelModelOverride({
		cfg: params.config,
		channel: params.entry.channel ?? params.entry.origin?.provider,
		groupId: params.entry.groupId,
		groupChatType: params.entry.chatType ?? params.entry.origin?.chatType,
		groupChannel: params.entry.groupChannel,
		groupSubject: params.entry.subject,
		parentSessionKey: params.parentSessionKey
	});
	if (!channelOverride) return;
	const aliasIndex = buildModelAliasIndex({
		cfg: params.config,
		defaultProvider: DEFAULT_PROVIDER,
		allowPluginNormalization: false
	});
	const resolvedOverride = resolveModelRefFromString({
		raw: channelOverride.model,
		defaultProvider: DEFAULT_PROVIDER,
		aliasIndex,
		allowPluginNormalization: false
	});
	if (!resolvedOverride) return;
	if (resolvedOverride.ref.provider !== params.selectedProvider || resolvedOverride.ref.model !== params.selectedModel) return;
	return "channel override";
}
function hasUserPinnedModelSelection(entry) {
	if (!entry?.modelOverride) return false;
	if (entry.modelOverrideSource === "user") return true;
	if (entry.modelOverrideSource === "auto") return false;
	return !hasSessionAutoModelFallbackProvenance(entry);
}
function buildStatusMessage(args) {
	const now = args.now ?? Date.now();
	const entry = args.sessionEntry;
	const selectionConfig = { agents: { defaults: args.agent ?? {} } };
	const contextConfig = args.config ? {
		...args.config,
		agents: {
			...args.config.agents,
			defaults: {
				...args.config.agents?.defaults,
				...args.agent
			}
		}
	} : { agents: { defaults: args.agent ?? {} } };
	const resolved = resolveConfiguredModelRef({
		cfg: selectionConfig,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL,
		allowPluginNormalization: false
	});
	const selectedProvider = entry?.providerOverride ?? resolved.provider ?? "openai";
	const selectedModel = entry?.modelOverride ?? resolved.model ?? "gpt-5.5";
	const modelRefs = resolveSelectedAndActiveModel({
		selectedProvider,
		selectedModel,
		sessionEntry: entry
	});
	const initialFallbackState = resolveActiveFallbackState({
		selectedModelRef: modelRefs.selected.label || "unknown",
		activeModelRef: modelRefs.active.label || "unknown",
		state: entry
	});
	let activeProvider = modelRefs.active.provider;
	let activeModel = modelRefs.active.model;
	let contextLookupProvider = activeProvider;
	let contextLookupModel = activeModel;
	const runtimeModelRaw = normalizeOptionalString(entry?.model) ?? "";
	const runtimeProviderRaw = normalizeOptionalString(entry?.modelProvider) ?? "";
	if (runtimeModelRaw && !runtimeProviderRaw && runtimeModelRaw.includes("/")) {
		const slashIndex = runtimeModelRaw.indexOf("/");
		const embeddedProvider = normalizeOptionalLowercaseString(runtimeModelRaw.slice(0, slashIndex)) ?? "";
		const fallbackMatchesRuntimeModel = initialFallbackState.active && normalizeLowercaseStringOrEmpty(runtimeModelRaw) === normalizeLowercaseStringOrEmpty(normalizeOptionalString(entry?.fallbackNoticeActiveModel ?? "") ?? "");
		const runtimeMatchesSelectedModel = normalizeLowercaseStringOrEmpty(runtimeModelRaw) === normalizeLowercaseStringOrEmpty(modelRefs.selected.label || "unknown");
		if ((fallbackMatchesRuntimeModel || runtimeMatchesSelectedModel) && embeddedProvider === normalizeLowercaseStringOrEmpty(activeProvider)) {
			contextLookupProvider = activeProvider;
			contextLookupModel = activeModel;
		} else {
			contextLookupProvider = void 0;
			contextLookupModel = runtimeModelRaw;
		}
	}
	let inputTokens = entry?.inputTokens;
	let outputTokens = entry?.outputTokens;
	let cacheRead = entry?.cacheRead;
	let cacheWrite = entry?.cacheWrite;
	const freshTotalTokens = resolveFreshSessionTotalTokens(entry);
	const allowTranscriptContextUsage = entry?.totalTokensFresh !== false;
	let totalTokens = freshTotalTokens ?? (entry?.totalTokensFresh === false ? void 0 : entry?.totalTokens ?? (entry?.inputTokens ?? 0) + (entry?.outputTokens ?? 0));
	if (args.includeTranscriptUsage) {
		const logUsage = readUsageFromSessionLog(entry?.sessionId, entry, args.agentId, args.sessionKey, args.sessionStorePath);
		if (logUsage) {
			const candidate = logUsage.promptTokens || logUsage.total;
			if (allowTranscriptContextUsage && (!totalTokens || totalTokens === 0 || candidate > totalTokens)) totalTokens = candidate;
			if (!entry?.model && logUsage.model) {
				const slashIndex = logUsage.model.indexOf("/");
				if (slashIndex > 0) {
					const provider = logUsage.model.slice(0, slashIndex).trim();
					const model = logUsage.model.slice(slashIndex + 1).trim();
					if (provider && model) {
						activeProvider = provider;
						activeModel = model;
						contextLookupProvider = void 0;
						contextLookupModel = logUsage.model;
					}
				} else {
					activeModel = logUsage.model;
					contextLookupProvider = activeProvider;
					contextLookupModel = logUsage.model;
				}
			}
			if (!inputTokens || inputTokens === 0) inputTokens = logUsage.input;
			if (!outputTokens || outputTokens === 0) outputTokens = logUsage.output;
			if (typeof cacheRead !== "number" || cacheRead <= 0) cacheRead = logUsage.cacheRead;
			if (typeof cacheWrite !== "number" || cacheWrite <= 0) cacheWrite = logUsage.cacheWrite;
		}
	}
	const activeModelLabel = formatProviderModelRef(activeProvider, activeModel) || "unknown";
	const runtimeDiffersFromSelected = activeModelLabel !== (modelRefs.selected.label || "unknown");
	const selectedContextTokens = resolveContextTokensForModel({
		cfg: contextConfig,
		provider: selectedProvider,
		model: selectedModel,
		allowAsyncLoad: false
	});
	const explicitRuntimeContextTokens = typeof args.runtimeContextTokens === "number" && args.runtimeContextTokens > 0 ? args.runtimeContextTokens : void 0;
	const resolvedActiveContextTokens = resolveContextTokensForModel({
		cfg: contextConfig,
		...contextLookupProvider ? { provider: contextLookupProvider } : {},
		model: contextLookupModel,
		allowAsyncLoad: false
	});
	const activeContextTokens = typeof explicitRuntimeContextTokens === "number" && typeof resolvedActiveContextTokens === "number" ? Math.min(explicitRuntimeContextTokens, resolvedActiveContextTokens) : explicitRuntimeContextTokens ?? resolvedActiveContextTokens;
	const channelModelNote = resolveChannelModelNote({
		config: args.config,
		entry,
		selectedProvider,
		selectedModel,
		parentSessionKey: args.parentSessionKey
	});
	const persistedContextTokens = typeof entry?.contextTokens === "number" && entry.contextTokens > 0 ? entry.contextTokens : void 0;
	const cappedPersistedContextTokens = typeof persistedContextTokens === "number" && typeof activeContextTokens === "number" ? Math.min(persistedContextTokens, activeContextTokens) : persistedContextTokens;
	const agentContextTokens = typeof args.agent?.contextTokens === "number" && args.agent.contextTokens > 0 ? args.agent.contextTokens : void 0;
	const explicitConfiguredContextTokens = typeof args.explicitConfiguredContextTokens === "number" && args.explicitConfiguredContextTokens > 0 ? args.explicitConfiguredContextTokens : void 0;
	const cappedConfiguredContextTokens = typeof explicitConfiguredContextTokens === "number" ? typeof activeContextTokens === "number" ? Math.min(explicitConfiguredContextTokens, activeContextTokens) : explicitConfiguredContextTokens : void 0;
	const cappedAgentContextTokens = typeof agentContextTokens === "number" ? typeof activeContextTokens === "number" ? Math.min(agentContextTokens, activeContextTokens) : agentContextTokens : void 0;
	const channelOverrideContextTokens = channelModelNote ? explicitRuntimeContextTokens ?? cappedConfiguredContextTokens ?? (typeof activeContextTokens === "number" ? cappedAgentContextTokens ?? activeContextTokens : cappedAgentContextTokens) : void 0;
	const contextTokens = runtimeDiffersFromSelected ? explicitRuntimeContextTokens ?? (() => {
		if (persistedContextTokens !== void 0) {
			if (typeof selectedContextTokens === "number" && persistedContextTokens === selectedContextTokens && typeof selectedContextTokens === "number" && typeof activeContextTokens === "number" && activeContextTokens !== selectedContextTokens && !(typeof explicitConfiguredContextTokens === "number" && explicitConfiguredContextTokens === persistedContextTokens)) return activeContextTokens;
			if (typeof activeContextTokens === "number") return Math.min(persistedContextTokens, activeContextTokens);
			return persistedContextTokens;
		}
		if (cappedConfiguredContextTokens !== void 0) return cappedConfiguredContextTokens;
		if (typeof activeContextTokens === "number") return activeContextTokens;
		return 2e5;
	})() : resolveContextTokensForModel({
		cfg: contextConfig,
		...contextLookupProvider ? { provider: contextLookupProvider } : {},
		model: contextLookupModel,
		contextTokensOverride: channelOverrideContextTokens ?? cappedPersistedContextTokens ?? cappedConfiguredContextTokens ?? cappedAgentContextTokens ?? explicitRuntimeContextTokens,
		fallbackContextTokens: 2e5,
		allowAsyncLoad: false
	}) ?? 2e5;
	const thinkLevel = args.resolvedThink ?? args.sessionEntry?.thinkingLevel ?? args.agent?.thinkingDefault ?? "off";
	const verboseLevel = args.resolvedVerbose ?? args.sessionEntry?.verboseLevel ?? args.agent?.verboseDefault ?? "off";
	const fastMode = args.resolvedFast ?? args.sessionEntry?.fastMode ?? false;
	const reasoningLevel = args.resolvedReasoning ?? args.sessionEntry?.reasoningLevel ?? args.agent?.reasoningDefault ?? "off";
	const elevatedLevel = args.resolvedElevated ?? args.sessionEntry?.elevatedLevel ?? args.agent?.elevatedDefault ?? "on";
	const execution = { label: resolveExecutionLabel(args) };
	const agentRuntimeLabel = resolveAgentRuntimeLabel({
		config: args.config,
		sessionEntry: args.sessionEntry,
		resolvedHarness: args.resolvedHarness,
		fallbackProvider: activeProvider
	});
	const updatedAt = entry?.updatedAt;
	const sessionLine = [`Session: ${args.sessionKey ?? "unknown"}`, typeof updatedAt === "number" ? `updated ${formatTimeAgo(now - updatedAt)}` : "no activity"].filter(Boolean).join(" • ");
	const groupActivationValue = entry?.chatType === "group" || entry?.chatType === "channel" || Boolean(args.sessionKey?.includes(":group:")) || Boolean(args.sessionKey?.includes(":channel:")) ? args.groupActivation ?? entry?.groupActivation ?? "mention" : void 0;
	const contextLine = [`Context: ${formatTokens(totalTokens, contextTokens ?? null)}`, `🧹 Compactions: ${entry?.compactionCount ?? 0}`].filter(Boolean).join(" · ");
	const queueMode = args.queue?.mode ?? "unknown";
	const queueDetails = formatQueueDetails(args.queue);
	const verboseLabel = verboseLevel === "full" ? "verbose:full" : verboseLevel === "on" ? "verbose" : null;
	const traceLevel = entry?.traceLevel === "raw" ? "raw" : entry?.traceLevel === "on" ? "on" : "off";
	const traceLabel = traceLevel === "raw" ? "trace:raw" : traceLevel === "on" ? "trace" : null;
	const pluginStatusLines = verboseLevel !== "off" ? resolveSessionPluginStatusLines(entry) : [];
	const pluginTraceLines = traceLevel === "on" || traceLevel === "raw" ? resolveSessionPluginTraceLines(entry) : [];
	const pluginStatusLine = pluginStatusLines.length > 0 || pluginTraceLines.length > 0 ? [...pluginStatusLines, ...pluginTraceLines].join(" · ") : null;
	const elevatedLabel = elevatedLevel && elevatedLevel !== "off" ? elevatedLevel === "on" ? "elevated" : `elevated:${elevatedLevel}` : null;
	const textVerbosity = resolveConfiguredTextVerbosity({
		config: args.config,
		agentId: args.agentId,
		provider: activeProvider,
		model: activeModel
	});
	const optionsLine = [
		`Execution: ${execution.label}`,
		`Runtime: ${agentRuntimeLabel}`,
		`Think: ${thinkLevel}`,
		formatFastModeLabel(fastMode),
		textVerbosity ? `Text: ${textVerbosity}` : null,
		verboseLabel,
		traceLabel,
		reasoningLevel !== "off" ? `Reasoning: ${reasoningLevel}` : null,
		elevatedLabel
	].filter(Boolean).join(" · ");
	const activationLine = [groupActivationValue ? `👥 Activation: ${groupActivationValue}` : null, `🪢 Queue: ${queueMode}${queueDetails}`].filter(Boolean).join(" · ");
	const selectedModelLabel = modelRefs.selected.label || "unknown";
	const runtimeAliasModelEquivalent = areRuntimeModelRefsEquivalent(selectedModelLabel, activeModelLabel);
	const selectedAuthMode = normalizeAuthMode(args.modelAuth) ?? resolveModelAuthMode(selectedProvider, args.config);
	const rawSelectedAuthLabelValue = selectedAuthMode && selectedAuthMode !== "unknown" ? args.modelAuth ?? selectedAuthMode : void 0;
	const activeAuthMode = normalizeAuthMode(args.activeModelAuth) ?? resolveModelAuthMode(activeProvider, args.config);
	const activeAuthLabelValue = activeAuthMode && activeAuthMode !== "unknown" ? args.activeModelAuth ?? activeAuthMode : void 0;
	const selectedAuthLabelValue = rawSelectedAuthLabelValue ?? (runtimeAliasModelEquivalent ? activeAuthLabelValue : void 0);
	const fallbackState = resolveActiveFallbackState({
		selectedModelRef: selectedModelLabel,
		activeModelRef: activeModelLabel,
		state: entry
	});
	const effectiveCostAuthMode = fallbackState.active ? activeAuthMode : selectedAuthMode ?? activeAuthMode;
	const showCost = effectiveCostAuthMode === "api-key" || effectiveCostAuthMode === "mixed";
	const hasUsage = typeof inputTokens === "number" || typeof outputTokens === "number";
	const costConfig = showCost && hasUsage ? resolveModelCostConfig({
		provider: activeProvider,
		model: activeModel,
		config: args.config,
		allowPluginNormalization: false
	}) : void 0;
	const cost = showCost && hasUsage ? estimateUsageCost({
		usage: {
			input: inputTokens ?? void 0,
			output: outputTokens ?? void 0
		},
		cost: costConfig
	}) : void 0;
	const costLabel = showCost && hasUsage ? formatUsd(cost) : void 0;
	const selectedAuthLabel = selectedAuthLabelValue ? ` · 🔑 ${selectedAuthLabelValue}` : "";
	const modelNote = channelModelNote ? ` · ${channelModelNote}` : "";
	const configuredDefaultModelLabel = normalizeOptionalString(args.configuredDefaultModelLabel);
	const modelLines = hasUserPinnedModelSelection(entry) && configuredDefaultModelLabel && selectedModelLabel !== configuredDefaultModelLabel && !areRuntimeModelRefsEquivalent(selectedModelLabel, configuredDefaultModelLabel) ? [
		`🧠 Configured default: ${configuredDefaultModelLabel}`,
		`📌 Session selected: ${selectedModelLabel}${selectedAuthLabel}${modelNote}`,
		"⚠️ Reason: session override",
		`⚠️ This session is pinned to ${selectedModelLabel}; config primary ${configuredDefaultModelLabel} will apply to new/unpinned sessions.`,
		`↩️ Clear with: /model ${configuredDefaultModelLabel} or /reset`,
		"📖 Docs: https://docs.openclaw.ai/concepts/models#selection-source-and-fallback-behavior"
	] : [`🧠 Model: ${selectedModelLabel}${selectedAuthLabel}${modelNote}`];
	const configuredFallbacks = (() => {
		const modelConfig = args.agent?.model;
		if (typeof modelConfig === "object" && modelConfig && Array.isArray(modelConfig.fallbacks)) return modelConfig.fallbacks;
	})();
	const configuredFallbacksLine = configuredFallbacks?.length ? `🔄 Fallbacks: ${configuredFallbacks.join(", ")}` : null;
	const showFallbackAuth = activeAuthLabelValue && activeAuthLabelValue !== selectedAuthLabelValue;
	const fallbackLine = fallbackState.active ? `↪️ Fallback: ${activeModelLabel}${showFallbackAuth ? ` · 🔑 ${activeAuthLabelValue}` : ""} (${fallbackState.reason ?? "selected model unavailable"})` : null;
	const commit = resolveCommitHash({ moduleUrl: import.meta.url });
	const versionLine = `🦞 OpenClaw ${VERSION}${commit ? ` (${commit})` : ""}`;
	const usagePair = formatUsagePair(inputTokens, outputTokens);
	const cacheLine = formatCacheLine(inputTokens, cacheRead, cacheWrite);
	const costLine = costLabel ? `💵 Cost: ${costLabel}` : null;
	const usageCostLine = usagePair && costLine ? `${usagePair} · ${costLine}` : usagePair ?? costLine;
	const mediaLine = formatMediaUnderstandingLine(args.mediaDecisions);
	const voiceLine = formatVoiceModeLine(args.config, args.sessionEntry, args.agentId);
	return [
		versionLine,
		args.timeLine,
		args.uptimeLine,
		...modelLines,
		configuredFallbacksLine,
		fallbackLine,
		usageCostLine,
		cacheLine,
		`📚 ${contextLine}`,
		mediaLine,
		args.usageLine,
		`🧵 ${sessionLine}`,
		args.subagentsLine,
		args.taskLine,
		`⚙️ ${optionsLine}`,
		pluginStatusLine ? `🧩 ${pluginStatusLine}` : null,
		voiceLine,
		activationLine
	].filter(Boolean).join("\n");
}
//#endregion
export { formatContextUsageShort as n, formatTokenCount as r, buildStatusMessage as t };
