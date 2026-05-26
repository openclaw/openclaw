import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { m as resolveEffectiveModelFallbacks, x as resolveSubagentModelFallbacksOverride } from "./agent-scope-CtLXGcWm.js";
import { a as logWarn } from "./logger-0o2znY2U.js";
import { g as normalizeVerboseLevel } from "./thinking-DNSlsULp.js";
import { u as registerAgentRunContext } from "./agent-events-BuYtWSh4.js";
import { o as resolveSessionTranscriptPath } from "./paths-Bg3PO6Gj.js";
import { t as isCliProvider } from "./model-selection-cli-DS-HhXIv.js";
import { l as resolveBootstrapWarningSignaturesSeen } from "./bootstrap-budget-WP_UMPQC.js";
import { o as LiveSessionModelSwitchError, r as runWithModelFallback } from "./model-fallback-BCpDvqqS.js";
import { c as resolveCliRuntimeExecutionProvider } from "./model-runtime-aliases-D35Lx2no.js";
import { r as resolveCronAgentLane } from "./lanes-ReZ09_e4.js";
import { t as ensureSelectedAgentHarnessPlugin } from "./runtime-plugin-VHkAKsBb.js";
import { a as syncCronSessionLiveSelection, o as resolveCronChannelOutputPolicy, s as resolveCurrentChannelTarget } from "./run-session-state-UVBQbELh.js";
import { i as resolveCronPayloadOutcome } from "./helpers-CdmKDEvq.js";
import { n as isLikelyInterimCronMessage } from "./subagent-followup-hints-Q6xOcQiu.js";
//#region src/cron/isolated-agent/run-execution.runtime.ts
const cronExecutionCliRuntimeLoader = createLazyImportLoader(() => import("./run-execution-cli.runtime.js"));
async function loadCronExecutionCliRuntime() {
	return await cronExecutionCliRuntimeLoader.load();
}
async function getCliSessionId(...args) {
	return (await loadCronExecutionCliRuntime()).getCliSessionId(...args);
}
async function runCliAgent(...args) {
	return (await loadCronExecutionCliRuntime()).runCliAgent(...args);
}
//#endregion
//#region src/cron/isolated-agent/run-fallback-policy.ts
function resolveCronFallbacksOverride(params) {
	const payload = params.job.payload.kind === "agentTurn" ? params.job.payload : void 0;
	const payloadFallbacks = Array.isArray(payload?.fallbacks) ? payload.fallbacks : void 0;
	const hasCronPayloadModelOverride = typeof payload?.model === "string" && payload.model.trim().length > 0;
	if (payloadFallbacks !== void 0) return payloadFallbacks;
	if (params.useSubagentFallbacks === true && !hasCronPayloadModelOverride) {
		const subagentFallbacksOverride = resolveSubagentModelFallbacksOverride(params.cfg, params.agentId);
		if (subagentFallbacksOverride !== void 0) return subagentFallbacksOverride;
	}
	return resolveEffectiveModelFallbacks({
		cfg: params.cfg,
		agentId: params.agentId,
		hasSessionModelOverride: hasCronPayloadModelOverride,
		modelOverrideSource: hasCronPayloadModelOverride ? "auto" : void 0
	});
}
//#endregion
//#region src/cron/isolated-agent/run-executor.ts
const cronEmbeddedRuntimeLoader = createLazyImportLoader(() => import("./run-embedded.runtime.js"));
const cronSubagentRegistryRuntimeLoader = createLazyImportLoader(() => import("./run-subagent-registry.runtime.js"));
async function loadCronEmbeddedRuntime() {
	return await cronEmbeddedRuntimeLoader.load();
}
async function loadCronSubagentRegistryRuntime() {
	return await cronSubagentRegistryRuntimeLoader.load();
}
const COMMAND_STYLE_CRON_PREFIX = /^(?:(?:[A-Z_][A-Z0-9_]*=\S+\s+)+)?(?:cd\s+\S+|(?:\.{1,2}|~)?\/\S+|[A-Za-z]:[\\/]\S+|(?:bash|bun|cargo|deno|docker|gh|git|go|make|node|npm|npx|pnpm|python|python3|ruby|sh|tsx|uv|zsh)\b)/u;
function isCommandStyleCronMessage(message) {
	const trimmed = message.trim();
	if (!trimmed || trimmed.includes("\n")) return false;
	return COMMAND_STYLE_CRON_PREFIX.test(trimmed);
}
function resolveCronBootstrapContextMode(payload) {
	if (payload?.lightContext === true) return "lightweight";
	if (payload?.lightContext === false) return;
	return isCommandStyleCronMessage(payload?.message ?? "") ? "lightweight" : void 0;
}
function createCronPromptExecutor(params) {
	const sessionFile = params.cronSession.sessionEntry.sessionFile?.trim() || resolveSessionTranscriptPath(params.cronSession.sessionEntry.sessionId, params.agentId);
	if (!params.cronSession.sessionEntry.sessionFile?.trim()) params.cronSession.sessionEntry.sessionFile = sessionFile;
	const cronFallbacksOverride = resolveCronFallbacksOverride({
		cfg: params.cfg,
		job: params.job,
		agentId: params.agentId,
		useSubagentFallbacks: params.useSubagentFallbacks
	});
	let runResult;
	let fallbackProvider = params.liveSelection.provider;
	let fallbackModel = params.liveSelection.model;
	let runEndedAt = Date.now();
	let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(params.cronSession.sessionEntry.systemPromptReport);
	const bootstrapContextMode = resolveCronBootstrapContextMode(params.agentPayload);
	const sourceReplyDeliveryMode = params.sourceDelivery.sourceReplyDeliveryMode;
	const messageChannel = params.sourceDelivery.target.channel ?? params.resolvedDelivery.channel;
	const runPrompt = async (promptText) => {
		const fallbackResult = await runWithModelFallback({
			cfg: params.cfgWithAgentDefaults,
			provider: params.liveSelection.provider,
			model: params.liveSelection.model,
			runId: params.cronSession.sessionEntry.sessionId,
			sessionId: params.cronSession.sessionEntry.sessionId,
			lane: resolveCronAgentLane(params.lane),
			agentDir: params.agentDir,
			agentId: params.agentId,
			sessionKey: params.runSessionKey,
			prepareAgentHarnessRuntime: async ({ provider, model, agentHarnessRuntimeOverride }) => {
				await ensureSelectedAgentHarnessPlugin({
					config: params.cfgWithAgentDefaults,
					provider,
					modelId: model,
					agentId: params.agentId,
					sessionKey: params.runSessionKey,
					agentHarnessRuntimeOverride,
					workspaceDir: params.workspaceDir
				});
			},
			fallbacksOverride: cronFallbacksOverride,
			run: async (providerOverride, modelOverride, runOptions) => {
				if (params.abortSignal?.aborted) throw new Error(params.abortReason());
				const executionProvider = resolveCliRuntimeExecutionProvider({
					provider: providerOverride,
					cfg: params.cfgWithAgentDefaults,
					agentId: params.agentId,
					modelId: modelOverride
				}) ?? providerOverride;
				const bootstrapPromptWarningSignature = bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
				if (isCliProvider(executionProvider, params.cfgWithAgentDefaults)) {
					const cliSessionId = params.cronSession.isNewSession ? void 0 : await getCliSessionId(params.cronSession.sessionEntry, executionProvider);
					const result = await runCliAgent({
						sessionId: params.cronSession.sessionEntry.sessionId,
						sessionKey: params.runSessionKey,
						agentId: params.agentId,
						trigger: "cron",
						jobId: params.job.id,
						sessionFile,
						workspaceDir: params.workspaceDir,
						config: params.cfgWithAgentDefaults,
						prompt: promptText,
						provider: executionProvider,
						model: modelOverride,
						thinkLevel: params.thinkLevel,
						timeoutMs: params.timeoutMs,
						runId: params.cronSession.sessionEntry.sessionId,
						lane: resolveCronAgentLane(params.lane),
						cliSessionId,
						skillsSnapshot: params.skillsSnapshot,
						messageChannel,
						sourceReplyDeliveryMode,
						abortSignal: params.abortSignal,
						onExecutionStarted: params.onExecutionStarted,
						onExecutionPhase: params.onExecutionPhase,
						bootstrapContextMode,
						bootstrapContextRunKind: "cron",
						bootstrapPromptWarningSignaturesSeen,
						bootstrapPromptWarningSignature
					});
					bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(result.meta?.systemPromptReport);
					return result;
				}
				const { resolveFastModeState, runEmbeddedPiAgent } = await loadCronEmbeddedRuntime();
				const currentChannelId = await resolveCurrentChannelTarget({
					channel: messageChannel,
					to: params.resolvedDelivery.to,
					threadId: params.resolvedDelivery.threadId
				});
				const result = await runEmbeddedPiAgent({
					sessionId: params.cronSession.sessionEntry.sessionId,
					sessionKey: params.runSessionKey,
					agentId: params.agentId,
					trigger: "cron",
					jobId: params.job.id,
					cleanupBundleMcpOnRunEnd: params.job.sessionTarget === "isolated",
					allowGatewaySubagentBinding: true,
					messageChannel,
					agentAccountId: params.resolvedDelivery.accountId,
					messageTo: params.resolvedDelivery.to,
					messageThreadId: params.resolvedDelivery.threadId,
					currentChannelId,
					sessionFile,
					agentDir: params.agentDir,
					workspaceDir: params.workspaceDir,
					config: params.cfgWithAgentDefaults,
					skillsSnapshot: params.skillsSnapshot,
					prompt: promptText,
					lane: resolveCronAgentLane(params.lane),
					provider: providerOverride,
					model: modelOverride,
					modelFallbacksOverride: cronFallbacksOverride,
					authProfileId: params.liveSelection.authProfileId,
					authProfileIdSource: params.liveSelection.authProfileId ? params.liveSelection.authProfileIdSource : void 0,
					thinkLevel: params.thinkLevel,
					fastMode: resolveFastModeState({
						cfg: params.cfgWithAgentDefaults,
						provider: providerOverride,
						model: modelOverride,
						agentId: params.agentId,
						sessionEntry: params.cronSession.sessionEntry
					}).enabled,
					verboseLevel: params.resolvedVerboseLevel,
					timeoutMs: params.timeoutMs,
					runTimeoutOverrideMs: params.runTimeoutOverrideMs,
					bootstrapContextMode,
					bootstrapContextRunKind: "cron",
					toolsAllow: params.agentPayload?.toolsAllow,
					execOverrides: params.suppressExecNotifyOnExit ? {
						notifyOnExit: false,
						notifyOnExitEmptySuccess: false
					} : void 0,
					sourceReplyDeliveryMode,
					runId: params.cronSession.sessionEntry.sessionId,
					requireExplicitMessageTarget: params.sourceDelivery.messageTool.requireExplicitTarget,
					disableMessageTool: !params.sourceDelivery.messageTool.enabled,
					forceMessageTool: params.sourceDelivery.messageTool.force,
					allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
					abortSignal: params.abortSignal,
					onExecutionStarted: params.onExecutionStarted,
					onExecutionPhase: params.onExecutionPhase,
					bootstrapPromptWarningSignaturesSeen,
					bootstrapPromptWarningSignature
				});
				bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(result.meta?.systemPromptReport);
				return result;
			}
		});
		runResult = fallbackResult.result;
		fallbackProvider = fallbackResult.provider;
		fallbackModel = fallbackResult.model;
		params.liveSelection.provider = fallbackResult.provider;
		params.liveSelection.model = fallbackResult.model;
		runEndedAt = Date.now();
	};
	return {
		runPrompt,
		getState: () => ({
			runResult,
			fallbackProvider,
			fallbackModel,
			runEndedAt,
			liveSelection: params.liveSelection
		})
	};
}
async function executeCronRun(params) {
	const resolvedVerboseLevel = normalizeVerboseLevel(params.cronSession.sessionEntry.verboseLevel) ?? normalizeVerboseLevel(params.agentVerboseDefault) ?? "off";
	registerAgentRunContext(params.cronSession.sessionEntry.sessionId, {
		sessionKey: params.runSessionKey,
		verboseLevel: resolvedVerboseLevel
	});
	const executor = createCronPromptExecutor({
		cfg: params.cfg,
		cfgWithAgentDefaults: params.cfgWithAgentDefaults,
		job: params.job,
		agentId: params.agentId,
		agentDir: params.agentDir,
		agentSessionKey: params.agentSessionKey,
		runSessionKey: params.runSessionKey,
		workspaceDir: params.workspaceDir,
		lane: params.lane,
		resolvedVerboseLevel,
		thinkLevel: params.thinkLevel,
		timeoutMs: params.timeoutMs,
		runTimeoutOverrideMs: params.runTimeoutOverrideMs,
		suppressExecNotifyOnExit: params.suppressExecNotifyOnExit,
		resolvedDelivery: params.resolvedDelivery,
		sourceDelivery: params.sourceDelivery,
		skillsSnapshot: params.skillsSnapshot,
		agentPayload: params.agentPayload,
		useSubagentFallbacks: params.useSubagentFallbacks,
		liveSelection: params.liveSelection,
		cronSession: params.cronSession,
		abortSignal: params.abortSignal,
		abortReason: params.abortReason,
		onExecutionStarted: params.onExecutionStarted,
		onExecutionPhase: params.onExecutionPhase
	});
	const runStartedAt = params.runStartedAt ?? Date.now();
	const MAX_MODEL_SWITCH_RETRIES = 2;
	let modelSwitchRetries = 0;
	while (true) try {
		await executor.runPrompt(params.commandBody);
		break;
	} catch (err) {
		if (!(err instanceof LiveSessionModelSwitchError)) throw err;
		modelSwitchRetries += 1;
		if (modelSwitchRetries > MAX_MODEL_SWITCH_RETRIES) {
			logWarn(`[cron:${params.job.id}] LiveSessionModelSwitchError retry limit reached (${MAX_MODEL_SWITCH_RETRIES}); aborting`);
			throw err;
		}
		params.liveSelection.provider = err.provider;
		params.liveSelection.model = err.model;
		params.liveSelection.authProfileId = err.authProfileId;
		params.liveSelection.authProfileIdSource = err.authProfileId ? err.authProfileIdSource : void 0;
		syncCronSessionLiveSelection({
			entry: params.cronSession.sessionEntry,
			liveSelection: params.liveSelection
		});
		try {
			await params.persistSessionEntry();
		} catch (persistErr) {
			logWarn(`[cron:${params.job.id}] Failed to persist model switch session entry: ${String(persistErr)}`);
		}
		continue;
	}
	let { runResult, fallbackProvider, fallbackModel, runEndedAt } = executor.getState();
	if (!runResult) throw new Error("cron isolated run returned no result");
	if (!params.isAborted()) {
		const interimPayloads = runResult.payloads ?? [];
		const { deliveryPayloadHasStructuredContent: interimPayloadHasStructuredContent, hasFatalErrorPayload: interimHasFatalErrorPayload, outputText: interimOutputText } = resolveCronPayloadOutcome({
			payloads: interimPayloads,
			runLevelError: runResult.meta?.error,
			failureSignal: runResult.meta?.failureSignal,
			finalAssistantVisibleText: runResult.meta?.finalAssistantVisibleText,
			preferFinalAssistantVisibleText: (await resolveCronChannelOutputPolicy(params.resolvedDelivery.channel)).preferFinalAssistantVisibleText
		});
		const interimText = interimOutputText?.trim() ?? "";
		const shouldRetryInterimAck = !runResult.meta?.error && !interimHasFatalErrorPayload && !runResult.didSendViaMessagingTool && !interimPayloadHasStructuredContent && !interimPayloads.some((payload) => payload?.isError === true) && isLikelyInterimCronMessage(interimText);
		let hasFreshDescendants = false;
		let hasActiveDescendants = false;
		if (shouldRetryInterimAck) {
			const { countActiveDescendantRuns, listDescendantRunsForRequester } = await loadCronSubagentRegistryRuntime();
			hasFreshDescendants = listDescendantRunsForRequester(params.runSessionKey).some((entry) => {
				const descendantStartedAt = typeof entry.startedAt === "number" ? entry.startedAt : entry.createdAt;
				return typeof descendantStartedAt === "number" && descendantStartedAt >= runStartedAt;
			});
			hasActiveDescendants = countActiveDescendantRuns(params.runSessionKey) > 0;
		}
		if (shouldRetryInterimAck && !hasFreshDescendants && !hasActiveDescendants) {
			const continuationPrompt = [
				"Your previous response was only an acknowledgement and did not complete this cron task.",
				"Complete the original task now.",
				"Do not send a status update like 'on it'.",
				"Use tools when needed, including sessions_spawn for parallel subtasks, wait for spawned subagents to finish, then return only the final summary."
			].join(" ");
			await executor.runPrompt(continuationPrompt);
			({runResult, fallbackProvider, fallbackModel, runEndedAt} = executor.getState());
		}
	}
	if (!runResult) throw new Error("cron isolated run returned no result");
	return {
		runResult,
		fallbackProvider,
		fallbackModel,
		runStartedAt,
		runEndedAt,
		liveSelection: params.liveSelection
	};
}
//#endregion
export { executeCronRun };
