import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { o as toAgentModelListLike } from "./model-input-ChW9XXsQ.js";
import { _ as resolveSessionAgentId, u as resolveAgentModelFallbacksOverride } from "./agent-scope-CtLXGcWm.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir, r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { a as listOpenAIAuthProfileProvidersForAgentRuntime } from "./openai-codex-routing-DwRY-_VI.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { n as formatTaskStatusDetail, r as formatTaskStatusTitle, t as buildTaskStatusSnapshot } from "./task-status-BvwcU8qI.js";
import { o as resolveContextTokensForModel } from "./context-L0xQd5wI.js";
import { t as formatDurationCompact } from "./format-duration-BrZ-AaEJ.js";
import { c as resolveMainSessionAlias, s as resolveInternalSessionKey } from "./sessions-helpers-AhiZZPDz.js";
import { t as areRuntimeModelRefsEquivalent } from "./model-runtime-aliases-D35Lx2no.js";
import { t as normalizeGroupActivation } from "./group-activation-BxkIP-sT.js";
import { t as resolveFastModeState } from "./fast-mode-Dkm9UASH.js";
import { t as resolveModelAuthLabel } from "./model-auth-label-ByocD3Wn.js";
import { o as resolveUsageProviderId } from "./provider-usage.shared-Dk5t9Xpy.js";
import { n as resolveSelectedAndActiveModel } from "./model-runtime-NSmvD3mm.js";
import { i as formatUsageWindowSummary, t as loadProviderUsageSummary } from "./provider-usage-Ccwl6xqF.js";
import { n as listTasksForAgentIdForStatus, r as listTasksForSessionKeyForStatus } from "./task-status-access-C4wDBrvB.js";
import os from "node:os";
//#region src/status/status-text.ts
const USAGE_OAUTH_ONLY_PROVIDERS = new Set([
	"anthropic",
	"github-copilot",
	"google-gemini-cli",
	"openai-codex"
]);
let statusMessageRuntimePromise = null;
let agentHarnessSelectionRuntimePromise = null;
let statusQueueRuntimePromise = null;
let statusSubagentsRuntimePromise = null;
function loadStatusMessageRuntime() {
	return statusMessageRuntimePromise ??= import("./status-message.runtime.js").then((module) => module.loadStatusMessageRuntimeModule());
}
function loadAgentHarnessSelectionRuntime() {
	return agentHarnessSelectionRuntimePromise ??= import("./selection-CW6mLrWk.js");
}
function loadStatusSubagentsRuntime() {
	return statusSubagentsRuntimePromise ??= import("./status-subagents.runtime.js");
}
function loadStatusQueueRuntime() {
	return statusQueueRuntimePromise ??= import("./status-queue.runtime.js");
}
function resolveStatusRuntimeContextTokens(params) {
	return resolveContextTokensForModel({
		cfg: params.cfg,
		provider: params.provider,
		model: params.model,
		allowAsyncLoad: false
	});
}
function shouldLoadUsageSummary(params) {
	if (!params.provider) return false;
	if (!USAGE_OAUTH_ONLY_PROVIDERS.has(params.provider)) return true;
	const auth = normalizeOptionalLowercaseString(params.selectedModelAuth);
	return Boolean(auth?.startsWith("oauth") || auth?.startsWith("token"));
}
function formatSessionTaskLine(sessionKey) {
	const snapshot = buildTaskStatusSnapshot(listTasksForSessionKeyForStatus(sessionKey));
	const task = snapshot.focus;
	if (!task) return;
	const headline = snapshot.activeCount > 0 ? `${snapshot.activeCount} active · ${snapshot.totalCount} total` : snapshot.recentFailureCount > 0 ? `${snapshot.recentFailureCount} recent failure${snapshot.recentFailureCount === 1 ? "" : "s"}` : "recently finished";
	const title = formatTaskStatusTitle(task);
	const detail = formatTaskStatusDetail(task);
	const parts = [
		headline,
		task.runtime,
		title,
		detail
	].filter(Boolean);
	return parts.length ? `📌 Tasks: ${parts.join(" · ")}` : void 0;
}
async function resolveStatusHarnessId(params) {
	try {
		const { selectAgentHarness } = await loadAgentHarnessSelectionRuntime();
		return normalizeOptionalLowercaseString(selectAgentHarness({
			provider: params.provider,
			modelId: params.model,
			config: params.cfg,
			agentId: params.agentId,
			sessionKey: params.sessionKey,
			agentHarnessId: params.sessionEntry?.agentHarnessId
		}).id) || void 0;
	} catch {
		return;
	}
}
function resolveStatusRuntimeProvider(params) {
	const harness = normalizeOptionalLowercaseString(params.effectiveHarness);
	const provider = normalizeOptionalLowercaseString(params.provider);
	if (harness === "codex" && provider === "openai") return "openai-codex";
	if (harness === "claude-cli" && provider === "anthropic") return "claude-cli";
	return params.provider;
}
function formatAgentTaskCountsLine(agentId) {
	const snapshot = buildTaskStatusSnapshot(listTasksForAgentIdForStatus(agentId));
	if (snapshot.totalCount === 0) return;
	return `📌 Tasks: ${snapshot.activeCount} active · ${snapshot.totalCount} total · agent-local`;
}
function formatStatusUptimeDuration(ms) {
	return formatDurationCompact(ms, { spaced: true }) ?? "0s";
}
function buildStatusUptimeLine() {
	const gatewayUptimeMs = Math.max(0, Math.round(process.uptime() * 1e3));
	const systemUptimeMs = Math.max(0, Math.round(os.uptime() * 1e3));
	return `⏱️ Uptime: gateway ${formatStatusUptimeDuration(gatewayUptimeMs)} · system ${formatStatusUptimeDuration(systemUptimeMs)}`;
}
async function buildStatusText(params) {
	const { cfg, sessionEntry, sessionKey, parentSessionKey, sessionScope, storePath, statusChannel, provider, model, contextTokens, resolvedThinkLevel, resolvedFastMode, resolvedVerboseLevel, resolvedReasoningLevel, resolvedElevatedLevel, resolveDefaultThinkingLevel, isGroup, defaultGroupActivation } = params;
	const statusAgentId = sessionKey ? resolveSessionAgentId({
		sessionKey,
		config: cfg
	}) : resolveDefaultAgentId(cfg);
	const statusAgentDir = resolveAgentDir(cfg, statusAgentId);
	const statusWorkspaceDir = params.workspaceDir ?? sessionEntry?.spawnedWorkspaceDir ?? resolveAgentWorkspaceDir(cfg, statusAgentId);
	const modelRefs = resolveSelectedAndActiveModel({
		selectedProvider: provider,
		selectedModel: model,
		sessionEntry
	});
	const effectiveHarness = params.resolvedHarness ?? await resolveStatusHarnessId({
		cfg,
		provider,
		model,
		agentId: statusAgentId,
		sessionKey,
		sessionEntry
	});
	const selectedStatusProvider = resolveStatusRuntimeProvider({
		provider,
		effectiveHarness
	});
	const selectedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
		provider,
		harnessRuntime: effectiveHarness,
		config: cfg
	});
	const activeProvider = modelRefs.active.provider || provider;
	const activeStatusProvider = resolveStatusRuntimeProvider({
		provider: activeProvider,
		effectiveHarness
	});
	const activeAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
		provider: activeProvider,
		harnessRuntime: effectiveHarness,
		config: cfg
	});
	let selectedModelAuth = Object.hasOwn(params, "modelAuthOverride") ? params.modelAuthOverride : resolveModelAuthLabel({
		provider: selectedStatusProvider,
		acceptedProviderIds: selectedAuthProviders,
		cfg,
		sessionEntry,
		agentDir: statusAgentDir,
		workspaceDir: statusWorkspaceDir,
		includeExternalProfiles: false
	});
	const activeModelAuth = Object.hasOwn(params, "activeModelAuthOverride") ? params.activeModelAuthOverride : modelRefs.activeDiffers ? resolveModelAuthLabel({
		provider: activeStatusProvider,
		acceptedProviderIds: activeAuthProviders,
		cfg,
		sessionEntry,
		agentDir: statusAgentDir,
		workspaceDir: statusWorkspaceDir,
		includeExternalProfiles: false
	}) : selectedModelAuth;
	if (areRuntimeModelRefsEquivalent(modelRefs.selected.label, modelRefs.active.label) && normalizeOptionalLowercaseString(selectedModelAuth) === "unknown" && activeModelAuth && normalizeOptionalLowercaseString(activeModelAuth) !== "unknown") selectedModelAuth = activeModelAuth;
	const usageAuthLabel = modelRefs.activeDiffers ? activeModelAuth : selectedModelAuth;
	const currentUsageProvider = resolveUsageProviderId(activeStatusProvider) ?? resolveUsageProviderId(activeProvider);
	let usageLine = null;
	if (currentUsageProvider && shouldLoadUsageSummary({
		provider: currentUsageProvider,
		selectedModelAuth: usageAuthLabel
	})) try {
		const usageSummaryTimeoutMs = 3500;
		let usageTimeout;
		const usageEntry = (await Promise.race([loadProviderUsageSummary({
			timeoutMs: usageSummaryTimeoutMs,
			providers: [currentUsageProvider],
			agentDir: statusAgentDir
		}), new Promise((_, reject) => {
			usageTimeout = setTimeout(() => reject(/* @__PURE__ */ new Error("usage summary timeout")), usageSummaryTimeoutMs);
		})]).finally(() => {
			if (usageTimeout) clearTimeout(usageTimeout);
		})).providers[0];
		if (usageEntry && !usageEntry.error && usageEntry.windows.length > 0) {
			const summaryLine = formatUsageWindowSummary(usageEntry, {
				now: Date.now(),
				maxWindows: 2,
				includeResets: true
			});
			if (summaryLine) usageLine = `📊 Usage: ${summaryLine}`;
		}
	} catch {
		usageLine = null;
	}
	const { getFollowupQueueDepth, resolveQueueSettings } = await loadStatusQueueRuntime();
	const queueSettings = resolveQueueSettings({
		cfg,
		channel: statusChannel,
		sessionEntry
	});
	const queueKey = sessionKey ?? sessionEntry?.sessionId;
	const queueDepth = queueKey ? getFollowupQueueDepth(queueKey) : 0;
	const queueOverrides = Boolean(sessionEntry?.queueDebounceMs ?? sessionEntry?.queueCap ?? sessionEntry?.queueDrop);
	let subagentsLine;
	let taskLine;
	if (sessionKey) {
		const { mainKey, alias } = resolveMainSessionAlias(cfg);
		const requesterKey = resolveInternalSessionKey({
			key: sessionKey,
			alias,
			mainKey
		});
		taskLine = params.skipDefaultTaskLookup ? params.taskLineOverride : params.taskLineOverride ?? formatSessionTaskLine(requesterKey);
		if (!taskLine && !params.skipDefaultTaskLookup) taskLine = formatAgentTaskCountsLine(statusAgentId);
		const { buildSubagentsStatusLine, countPendingDescendantRuns, listControlledSubagentRuns } = await loadStatusSubagentsRuntime();
		subagentsLine = buildSubagentsStatusLine({
			runs: listControlledSubagentRuns(requesterKey),
			verboseEnabled: resolvedVerboseLevel && resolvedVerboseLevel !== "off",
			pendingDescendantsForRun: (entry) => countPendingDescendantRuns(entry.childSessionKey)
		});
	}
	const groupActivation = isGroup ? normalizeGroupActivation(sessionEntry?.groupActivation) ?? defaultGroupActivation() : void 0;
	const agentDefaults = cfg.agents?.defaults ?? {};
	const agentConfig = resolveAgentConfig(cfg, statusAgentId);
	const effectiveFastMode = resolvedFastMode ?? resolveFastModeState({
		cfg,
		provider,
		model,
		agentId: statusAgentId,
		sessionEntry
	}).enabled;
	const agentFallbacksOverride = resolveAgentModelFallbacksOverride(cfg, statusAgentId);
	const configuredDefaultRef = resolveDefaultModelForAgent({
		cfg,
		agentId: statusAgentId,
		allowPluginNormalization: false
	});
	const configuredDefaultModelLabel = `${configuredDefaultRef.provider}/${configuredDefaultRef.model}`;
	const { buildStatusMessage } = await loadStatusMessageRuntime();
	const explicitThinkingDefault = agentConfig?.thinkingDefault ?? agentDefaults.thinkingDefault;
	const runtimeContextTokens = resolveStatusRuntimeContextTokens({
		cfg,
		provider: activeStatusProvider,
		model: modelRefs.active.model || model
	});
	return buildStatusMessage({
		config: cfg,
		agent: {
			...agentDefaults,
			model: {
				...toAgentModelListLike(agentDefaults.model),
				primary: params.primaryModelLabelOverride ?? `${provider}/${model}`,
				...agentFallbacksOverride === void 0 ? {} : { fallbacks: agentFallbacksOverride }
			},
			...typeof contextTokens === "number" && contextTokens > 0 ? { contextTokens } : {},
			thinkingDefault: explicitThinkingDefault,
			verboseDefault: agentDefaults.verboseDefault,
			reasoningDefault: agentConfig?.reasoningDefault ?? agentDefaults.reasoningDefault,
			elevatedDefault: agentDefaults.elevatedDefault
		},
		agentId: statusAgentId,
		configuredDefaultModelLabel,
		explicitConfiguredContextTokens: typeof agentDefaults.contextTokens === "number" && agentDefaults.contextTokens > 0 ? agentDefaults.contextTokens : void 0,
		runtimeContextTokens,
		sessionEntry,
		sessionKey,
		parentSessionKey,
		sessionScope,
		sessionStorePath: storePath,
		groupActivation,
		resolvedThink: resolvedThinkLevel ?? explicitThinkingDefault ?? await resolveDefaultThinkingLevel(),
		resolvedFast: effectiveFastMode,
		resolvedHarness: effectiveHarness,
		resolvedVerbose: resolvedVerboseLevel,
		resolvedReasoning: resolvedReasoningLevel,
		resolvedElevated: resolvedElevatedLevel,
		modelAuth: selectedModelAuth,
		activeModelAuth,
		uptimeLine: buildStatusUptimeLine(),
		usageLine: usageLine ?? void 0,
		queue: {
			mode: queueSettings.mode,
			depth: queueDepth,
			debounceMs: queueSettings.debounceMs,
			cap: queueSettings.cap,
			dropPolicy: queueSettings.dropPolicy,
			showDetails: queueOverrides
		},
		subagentsLine,
		taskLine,
		mediaDecisions: params.mediaDecisions,
		includeTranscriptUsage: params.includeTranscriptUsage ?? true
	});
}
//#endregion
export { buildStatusText as t };
