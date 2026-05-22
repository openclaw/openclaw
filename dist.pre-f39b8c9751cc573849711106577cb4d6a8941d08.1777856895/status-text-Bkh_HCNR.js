import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { S as resolveDefaultAgentId, b as resolveAgentDir, p as resolveSessionAgentId, s as resolveAgentModelFallbacksOverride, v as resolveAgentConfig, x as resolveAgentWorkspaceDir } from "./agent-scope-CzfWAE9r.js";
import { i as toAgentModelListLike } from "./model-input-qoijZF3K.js";
import { c as resolveMainSessionAlias, s as resolveInternalSessionKey } from "./sessions-helpers-Bojj-qTy.js";
import { n as getVolitionalCompactionCount } from "./request-compaction-tool-DYNGTENL.js";
import { n as resolveContinuationRuntimeConfig } from "./config-5i0YqEIQ.js";
import { d as pendingDelegateCount, p as stagedPostCompactionDelegateCount } from "./delegate-store-cA5uBg4A.js";
import { n as formatTaskStatusDetail, r as formatTaskStatusTitle, t as buildTaskStatusSnapshot } from "./task-status-D3YxAxXH.js";
import "./continuation-delegate-store-BlU9S5zR.js";
import { n as resolveSelectedAndActiveModel } from "./model-runtime-Du65r88e.js";
import { t as normalizeGroupActivation } from "./group-activation-YdVTTYPo.js";
import { t as resolveFastModeState } from "./fast-mode-B7Ki2j0L.js";
import { t as resolveModelAuthLabel } from "./model-auth-label-S3mZHX1r.js";
import { o as resolveUsageProviderId } from "./provider-usage.shared-BtSd2l5R.js";
import { i as formatUsageWindowSummary, t as loadProviderUsageSummary } from "./provider-usage-faT4XCvt.js";
import { n as listTasksForAgentIdForStatus, r as listTasksForSessionKeyForStatus } from "./task-status-access-RZW9xFZV.js";
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
	return agentHarnessSelectionRuntimePromise ??= import("./selection-B1M5-R1U.js");
}
function loadStatusSubagentsRuntime() {
	return statusSubagentsRuntimePromise ??= import("./status-subagents.runtime.js");
}
function loadStatusQueueRuntime() {
	return statusQueueRuntimePromise ??= import("./status-queue.runtime.js");
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
		const id = normalizeOptionalLowercaseString(selectAgentHarness({
			provider: params.provider,
			modelId: params.model,
			config: params.cfg,
			agentId: params.agentId,
			sessionKey: params.sessionKey,
			agentHarnessId: params.sessionEntry?.agentHarnessId
		}).id);
		return id && id !== "pi" ? id : void 0;
	} catch {
		return;
	}
}
function resolveStatusAuthProvider(params) {
	const harness = normalizeOptionalLowercaseString(params.effectiveHarness);
	const provider = normalizeOptionalLowercaseString(params.provider);
	if (harness === "codex" && provider === "openai") return "openai-codex";
	return params.provider;
}
function formatAgentTaskCountsLine(agentId) {
	const snapshot = buildTaskStatusSnapshot(listTasksForAgentIdForStatus(agentId));
	if (snapshot.totalCount === 0) return;
	return `📌 Tasks: ${snapshot.activeCount} active · ${snapshot.totalCount} total · agent-local`;
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
	const selectedModelAuth = Object.hasOwn(params, "modelAuthOverride") ? params.modelAuthOverride : resolveModelAuthLabel({
		provider: resolveStatusAuthProvider({
			provider,
			effectiveHarness
		}),
		cfg,
		sessionEntry,
		agentDir: statusAgentDir,
		workspaceDir: statusWorkspaceDir,
		includeExternalProfiles: false
	});
	const activeModelAuth = Object.hasOwn(params, "activeModelAuthOverride") ? params.activeModelAuthOverride : modelRefs.activeDiffers ? resolveModelAuthLabel({
		provider: resolveStatusAuthProvider({
			provider: modelRefs.active.provider,
			effectiveHarness
		}),
		cfg,
		sessionEntry,
		agentDir: statusAgentDir,
		workspaceDir: statusWorkspaceDir,
		includeExternalProfiles: false
	}) : selectedModelAuth;
	const currentUsageProvider = (() => {
		try {
			return resolveUsageProviderId(provider);
		} catch {
			return;
		}
	})();
	let usageLine = null;
	if (currentUsageProvider && shouldLoadUsageSummary({
		provider: currentUsageProvider,
		selectedModelAuth
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
	let continuationLine;
	if ((cfg.agents?.defaults?.continuation)?.enabled && sessionKey) {
		const chainCount = sessionEntry?.continuationChainCount ?? 0;
		const { maxChainLength } = resolveContinuationRuntimeConfig(cfg);
		const pending = pendingDelegateCount(sessionKey);
		const staged = stagedPostCompactionDelegateCount(sessionKey);
		const volitional = getVolitionalCompactionCount(sessionKey);
		const parts = [`chain ${chainCount}/${maxChainLength}`];
		if (pending > 0) parts.push(`${pending} delegates pending`);
		if (staged > 0) parts.push(`${staged} post-compaction staged`);
		parts.push(`volitional: ${volitional}`);
		continuationLine = `🔄 Continuation: ${parts.join(" | ")}`;
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
	const { buildStatusMessage } = await loadStatusMessageRuntime();
	const explicitThinkingDefault = agentConfig?.thinkingDefault ?? agentDefaults.thinkingDefault;
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
		explicitConfiguredContextTokens: typeof agentDefaults.contextTokens === "number" && agentDefaults.contextTokens > 0 ? agentDefaults.contextTokens : void 0,
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
		continuationLine,
		mediaDecisions: params.mediaDecisions,
		includeTranscriptUsage: params.includeTranscriptUsage ?? true
	});
}
//#endregion
export { buildStatusText as t };
