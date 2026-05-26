import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { r as resolveAgentModelFallbackValues } from "./model-input-ChW9XXsQ.js";
import { g as resolveRunModelFallbacksOverride, v as resolveSessionAgentIds } from "./agent-scope-CtLXGcWm.js";
import { a as isSubagentSessionKey, i as isCronSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { a as resolveAgentDir } from "./agent-scope-config-CMp71_27.js";
import { v as getCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER, t as DEFAULT_CONTEXT_TOKENS } from "./defaults-mDjiWzE5.js";
import { u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { r as wrapStreamFnTextTransforms } from "./plugin-text-transforms-jHXsIkoa.js";
import { c as resolveContextConfigProviderForRuntime } from "./openai-codex-routing-DwRY-_VI.js";
import { t as resolveAgentHarnessPolicy } from "./policy-BwWh-R0D.js";
import { k as listRegisteredPluginAgentPromptGuidance } from "./command-registration-io1ALI_N.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-BkXXy1ub.js";
import { c as resolveSessionLockMaxHoldFromTimeout, d as resolveSessionWriteLockOptions, i as acquireSessionWriteLock } from "./session-write-lock-_a5O1H8L.js";
import { K as transformProviderSystemPrompt, P as resolveProviderTextTransforms, b as prepareProviderRuntimeAuth } from "./provider-runtime-D8jQEgmu.js";
import { n as ensureOpenClawModelsJson } from "./models-config-DNlTw_QX.js";
import { t as formatMissingAuthError } from "./model-auth-runtime-shared-cdTr1v5l.js";
import { t as isAcpRuntimeSpawnAvailable } from "./availability-C-N5XwGI.js";
import { A as dedupeDuplicateUserMessagesForCompaction, B as resolveEmbeddedAgentStreamFn, Ct as isReasoningTagProvider, D as rotateTranscriptAfterCompaction, F as toSessionToolAllowlist, G as sanitizeSessionHistory, H as prewarmSessionFile, I as applySystemPromptOverrideToSession, J as getHistoryLimitFromSessionKey, K as validateReplayTurns, L as buildEmbeddedSystemPrompt, M as mapThinkingLevel, N as collectAllowedToolNames, P as collectRegisteredToolNames, Q as isRealConversationMessage, R as createSystemPromptOverride, U as trackSessionManagerAccess, V as resolveEmbeddedRunSkillEntries, W as createEmbeddedPiResourceLoader, X as buildEmbeddedExtensionFactories, Y as limitHistoryTurns, Z as hasMeaningfulConversationContent, et as consumeCompactionSafeguardCancelReason, j as flushPendingToolResultsAfterIdle, k as shouldRotateCompactionTranscript, nt as guardSessionManager, ot as collectRuntimeChannelCapabilities, q as buildEmbeddedMessageActionDiscoveryInput, rt as repairSessionFileIfNeeded, st as createPreparedEmbeddedPiSettingsManager, tt as setCompactionSafeguardCancelReason, z as resolveEmbeddedAgentBaseStreamFn } from "./selection-hR-AeOeU.js";
import { t as getMachineDisplayName } from "./machine-name-Dy5GwJ0w.js";
import { g as listActiveProcessSessionReferences, m as resolveEmbeddedCompactionTarget } from "./attempt.prompt-helpers-2z-P6Pk8.js";
import { n as extractModelCompat } from "./provider-model-compat-CmPOKTzc.js";
import { i as generateSecureToken } from "./secure-random-BxnbXS5x.js";
import { a as resolveBootstrapContextForRun, i as makeBootstrapWarn, s as resolveContextInjectionMode } from "./bootstrap-files-D4ZYVMib.js";
import { t as resolveHeartbeatPromptForSystemPrompt } from "./heartbeat-system-prompt-CGMC07RM.js";
import { g as ensureSessionHeader, i as pickFallbackThinkingLevel } from "./pi-embedded-helpers-bmljPI1n.js";
import { E as resolveChannelMessageToolHints, O as resolveChannelReactionGuidance, T as listChannelSupportedActions } from "./pi-tools.before-tool-call-CP_aEkky.js";
import { n as resolveProcessToolScopeKey, t as createOpenClawCodingTools } from "./pi-tools-iVT6BGHc.js";
import { i as resolveOpenClawReferencePaths } from "./docs-path-DyXQ-M1b.js";
import { n as coerceToFailoverError, r as describeFailoverError } from "./failover-error-CZCIurQK.js";
import { d as resolveModelAuthMode, i as getApiKeyForModel, n as applyLocalNoAuthHeaderOverride, t as applyAuthHeaderOverride } from "./model-auth-Db-JGIrg.js";
import { O as supportsModelTools, w as sanitizeToolUseResultPairing } from "./openai-transport-stream-Pgx5hpN7.js";
import { t as createBundleLspToolRuntime } from "./pi-bundle-lsp-runtime-BjORp6AO.js";
import { t as createBundleMcpToolRuntime } from "./pi-bundle-mcp-materialize-D2uH_kVy.js";
import "./pi-bundle-mcp-tools-_xKQdIka.js";
import { g as resolveCompactionTimeoutMs, h as compactWithSafetyTimeout } from "./attempt.tool-run-context-QAUT7ucg.js";
import { r as runWithModelFallback, t as isFallbackSummaryError } from "./model-fallback-BCpDvqqS.js";
import { t as log } from "./logger-D2U-uUBZ.js";
import { i as isSilentOverflowProneModel, n as applyPiAutoCompactionGuard, r as applyPiCompactionSettingsFromConfig } from "./pi-settings-3KMJpQrg.js";
import { t as splitSdkTools } from "./tool-split-Cs6WJ2Aa.js";
import { s as resolveAgentPromptSurfaceForSessionKey } from "./system-prompt-config-BOuyiivW.js";
import { t as registerProviderStreamForModel } from "./provider-stream-qFQv-LxD.js";
import { o as resolveSandboxContext } from "./sandbox-DiI74XYF.js";
import { _ as writeTranscriptFileAtomic, g as readTranscriptFileState, m as TranscriptFileState } from "./context-engine-lifecycle-BMb8IJAk.js";
import { t as detectRuntimeShell } from "./shell-utils-BDYMhC5E.js";
import { n as applySkillEnvOverridesFromSnapshot, t as applySkillEnvOverrides } from "./env-overrides-DIYux-i5.js";
import { s as resolveSkillsPromptForRun } from "./workspace-BoRIIBbL.js";
import "./skills-JUNRkaHl.js";
import { n as resolveSystemPromptOverride } from "./system-prompt-report-OWmAgzTa.js";
import { i as resolveUserTimezone, r as resolveUserTimeFormat, t as formatUserTime } from "./date-time-D7najZvu.js";
import { t as applyExtraParamsToAgent } from "./extra-params-S591BMjA.js";
import { t as applyFinalEffectiveToolPolicy } from "./effective-tool-policy-Dx6qVZtQ.js";
import { a as resolveContextWindowInfo } from "./context-window-guard-BAul1ZXt.js";
import { t as buildEmbeddedSandboxInfo } from "./sandbox-info-C5ksc8fy.js";
import { t as ensureSelectedAgentHarnessPlugin } from "./runtime-plugin-VHkAKsBb.js";
import { a as runAfterCompactionHooks, c as captureCompactionCheckpointSnapshotAsync, h as resolveSessionCompactionCheckpointReason, i as estimateTokensAfterCompaction, l as cleanupCompactionCheckpointSnapshot, n as asCompactionHookRunner, o as runBeforeCompactionHooks, p as persistSessionCompactionCheckpoint, r as buildBeforeCompactionHookMetrics, s as runPostCompactionSideEffects, t as readPiModelContextTokens } from "./model-context-tokens-C2LIZoUn.js";
import { t as ensureRuntimePluginsLoaded } from "./runtime-plugins-Dg8fXOAP.js";
import { n as resolveModelAsync } from "./model-cgt_Zkgh.js";
import { r as buildAgentRuntimePlan } from "./build-CsBPGY-v.js";
import fs from "node:fs/promises";
import os from "node:os";
import { SessionManager, createAgentSession, estimateTokens } from "@earendil-works/pi-coding-agent";
//#region src/agents/pi-embedded-runner/compact-reasons.ts
const MAX_COMPACTION_REASON_DETAIL_CHARS = 100;
function isGenericCompactionCancelledReason(reason) {
	const normalized = normalizeLowercaseStringOrEmpty(reason);
	return normalized === "compaction cancelled" || normalized === "error: compaction cancelled";
}
function resolveCompactionFailureReason(params) {
	if (isGenericCompactionCancelledReason(params.reason) && params.safeguardCancelReason) return params.safeguardCancelReason;
	return params.reason;
}
function classifyCompactionReason(reason) {
	const text = normalizeLowercaseStringOrEmpty(reason);
	if (!text) return "unknown";
	if (text.includes("nothing to compact")) return "no_compactable_entries";
	if (text.includes("below threshold")) return "below_threshold";
	if (text.includes("already compacted")) return "already_compacted_recently";
	if (text.includes("still exceeds target")) return "live_context_still_exceeds_target";
	if (text.includes("guard")) return "guard_blocked";
	if (text.includes("summary")) return "summary_failed";
	if (text.includes("timed out") || text.includes("timeout")) return "timeout";
	if (text.includes("400") || text.includes("401") || text.includes("403") || text.includes("429")) return "provider_error_4xx";
	if (text.includes("500") || text.includes("502") || text.includes("503") || text.includes("504")) return "provider_error_5xx";
	return "unknown";
}
function formatUnknownCompactionReasonDetail(reason) {
	const sanitized = sanitizeForLog((reason ?? "").replace(/\s+/g, " ")).trim().replace(/[^A-Za-z0-9._:@/+~-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
	if (!sanitized) return;
	return sanitized.slice(0, MAX_COMPACTION_REASON_DETAIL_CHARS);
}
//#endregion
//#region src/agents/pi-embedded-runner/manual-compaction-boundary.ts
function replaceLatestCompactionBoundary(params) {
	return params.entries.map((entry) => {
		if (entry.type !== "compaction" || entry.id !== params.compactionEntryId) return entry;
		return {
			...entry,
			firstKeptEntryId: entry.id
		};
	});
}
function entryCreatesCompactionInputMessage(entry) {
	return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}
function hasMessagesToSummarizeBeforeKeptTail(params) {
	const compactionIndex = params.branch.findIndex((entry) => entry.id === params.compaction.id);
	const firstKeptIndex = params.branch.findIndex((entry) => entry.id === params.compaction.firstKeptEntryId);
	if (compactionIndex <= 0 || firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) return false;
	let boundaryStartIndex = 0;
	for (let i = compactionIndex - 1; i >= 0; i -= 1) {
		const entry = params.branch[i];
		if (entry?.type !== "compaction") continue;
		const previousFirstKeptIndex = params.branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
		boundaryStartIndex = previousFirstKeptIndex >= 0 ? previousFirstKeptIndex : i + 1;
		break;
	}
	return params.branch.slice(boundaryStartIndex, firstKeptIndex).some((entry) => entryCreatesCompactionInputMessage(entry));
}
async function hardenManualCompactionBoundary(params) {
	const state = await readTranscriptFileState(params.sessionFile);
	const header = state.getHeader();
	if (!header) return {
		applied: false,
		messages: []
	};
	const leaf = state.getLeafEntry();
	if (leaf?.type !== "compaction") {
		const sessionContext = state.buildSessionContext();
		return {
			applied: false,
			leafId: state.getLeafId() ?? void 0,
			messages: sessionContext.messages
		};
	}
	const sessionContext = state.buildSessionContext();
	if (params.preserveRecentTail) return {
		applied: false,
		firstKeptEntryId: leaf.firstKeptEntryId,
		leafId: state.getLeafId() ?? void 0,
		messages: sessionContext.messages
	};
	if (leaf.firstKeptEntryId === leaf.id) return {
		applied: false,
		firstKeptEntryId: leaf.id,
		leafId: state.getLeafId() ?? void 0,
		messages: sessionContext.messages
	};
	if (!leaf.summary.trim() || !hasMessagesToSummarizeBeforeKeptTail({
		branch: state.getBranch(leaf.id),
		compaction: leaf
	})) return {
		applied: false,
		firstKeptEntryId: leaf.firstKeptEntryId,
		leafId: state.getLeafId() ?? void 0,
		messages: sessionContext.messages
	};
	const replacedEntries = replaceLatestCompactionBoundary({
		entries: state.getEntries(),
		compactionEntryId: leaf.id
	});
	const replacedState = new TranscriptFileState({
		header,
		entries: replacedEntries
	});
	await writeTranscriptFileAtomic(params.sessionFile, [header, ...replacedEntries]);
	const replacedSessionContext = replacedState.buildSessionContext();
	return {
		applied: true,
		firstKeptEntryId: leaf.id,
		leafId: replacedState.getLeafId() ?? void 0,
		messages: replacedSessionContext.messages
	};
}
//#endregion
//#region src/agents/pi-embedded-runner/compact.ts
function hasRealConversationContent(msg, messages, index) {
	return isRealConversationMessage(msg, messages, index);
}
function createCompactionDiagId() {
	return `cmp-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}
function prepareCompactionSessionAgent(params) {
	params.session.agent.streamFn = resolveEmbeddedAgentStreamFn({
		currentStreamFn: resolveEmbeddedAgentBaseStreamFn({ session: params.session }),
		providerStreamFn: params.providerStreamFn,
		sessionId: params.sessionId,
		signal: params.signal,
		model: params.effectiveModel,
		resolvedApiKey: params.resolvedApiKey,
		authProfileId: params.runtimePlan?.auth.forwardedAuthProfileId,
		authStorage: params.authStorage
	});
	const providerTextTransforms = resolveProviderTextTransforms({
		provider: params.provider,
		config: params.config,
		workspaceDir: params.effectiveWorkspace
	});
	if (providerTextTransforms) params.session.agent.streamFn = wrapStreamFnTextTransforms({
		streamFn: params.session.agent.streamFn,
		input: providerTextTransforms.input,
		output: providerTextTransforms.output,
		transformSystemPrompt: false
	});
	const preparedRuntimeExtraParams = params.runtimePlan?.transport.resolveExtraParams({
		thinkingLevel: params.thinkLevel,
		agentId: params.sessionAgentId,
		workspaceDir: params.effectiveWorkspace,
		model: params.effectiveModel
	});
	return applyExtraParamsToAgent(params.session.agent, params.config, params.provider, params.modelId, void 0, params.thinkLevel, params.sessionAgentId, params.effectiveWorkspace, params.effectiveModel, params.agentDir, void 0, preparedRuntimeExtraParams ? { preparedExtraParams: preparedRuntimeExtraParams } : void 0);
}
function resolveCompactionProviderStream(params) {
	return registerProviderStreamForModel({
		model: params.effectiveModel,
		cfg: params.config,
		agentDir: params.agentDir,
		workspaceDir: params.effectiveWorkspace
	});
}
function normalizeObservedTokenCount(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
function getMessageTextChars(msg) {
	const content = msg.content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const text = block.text;
		if (typeof text === "string") total += text.length;
	}
	return total;
}
function resolveMessageToolLabel(msg) {
	const candidate = msg.toolName ?? msg.name ?? msg.tool;
	return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : void 0;
}
function summarizeCompactionMessages(messages) {
	let historyTextChars = 0;
	let toolResultChars = 0;
	const contributors = [];
	let estTokens = 0;
	let tokenEstimationFailed = false;
	for (const msg of messages) {
		const role = typeof msg.role === "string" ? msg.role : "unknown";
		const chars = getMessageTextChars(msg);
		historyTextChars += chars;
		if (role === "toolResult") toolResultChars += chars;
		contributors.push({
			role,
			chars,
			tool: resolveMessageToolLabel(msg)
		});
		if (!tokenEstimationFailed) try {
			estTokens += estimateTokens(msg);
		} catch {
			tokenEstimationFailed = true;
		}
	}
	return {
		messages: messages.length,
		historyTextChars,
		toolResultChars,
		estTokens: tokenEstimationFailed ? void 0 : estTokens,
		contributors: selectTopContributors(contributors)
	};
}
function selectTopContributors(contributors) {
	const selected = [];
	for (const contributor of contributors) {
		let insertAt = selected.length;
		for (let index = 0; index < selected.length; index += 1) if (contributor.chars > selected[index].chars) {
			insertAt = index;
			break;
		}
		if (insertAt < 3) {
			selected.splice(insertAt, 0, contributor);
			if (selected.length > 3) selected.pop();
		} else if (selected.length < 3) selected.push(contributor);
	}
	return selected;
}
function containsRealConversationMessages(messages) {
	return messages.some((message, index, allMessages) => hasRealConversationContent(message, allMessages, index));
}
function hasExplicitCompactionModel(params) {
	return Boolean(params.config?.agents?.defaults?.compaction?.model?.trim());
}
function resolveCompactionFallbacksOverride(params) {
	return params.modelFallbacksOverride ?? resolveRunModelFallbacksOverride({
		cfg: params.config,
		sessionKey: params.sessionKey
	});
}
function hasCompactionModelFallbackCandidates(params) {
	const fallbacksOverride = resolveCompactionFallbacksOverride(params);
	const defaultFallbacks = resolveAgentModelFallbackValues(params.config?.agents?.defaults?.model);
	return (fallbacksOverride ?? defaultFallbacks).length > 0;
}
function classifyCompactionFallbackResult(result, provider, model) {
	if (result.ok) return null;
	const reason = result.reason?.trim();
	if (!reason) return null;
	const failoverError = coerceToFailoverError(Object.assign(new Error(result.failure?.rawError ?? reason), {
		status: result.failure?.status,
		code: result.failure?.code
	}), {
		provider,
		model
	});
	return failoverError ? { error: failoverError } : null;
}
function fallbackFailureToCompactionResult(err) {
	return {
		ok: false,
		compacted: false,
		reason: isFallbackSummaryError(err) ? err.message : formatErrorMessage(err)
	};
}
/**
* Core compaction logic without lane queueing.
* Use this when already inside a session/global lane to avoid deadlocks.
*/
async function compactEmbeddedPiSessionDirect(params) {
	if (hasExplicitCompactionModel(params) || !hasCompactionModelFallbackCandidates(params)) return await compactEmbeddedPiSessionDirectOnce(params);
	const resolvedCompactionTarget = resolveEmbeddedCompactionTarget({
		config: params.config,
		provider: params.provider,
		modelId: params.model,
		authProfileId: params.authProfileId,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const primaryProvider = resolvedCompactionTarget.provider ?? "openai";
	const primaryModel = resolvedCompactionTarget.model ?? "gpt-5.5";
	const fallbacksOverride = resolveCompactionFallbacksOverride(params);
	const fallbackAgentId = resolveSessionAgentIds({
		sessionKey: params.sandboxSessionKey ?? params.sessionKey,
		config: params.config
	}).sessionAgentId;
	const fallbackSessionKey = params.sandboxSessionKey ?? params.sessionKey ?? params.sessionId;
	try {
		return (await runWithModelFallback({
			cfg: params.config,
			provider: primaryProvider,
			model: primaryModel,
			runId: params.runId ?? params.sessionId,
			agentDir: params.agentDir,
			agentId: fallbackAgentId,
			sessionKey: fallbackSessionKey,
			prepareAgentHarnessRuntime: async ({ provider, model, agentHarnessRuntimeOverride }) => {
				await ensureSelectedAgentHarnessPlugin({
					config: params.config,
					provider,
					modelId: model,
					agentId: fallbackAgentId,
					sessionKey: fallbackSessionKey,
					agentHarnessRuntimeOverride,
					workspaceDir: params.workspaceDir
				});
			},
			fallbacksOverride,
			classifyResult: ({ result, provider, model }) => classifyCompactionFallbackResult(result, provider, model),
			run: async (provider, model) => {
				const authProfileId = provider === primaryProvider ? params.authProfileId : void 0;
				return await compactEmbeddedPiSessionDirectOnce({
					...params,
					provider,
					model,
					authProfileId
				});
			}
		})).result;
	} catch (err) {
		return fallbackFailureToCompactionResult(err);
	}
}
async function compactEmbeddedPiSessionDirectOnce(params) {
	const startedAt = Date.now();
	const diagId = params.diagId?.trim() || createCompactionDiagId();
	const trigger = params.trigger ?? "manual";
	const attempt = params.attempt ?? 1;
	const maxAttempts = params.maxAttempts ?? 1;
	const runId = params.runId ?? params.sessionId;
	const resolvedWorkspace = resolveUserPath(params.workspaceDir);
	ensureRuntimePluginsLoaded({
		config: params.config,
		workspaceDir: resolvedWorkspace,
		allowGatewaySubagentBinding: params.allowGatewaySubagentBinding
	});
	const resolvedCompactionTarget = resolveEmbeddedCompactionTarget({
		config: params.config,
		provider: params.provider,
		modelId: params.model,
		authProfileId: params.authProfileId,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const provider = resolvedCompactionTarget.provider ?? "openai";
	const modelId = resolvedCompactionTarget.model ?? "gpt-5.5";
	const authProfileId = resolvedCompactionTarget.authProfileId;
	let thinkLevel = params.thinkLevel ?? "off";
	const attemptedThinking = /* @__PURE__ */ new Set();
	const fail = (reason, err) => {
		const failureReason = classifyCompactionReason(reason);
		const failure = err ? describeFailoverError(err) : void 0;
		const detail = failureReason === "unknown" ? formatUnknownCompactionReasonDetail(reason) : void 0;
		const detailSuffix = detail ? ` detail=${detail}` : "";
		log.warn(`[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} attempt=${attempt} maxAttempts=${maxAttempts} outcome=failed reason=${failureReason}${detailSuffix} durationMs=${Date.now() - startedAt}`);
		return {
			ok: false,
			compacted: false,
			reason,
			failure: failure ? {
				reason: failure.reason,
				status: failure.status,
				code: failure.code,
				rawError: failure.rawError ?? failure.message
			} : void 0
		};
	};
	const earlyAgentIds = resolveSessionAgentIds({
		sessionKey: params.sessionKey,
		config: params.config
	});
	const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, earlyAgentIds.sessionAgentId);
	await ensureOpenClawModelsJson(params.config, agentDir, { workspaceDir: resolvedWorkspace });
	const { model, error, authStorage, modelRegistry } = await resolveModelAsync(provider, modelId, agentDir, params.config);
	if (!model) return fail(error ?? `Unknown model: ${provider}/${modelId}`);
	let runtimeModel = model;
	let apiKeyInfo = null;
	let hasRuntimeAuthExchange = false;
	try {
		apiKeyInfo = await getApiKeyForModel({
			model: runtimeModel,
			cfg: params.config,
			profileId: authProfileId,
			agentDir,
			workspaceDir: resolvedWorkspace
		});
		if (!apiKeyInfo.apiKey) {
			if (apiKeyInfo.mode !== "aws-sdk") throw new Error(formatMissingAuthError(apiKeyInfo, runtimeModel.provider));
		} else {
			const preparedAuth = await prepareProviderRuntimeAuth({
				provider: runtimeModel.provider,
				config: params.config,
				workspaceDir: resolvedWorkspace,
				env: process.env,
				context: {
					config: params.config,
					agentDir,
					workspaceDir: resolvedWorkspace,
					env: process.env,
					provider: runtimeModel.provider,
					modelId,
					model: runtimeModel,
					apiKey: apiKeyInfo.apiKey,
					authMode: apiKeyInfo.mode,
					profileId: apiKeyInfo.profileId
				}
			});
			if (preparedAuth?.baseUrl) runtimeModel = {
				...runtimeModel,
				baseUrl: preparedAuth.baseUrl
			};
			const runtimeApiKey = preparedAuth?.apiKey ?? apiKeyInfo.apiKey;
			hasRuntimeAuthExchange = Boolean(preparedAuth?.apiKey);
			if (!runtimeApiKey) throw new Error(`Provider "${runtimeModel.provider}" runtime auth returned no apiKey.`);
			authStorage.setRuntimeApiKey(runtimeModel.provider, runtimeApiKey);
		}
	} catch (err) {
		return fail(formatErrorMessage(err), err);
	}
	await fs.mkdir(resolvedWorkspace, { recursive: true });
	const sandboxSessionKey = params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
	const sandbox = await resolveSandboxContext({
		config: params.config,
		sessionKey: sandboxSessionKey,
		workspaceDir: resolvedWorkspace
	});
	const effectiveWorkspace = sandbox?.enabled ? sandbox.workspaceAccess === "rw" ? resolvedWorkspace : sandbox.workspaceDir : resolvedWorkspace;
	await fs.mkdir(effectiveWorkspace, { recursive: true });
	await ensureSessionHeader({
		sessionFile: params.sessionFile,
		sessionId: params.sessionId,
		cwd: effectiveWorkspace
	});
	const { sessionAgentId: effectiveSkillAgentId } = resolveSessionAgentIds({
		sessionKey: params.sessionKey,
		config: params.config
	});
	let restoreSkillEnv;
	let compactionSessionManager = null;
	let checkpointSnapshot = null;
	let checkpointSnapshotRetained = false;
	try {
		const skillsSnapshotForRun = sandbox?.enabled && sandbox.workspaceAccess !== "rw" ? void 0 : params.skillsSnapshot;
		const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
			workspaceDir: effectiveWorkspace,
			config: params.config,
			agentId: effectiveSkillAgentId,
			skillsSnapshot: skillsSnapshotForRun
		});
		restoreSkillEnv = skillsSnapshotForRun ? applySkillEnvOverridesFromSnapshot({
			snapshot: skillsSnapshotForRun,
			config: params.config
		}) : applySkillEnvOverrides({
			skills: skillEntries ?? [],
			config: params.config
		});
		const skillsPrompt = resolveSkillsPromptForRun({
			skillsSnapshot: skillsSnapshotForRun,
			entries: shouldLoadSkillEntries ? skillEntries : void 0,
			config: params.config,
			workspaceDir: effectiveWorkspace,
			agentId: effectiveSkillAgentId
		});
		const sessionLabel = params.sessionKey ?? params.sessionId;
		const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
		const { contextFiles } = resolveContextInjectionMode(params.config, effectiveSkillAgentId) === "never" ? { contextFiles: [] } : await resolveBootstrapContextForRun({
			workspaceDir: effectiveWorkspace,
			config: params.config,
			sessionKey: params.sessionKey,
			sessionId: params.sessionId,
			agentId: effectiveSkillAgentId,
			warn: makeBootstrapWarn({
				sessionLabel,
				warn: (message) => log.warn(message)
			})
		});
		const runtimeModelWithContext = runtimeModel;
		const runtimeHarnessPolicy = resolveAgentHarnessPolicy({
			provider,
			modelId,
			config: params.config,
			agentId: effectiveSkillAgentId,
			sessionKey: params.sessionKey
		});
		const ctxInfo = resolveContextWindowInfo({
			cfg: params.config,
			provider: resolveContextConfigProviderForRuntime({
				provider,
				runtimeId: runtimeHarnessPolicy.runtime
			}),
			modelId,
			modelContextTokens: readPiModelContextTokens(runtimeModel),
			modelContextWindow: runtimeModelWithContext.contextWindow,
			defaultTokens: DEFAULT_CONTEXT_TOKENS
		});
		const effectiveModel = applyAuthHeaderOverride(applyLocalNoAuthHeaderOverride(ctxInfo.tokens < (runtimeModelWithContext.contextWindow ?? Infinity) ? {
			...runtimeModelWithContext,
			contextWindow: ctxInfo.tokens
		} : runtimeModelWithContext, apiKeyInfo), hasRuntimeAuthExchange ? null : apiKeyInfo, params.config);
		const runtimePlan = params.runtimePlan ?? buildAgentRuntimePlan({
			provider,
			modelId,
			model: effectiveModel,
			modelApi: effectiveModel.api,
			harnessId: params.agentHarnessId,
			harnessRuntime: params.agentHarnessId,
			authProfileProvider: authProfileId?.split(":", 1)[0],
			sessionAuthProfileId: authProfileId,
			config: params.config,
			workspaceDir: effectiveWorkspace,
			agentDir,
			agentId: effectiveSkillAgentId,
			thinkingLevel: thinkLevel
		});
		const runAbortController = new AbortController();
		const toolsRaw = createOpenClawCodingTools({
			exec: { elevated: params.bashElevated },
			sandbox,
			messageProvider: resolvedMessageProvider,
			agentAccountId: params.agentAccountId,
			sessionKey: sandboxSessionKey,
			runSessionKey: params.sessionKey && params.sessionKey !== sandboxSessionKey ? params.sessionKey : void 0,
			sessionId: params.sessionId,
			runId: params.runId,
			groupId: params.groupId,
			groupChannel: params.groupChannel,
			groupSpace: params.groupSpace,
			spawnedBy: params.spawnedBy,
			senderId: params.senderId,
			senderName: params.senderName,
			senderUsername: params.senderUsername,
			senderE164: params.senderE164,
			allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
			agentDir,
			workspaceDir: effectiveWorkspace,
			config: params.config,
			abortSignal: runAbortController.signal,
			sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
			modelProvider: model.provider,
			modelId,
			modelCompat: extractModelCompat(effectiveModel),
			modelApi: model.api,
			modelContextWindowTokens: ctxInfo.tokens,
			skillsSnapshot: skillsSnapshotForRun,
			modelAuthMode: resolveModelAuthMode(model.provider, params.config, void 0, { workspaceDir: effectiveWorkspace })
		});
		const toolsEnabled = supportsModelTools(runtimeModel);
		const runtimePlanModelContext = {
			workspaceDir: effectiveWorkspace,
			modelApi: model.api,
			model
		};
		const tools = runtimePlan.tools.normalize(toolsEnabled ? toolsRaw : [], runtimePlanModelContext);
		const bundleMcpRuntime = toolsEnabled ? await createBundleMcpToolRuntime({
			workspaceDir: effectiveWorkspace,
			cfg: params.config,
			reservedToolNames: tools.map((tool) => tool.name)
		}) : void 0;
		const bundleLspRuntime = toolsEnabled ? await createBundleLspToolRuntime({
			workspaceDir: effectiveWorkspace,
			cfg: params.config,
			reservedToolNames: [...tools.map((tool) => tool.name), ...bundleMcpRuntime?.tools.map((tool) => tool.name) ?? []]
		}) : void 0;
		const filteredBundledTools = applyFinalEffectiveToolPolicy({
			bundledTools: [...bundleMcpRuntime?.tools ?? [], ...bundleLspRuntime?.tools ?? []],
			config: params.config,
			sandboxToolPolicy: sandbox?.tools,
			sessionKey: sandboxSessionKey,
			modelProvider: model.provider,
			modelId,
			messageProvider: resolvedMessageProvider,
			agentAccountId: params.agentAccountId,
			groupId: params.groupId,
			groupChannel: params.groupChannel,
			groupSpace: params.groupSpace,
			spawnedBy: params.spawnedBy,
			senderId: params.senderId,
			senderName: params.senderName,
			senderUsername: params.senderUsername,
			senderE164: params.senderE164,
			warn: (message) => log.warn(message)
		});
		const normalizedBundledTools = filteredBundledTools.length > 0 ? runtimePlan.tools.normalize(filteredBundledTools, runtimePlanModelContext) : filteredBundledTools;
		const effectiveTools = [...tools, ...normalizedBundledTools];
		const allowedToolNames = collectAllowedToolNames({ tools: effectiveTools });
		runtimePlan.tools.logDiagnostics(effectiveTools, runtimePlanModelContext);
		const machineName = await getMachineDisplayName();
		const runtimeChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
		const runtimeCapabilities = collectRuntimeChannelCapabilities({
			cfg: params.config,
			channel: runtimeChannel,
			accountId: params.agentAccountId
		});
		const reactionGuidance = runtimeChannel && params.config ? resolveChannelReactionGuidance({
			cfg: params.config,
			channel: runtimeChannel,
			accountId: params.agentAccountId
		}) : void 0;
		const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
			sessionKey: params.sessionKey,
			config: params.config
		});
		const channelActions = runtimeChannel ? listChannelSupportedActions(buildEmbeddedMessageActionDiscoveryInput({
			cfg: params.config,
			channel: runtimeChannel,
			currentChannelId: params.currentChannelId,
			currentThreadTs: params.currentThreadTs,
			currentMessageId: params.currentMessageId,
			accountId: params.agentAccountId,
			sessionKey: params.sessionKey,
			sessionId: params.sessionId,
			agentId: sessionAgentId,
			senderId: params.senderId
		})) : void 0;
		const messageToolHints = runtimeChannel ? resolveChannelMessageToolHints({
			cfg: params.config,
			channel: runtimeChannel,
			accountId: params.agentAccountId
		}) : void 0;
		const runtimeInfo = {
			host: machineName,
			os: `${os.type()} ${os.release()}`,
			arch: os.arch(),
			node: process.version,
			model: `${provider}/${modelId}`,
			shell: detectRuntimeShell(),
			channel: runtimeChannel,
			capabilities: runtimeCapabilities,
			channelActions,
			activeProcessSessions: listActiveProcessSessionReferences({ scopeKey: resolveProcessToolScopeKey({
				sessionKey: sandboxSessionKey,
				agentId: sessionAgentId
			}) })
		};
		const sandboxInfo = buildEmbeddedSandboxInfo(sandbox, params.bashElevated);
		const reasoningTagHint = isReasoningTagProvider(provider, {
			config: params.config,
			workspaceDir: effectiveWorkspace,
			env: process.env,
			modelId,
			modelApi: model.api,
			model
		});
		const userTimezone = resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
		const userTimeFormat = resolveUserTimeFormat(params.config?.agents?.defaults?.timeFormat);
		const userTime = formatUserTime(/* @__PURE__ */ new Date(), userTimezone, userTimeFormat);
		const promptSurface = resolveAgentPromptSurfaceForSessionKey(params.sessionKey);
		const promptMode = isSubagentSessionKey(params.sessionKey) || isCronSessionKey(params.sessionKey) ? "minimal" : "full";
		const nativeCommandGuidanceLines = listRegisteredPluginAgentPromptGuidance({ surface: promptSurface });
		const openClawReferences = await resolveOpenClawReferencePaths({
			workspaceDir: effectiveWorkspace,
			argv1: process.argv[1],
			cwd: effectiveWorkspace,
			moduleUrl: import.meta.url
		});
		const promptContributionContext = {
			config: params.config,
			agentDir,
			workspaceDir: effectiveWorkspace,
			provider,
			modelId,
			promptMode,
			runtimeChannel,
			runtimeCapabilities,
			agentId: sessionAgentId
		};
		const promptContribution = runtimePlan.prompt.resolveSystemPromptContribution(promptContributionContext);
		const buildSystemPromptOverride = (defaultThinkLevel) => {
			const builtSystemPrompt = resolveSystemPromptOverride({
				config: params.config,
				agentId: sessionAgentId
			}) ?? buildEmbeddedSystemPrompt({
				config: params.config,
				agentId: sessionAgentId,
				workspaceDir: effectiveWorkspace,
				defaultThinkLevel,
				reasoningLevel: params.reasoningLevel ?? "off",
				extraSystemPrompt: params.extraSystemPrompt,
				ownerNumbers: params.ownerNumbers,
				reasoningTagHint,
				heartbeatPrompt: resolveHeartbeatPromptForSystemPrompt({
					config: params.config,
					agentId: sessionAgentId,
					defaultAgentId
				}),
				skillsPrompt,
				docsPath: openClawReferences.docsPath ?? void 0,
				sourcePath: openClawReferences.sourcePath ?? void 0,
				promptMode,
				promptSurface,
				sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
				acpEnabled: isAcpRuntimeSpawnAvailable({
					config: params.config,
					sandboxed: sandboxInfo?.enabled === true
				}),
				runtimeInfo,
				reactionGuidance,
				messageToolHints,
				sandboxInfo,
				tools: effectiveTools,
				userTimezone,
				userTime,
				userTimeFormat,
				contextFiles,
				promptContribution,
				nativeCommandGuidanceLines
			});
			return createSystemPromptOverride(transformProviderSystemPrompt({
				provider,
				config: params.config,
				workspaceDir: effectiveWorkspace,
				context: {
					config: params.config,
					agentDir,
					workspaceDir: effectiveWorkspace,
					provider,
					modelId,
					promptMode,
					runtimeChannel,
					runtimeCapabilities,
					agentId: sessionAgentId,
					systemPrompt: builtSystemPrompt
				}
			}));
		};
		const compactionTimeoutMs = resolveCompactionTimeoutMs(params.config);
		const sessionLock = await acquireSessionWriteLock({
			sessionFile: params.sessionFile,
			...resolveSessionWriteLockOptions(params.config, { maxHoldMsFallback: resolveSessionLockMaxHoldFromTimeout({ timeoutMs: compactionTimeoutMs }) })
		});
		try {
			await repairSessionFileIfNeeded({
				sessionFile: params.sessionFile,
				debug: (message) => log.debug(message),
				warn: (message) => log.warn(message)
			});
			await prewarmSessionFile(params.sessionFile);
			const transcriptPolicy = runtimePlan.transcript.resolvePolicy(runtimePlanModelContext);
			const sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
				agentId: sessionAgentId,
				sessionKey: params.sessionKey,
				config: params.config,
				contextWindowTokens: ctxInfo.tokens,
				allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
				missingToolResultText: model.api === "openai-responses" || model.api === "azure-openai-responses" || model.api === "openai-codex-responses" ? "aborted" : void 0,
				allowedToolNames
			});
			checkpointSnapshot = await captureCompactionCheckpointSnapshotAsync({
				sessionManager,
				sessionFile: params.sessionFile
			});
			compactionSessionManager = sessionManager;
			trackSessionManagerAccess(params.sessionFile);
			const settingsManager = createPreparedEmbeddedPiSettingsManager({
				cwd: effectiveWorkspace,
				agentDir,
				cfg: params.config,
				pluginMetadataSnapshot: getCurrentPluginMetadataSnapshot({
					config: params.config,
					env: process.env,
					workspaceDir: effectiveWorkspace
				}),
				contextTokenBudget: ctxInfo.tokens
			});
			const resourceLoader = createEmbeddedPiResourceLoader({
				cwd: resolvedWorkspace,
				agentDir,
				settingsManager,
				extensionFactories: buildEmbeddedExtensionFactories({
					cfg: params.config,
					sessionManager,
					provider,
					modelId,
					model
				})
			});
			await resourceLoader.reload();
			applyPiCompactionSettingsFromConfig({
				settingsManager,
				cfg: params.config,
				contextTokenBudget: ctxInfo.tokens
			});
			applyPiAutoCompactionGuard({
				settingsManager,
				silentOverflowProneProvider: isSilentOverflowProneModel({
					provider,
					modelId,
					baseUrl: effectiveModel.baseUrl ?? void 0
				})
			});
			const { customTools } = splitSdkTools({
				tools: effectiveTools,
				sandboxEnabled: !!sandbox?.enabled,
				toolHookContext: {
					agentId: sessionAgentId,
					config: params.config,
					cwd: effectiveWorkspace,
					sessionKey: sandboxSessionKey,
					sessionId: params.sessionId,
					runId: params.runId,
					channelId: params.currentChannelId
				}
			});
			const sessionToolAllowlist = toSessionToolAllowlist(collectRegisteredToolNames(customTools));
			const providerStreamFn = resolveCompactionProviderStream({
				effectiveModel,
				config: params.config,
				agentDir,
				effectiveWorkspace
			});
			while (true) {
				attemptedThinking.add(thinkLevel);
				let session;
				try {
					session = (await createAgentSession({
						cwd: effectiveWorkspace,
						agentDir,
						authStorage,
						modelRegistry,
						model: effectiveModel,
						thinkingLevel: mapThinkingLevel(thinkLevel),
						tools: sessionToolAllowlist,
						customTools,
						sessionManager,
						settingsManager,
						resourceLoader
					})).session;
					applySystemPromptOverrideToSession(session, buildSystemPromptOverride(thinkLevel)());
					session.setActiveToolsByName(sessionToolAllowlist);
					prepareCompactionSessionAgent({
						session,
						providerStreamFn,
						sessionId: params.sessionId,
						signal: runAbortController.signal,
						effectiveModel,
						resolvedApiKey: hasRuntimeAuthExchange ? void 0 : apiKeyInfo?.apiKey,
						authStorage,
						config: params.config,
						provider,
						modelId,
						thinkLevel,
						sessionAgentId,
						effectiveWorkspace,
						agentDir,
						runtimePlan
					});
					const dedupedValidated = dedupeDuplicateUserMessagesForCompaction(await validateReplayTurns({
						messages: await sanitizeSessionHistory({
							messages: session.messages,
							modelApi: model.api,
							modelId,
							provider,
							allowedToolNames,
							config: params.config,
							workspaceDir: effectiveWorkspace,
							env: process.env,
							model,
							sessionManager,
							sessionId: params.sessionId,
							policy: transcriptPolicy
						}),
						modelApi: model.api,
						modelId,
						provider,
						config: params.config,
						workspaceDir: effectiveWorkspace,
						env: process.env,
						model,
						sessionId: params.sessionId,
						policy: transcriptPolicy
					}));
					session.agent.state.messages = dedupedValidated;
					const originalMessages = session.messages.slice();
					const truncated = limitHistoryTurns(session.messages, getHistoryLimitFromSessionKey(params.sessionKey, params.config));
					const limited = transcriptPolicy.repairToolUseResultPairing ? sanitizeToolUseResultPairing(truncated, {
						erroredAssistantResultPolicy: "drop",
						...model.api === "openai-responses" || model.api === "azure-openai-responses" || model.api === "openai-codex-responses" ? { missingToolResultText: "aborted" } : {}
					}) : truncated;
					if (limited.length > 0) session.agent.state.messages = limited;
					const hookRunner = asCompactionHookRunner(getGlobalHookRunner());
					const observedTokenCount = normalizeObservedTokenCount(params.currentTokenCount);
					const beforeHookMetrics = buildBeforeCompactionHookMetrics({
						originalMessages,
						currentMessages: session.messages,
						observedTokenCount,
						estimateTokensFn: estimateTokens
					});
					const { hookSessionKey, missingSessionKey } = await runBeforeCompactionHooks({
						hookRunner,
						sessionId: params.sessionId,
						sessionKey: params.sessionKey,
						sessionAgentId,
						workspaceDir: effectiveWorkspace,
						messageProvider: resolvedMessageProvider,
						metrics: beforeHookMetrics,
						onHookMessages: params.onCompactionHookMessages
					});
					const { messageCountOriginal } = beforeHookMetrics;
					const diagEnabled = log.isEnabled("debug");
					const preMetrics = diagEnabled ? summarizeCompactionMessages(session.messages) : void 0;
					if (diagEnabled && preMetrics) {
						log.debug(`[compaction-diag] start runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} attempt=${attempt} maxAttempts=${maxAttempts} pre.messages=${preMetrics.messages} pre.historyTextChars=${preMetrics.historyTextChars} pre.toolResultChars=${preMetrics.toolResultChars} pre.estTokens=${preMetrics.estTokens ?? "unknown"}`);
						log.debug(`[compaction-diag] contributors diagId=${diagId} top=${JSON.stringify(preMetrics.contributors)}`);
					}
					if (!containsRealConversationMessages(session.messages)) {
						log.info(`[compaction] skipping — no real conversation messages (sessionKey=${params.sessionKey ?? params.sessionId})`);
						return {
							ok: true,
							compacted: false,
							reason: "no real conversation messages"
						};
					}
					const compactStartedAt = Date.now();
					const messageCountCompactionInput = messageCountOriginal;
					let fullSessionTokensBefore = 0;
					try {
						fullSessionTokensBefore = limited.reduce((sum, msg) => sum + estimateTokens(msg), 0);
					} catch {}
					const activeSession = session;
					const result = await compactWithSafetyTimeout(() => {
						setCompactionSafeguardCancelReason(compactionSessionManager, void 0);
						return activeSession.compact(params.customInstructions);
					}, compactionTimeoutMs, {
						abortSignal: params.abortSignal,
						onCancel: () => {
							activeSession.abortCompaction();
						}
					});
					let effectiveFirstKeptEntryId = result.firstKeptEntryId;
					let postCompactionLeafId = typeof sessionManager.getLeafId === "function" ? sessionManager.getLeafId() ?? void 0 : void 0;
					let transcriptRotationSessionManager = sessionManager;
					if (params.trigger === "manual") try {
						const hardenedBoundary = await hardenManualCompactionBoundary({
							sessionFile: params.sessionFile,
							preserveRecentTail: typeof params.config?.agents?.defaults?.compaction?.keepRecentTokens === "number"
						});
						if (hardenedBoundary.applied) {
							effectiveFirstKeptEntryId = hardenedBoundary.firstKeptEntryId ?? effectiveFirstKeptEntryId;
							postCompactionLeafId = hardenedBoundary.leafId ?? postCompactionLeafId;
							session.agent.state.messages = hardenedBoundary.messages;
							transcriptRotationSessionManager = await readTranscriptFileState(params.sessionFile);
						}
					} catch (err) {
						log.warn("[compaction] failed to harden manual compaction boundary", { errorMessage: formatErrorMessage(err) });
					}
					const tokensAfter = estimateTokensAfterCompaction({
						messagesAfter: session.messages,
						observedTokenCount,
						fullSessionTokensBefore,
						estimateTokensFn: estimateTokens
					});
					const messageCountAfter = session.messages.length;
					const compactedCount = Math.max(0, messageCountCompactionInput - messageCountAfter);
					let transcriptRotation = { rotated: false };
					if (shouldRotateCompactionTranscript(params.config)) try {
						transcriptRotation = await rotateTranscriptAfterCompaction({
							sessionManager: transcriptRotationSessionManager,
							sessionFile: params.sessionFile
						});
					} catch (err) {
						log.warn("[compaction] post-compaction transcript rotation failed", {
							errorMessage: formatErrorMessage(err),
							errorStack: err instanceof Error ? err.stack : void 0
						});
					}
					const activeSessionId = transcriptRotation.sessionId ?? params.sessionId;
					const activeSessionFile = transcriptRotation.sessionFile ?? params.sessionFile;
					const activePostLeafId = transcriptRotation.leafId ?? postCompactionLeafId;
					if (transcriptRotation.rotated) log.info(`[compaction] rotated active transcript after compaction (sessionKey=${params.sessionKey ?? params.sessionId})`);
					await runPostCompactionSideEffects({
						config: params.config,
						sessionKey: params.sessionKey,
						sessionFile: activeSessionFile
					});
					if (params.config && params.sessionKey && checkpointSnapshot) try {
						checkpointSnapshotRetained = await persistSessionCompactionCheckpoint({
							cfg: params.config,
							sessionKey: params.sessionKey,
							sessionId: activeSessionId,
							reason: resolveSessionCompactionCheckpointReason({ trigger: params.trigger }),
							snapshot: checkpointSnapshot,
							summary: result.summary,
							firstKeptEntryId: effectiveFirstKeptEntryId,
							tokensBefore: observedTokenCount ?? result.tokensBefore,
							tokensAfter,
							postSessionFile: activeSessionFile,
							postLeafId: activePostLeafId,
							postEntryId: activePostLeafId,
							createdAt: compactStartedAt
						}) !== null;
					} catch (err) {
						log.warn("failed to persist compaction checkpoint", { errorMessage: formatErrorMessage(err) });
					}
					const postMetrics = diagEnabled ? summarizeCompactionMessages(session.messages) : void 0;
					if (diagEnabled && preMetrics && postMetrics) log.debug(`[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} attempt=${attempt} maxAttempts=${maxAttempts} outcome=compacted reason=none durationMs=${Date.now() - compactStartedAt} retrying=false post.messages=${postMetrics.messages} post.historyTextChars=${postMetrics.historyTextChars} post.toolResultChars=${postMetrics.toolResultChars} post.estTokens=${postMetrics.estTokens ?? "unknown"} delta.messages=${postMetrics.messages - preMetrics.messages} delta.historyTextChars=${postMetrics.historyTextChars - preMetrics.historyTextChars} delta.toolResultChars=${postMetrics.toolResultChars - preMetrics.toolResultChars} delta.estTokens=${typeof preMetrics.estTokens === "number" && typeof postMetrics.estTokens === "number" ? postMetrics.estTokens - preMetrics.estTokens : "unknown"}`);
					await runAfterCompactionHooks({
						hookRunner,
						sessionId: activeSessionId,
						sessionAgentId,
						hookSessionKey,
						missingSessionKey,
						workspaceDir: effectiveWorkspace,
						messageProvider: resolvedMessageProvider,
						messageCountAfter,
						tokensAfter,
						compactedCount,
						sessionFile: activeSessionFile,
						summaryLength: typeof result.summary === "string" ? result.summary.length : void 0,
						tokensBefore: result.tokensBefore,
						firstKeptEntryId: effectiveFirstKeptEntryId,
						onHookMessages: params.onCompactionHookMessages
					});
					return {
						ok: true,
						compacted: true,
						result: {
							summary: result.summary,
							firstKeptEntryId: effectiveFirstKeptEntryId,
							tokensBefore: observedTokenCount ?? result.tokensBefore,
							tokensAfter,
							details: result.details,
							sessionId: transcriptRotation.sessionId,
							sessionFile: transcriptRotation.sessionFile
						}
					};
				} catch (err) {
					const fallbackThinking = pickFallbackThinkingLevel({
						message: formatErrorMessage(err),
						attempted: attemptedThinking
					});
					if (fallbackThinking) {
						log.warn(`[compaction] request rejected for ${provider}/${modelId}; retrying with ${fallbackThinking}`);
						thinkLevel = fallbackThinking;
						continue;
					}
					throw err;
				} finally {
					try {
						await flushPendingToolResultsAfterIdle({
							agent: session?.agent,
							sessionManager
						});
					} catch {}
					try {
						session?.dispose();
					} catch {}
				}
			}
		} finally {
			try {
				await bundleMcpRuntime?.dispose();
			} catch {}
			try {
				await bundleLspRuntime?.dispose();
			} catch {}
			await sessionLock.release();
		}
	} catch (err) {
		return fail(resolveCompactionFailureReason({
			reason: formatErrorMessage(err),
			safeguardCancelReason: consumeCompactionSafeguardCancelReason(compactionSessionManager)
		}), err);
	} finally {
		if (!checkpointSnapshotRetained) await cleanupCompactionCheckpointSnapshot(checkpointSnapshot);
		restoreSkillEnv?.();
	}
}
const testing = {
	hasRealConversationContent,
	hasMeaningfulConversationContent,
	containsRealConversationMessages,
	estimateTokensAfterCompaction,
	buildBeforeCompactionHookMetrics,
	hardenManualCompactionBoundary,
	resolveCompactionProviderStream,
	prepareCompactionSessionAgent,
	runBeforeCompactionHooks,
	runAfterCompactionHooks,
	runPostCompactionSideEffects
};
//#endregion
export { testing as __testing, testing, compactEmbeddedPiSessionDirect, runPostCompactionSideEffects };
