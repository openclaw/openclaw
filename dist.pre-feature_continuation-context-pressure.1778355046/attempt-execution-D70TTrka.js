import { t as sanitizeForLog } from "./ansi-Dqm1lzVL.js";
import { t as createSubsystemLogger } from "./subsystem-DNg_cpPU.js";
import { n as annotateInterSessionPromptText } from "./input-provenance-CP-_Moom.js";
import { n as ensureAuthProfileStore } from "./store-CWaY5GDh.js";
import { i as emitAgentEvent } from "./agent-events-NWmMKpmM.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-C2gz-tl8.js";
import { c as resolveSessionWriteLockAcquireTimeoutMs, r as acquireSessionWriteLock } from "./session-write-lock-vddWzh3p.js";
import { i as resolveSessionTranscriptFile, o as appendSessionTranscriptMessage } from "./transcript-Dlrr7XVN.js";
import { t as isCliProvider } from "./model-selection-cli-Dl_STjo6.js";
import "./model-selection-CyWx9aXc.js";
import { n as resolveAuthProfileOrder } from "./order-DrCfqEY2.js";
import { a as resolveCliRuntimeExecutionProvider, t as isCliRuntimeAlias } from "./model-runtime-aliases-DHvS2C_F.js";
import { n as resolveAgentHarnessPolicy } from "./selection-6cKfH77r.js";
import { s as resolveBootstrapWarningSignaturesSeen } from "./bootstrap-budget-YeDhZ3ip.js";
import { t as FailoverError } from "./failover-error-CLUtypYD.js";
import { q as buildUsageWithNoCost } from "./compaction-successor-transcript-CwAUbJxG.js";
import { t as normalizeReplyPayload } from "./normalize-reply-Bk_cykA3.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-CriluRHn.js";
import { i as buildAgentRuntimeAuthPlan } from "./build-BTsZ4HxF.js";
import { t as runCliAgent } from "./cli-runner-30Q89d5L.js";
import { r as getCliSessionBinding, s as setCliSessionBinding } from "./cli-session-BKjwxryx.js";
import { i as resolveFallbackRetryPrompt, n as claudeCliSessionTranscriptHasContent, t as buildClaudeCliFallbackContextPrelude } from "./attempt-execution.helpers-D8JQEttB.js";
import { t as persistSessionEntry } from "./attempt-execution.shared-Lhjblrew.js";
import { t as clearCliSessionInStore } from "./session-store-DlSLSEjP.js";
//#region src/agents/command/attempt-execution.ts
const log = createSubsystemLogger("agents/agent-command");
const ACP_TRANSCRIPT_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0
	}
};
function resolveProfileProviderFromStore(params) {
	const profileId = params.profileId?.trim();
	if (!profileId) return;
	return ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }).profiles[profileId]?.provider;
}
function resolveHarnessAuthProfileSelection(params) {
	const sessionAuthProfileId = params.sessionAuthProfileId?.trim();
	if (sessionAuthProfileId) return {
		authProfileId: sessionAuthProfileId,
		authProfileIdSource: params.sessionAuthProfileSource,
		authProfileProvider: resolveProfileProviderFromStore({
			agentDir: params.agentDir,
			profileId: sessionAuthProfileId
		}) ?? params.authProfileProvider
	};
	const harnessAuthProvider = buildAgentRuntimeAuthPlan({
		provider: params.provider,
		authProfileProvider: params.authProfileProvider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		harnessId: params.harnessId,
		harnessRuntime: params.harnessRuntime,
		allowHarnessAuthProfileForwarding: params.allowHarnessAuthProfileForwarding
	}).harnessAuthProvider;
	if (!harnessAuthProvider) return { authProfileProvider: params.authProfileProvider };
	const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
	const authProfileId = resolveAuthProfileOrder({
		cfg: params.config,
		store,
		provider: harnessAuthProvider
	})[0];
	return authProfileId ? {
		authProfileId,
		authProfileIdSource: "auto",
		authProfileProvider: harnessAuthProvider
	} : { authProfileProvider: params.authProfileProvider };
}
function resolveTranscriptUsage(usage) {
	if (!usage) return ACP_TRANSCRIPT_USAGE;
	return buildUsageWithNoCost({
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.total
	});
}
async function persistTextTurnTranscript(params) {
	const promptText = params.transcriptBody ?? params.body;
	const replyText = params.finalText;
	if (!promptText && !replyText) return params.sessionEntry;
	const { sessionFile, sessionEntry } = await resolveSessionTranscriptFile({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		sessionEntry: params.sessionEntry,
		sessionStore: params.sessionStore,
		storePath: params.storePath,
		agentId: params.sessionAgentId,
		threadId: params.threadId
	});
	const lock = await acquireSessionWriteLock({
		sessionFile,
		timeoutMs: resolveSessionWriteLockAcquireTimeoutMs(params.config),
		allowReentrant: true
	});
	try {
		if (promptText) await appendSessionTranscriptMessage({
			transcriptPath: sessionFile,
			sessionId: params.sessionId,
			cwd: params.sessionCwd,
			config: params.config,
			message: {
				role: "user",
				content: promptText,
				timestamp: Date.now()
			}
		});
		if (replyText) await appendSessionTranscriptMessage({
			transcriptPath: sessionFile,
			sessionId: params.sessionId,
			cwd: params.sessionCwd,
			config: params.config,
			message: {
				role: "assistant",
				content: [{
					type: "text",
					text: replyText
				}],
				api: params.assistant.api,
				provider: params.assistant.provider,
				model: params.assistant.model,
				usage: resolveTranscriptUsage(params.assistant.usage),
				stopReason: "stop",
				timestamp: Date.now()
			}
		});
	} finally {
		await lock.release();
	}
	emitSessionTranscriptUpdate({
		sessionFile,
		sessionKey: params.sessionKey
	});
	return sessionEntry;
}
function resolveCliTranscriptReplyText(result) {
	const visibleText = result.meta.finalAssistantVisibleText?.trim();
	if (visibleText) return visibleText;
	return (result.payloads ?? []).filter((payload) => !payload.isError && !payload.isReasoning).map((payload) => payload.text?.trim() ?? "").filter(Boolean).join("\n\n");
}
function isClaudeCliProvider(provider) {
	return provider.trim().toLowerCase() === "claude-cli";
}
async function persistAcpTurnTranscript(params) {
	return await persistTextTurnTranscript({
		...params,
		assistant: {
			api: "openai-responses",
			provider: "openclaw",
			model: "acp-runtime"
		}
	});
}
async function persistCliTurnTranscript(params) {
	const replyText = resolveCliTranscriptReplyText(params.result);
	const provider = params.result.meta.agentMeta?.provider?.trim() ?? "cli";
	const model = params.result.meta.agentMeta?.model?.trim() ?? "default";
	return await persistTextTurnTranscript({
		body: params.body,
		transcriptBody: params.transcriptBody,
		finalText: replyText,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		sessionEntry: params.sessionEntry,
		sessionStore: params.sessionStore,
		storePath: params.storePath,
		sessionAgentId: params.sessionAgentId,
		threadId: params.threadId,
		sessionCwd: params.sessionCwd,
		config: params.config,
		assistant: {
			api: "cli",
			provider,
			model,
			usage: params.result.meta.agentMeta?.usage
		}
	});
}
function runAgentAttempt(params) {
	const isRawModelRun = params.opts.modelRun === true || params.opts.promptMode === "none";
	const claudeCliFallbackPrelude = !isRawModelRun && params.isFallbackRetry && isClaudeCliProvider(params.originalProvider) && !isClaudeCliProvider(params.providerOverride) ? buildClaudeCliFallbackContextPrelude({ cliSessionId: getCliSessionBinding(params.sessionEntry, "claude-cli")?.sessionId }) : "";
	const resolvedPrompt = resolveFallbackRetryPrompt({
		body: params.body,
		isFallbackRetry: params.isFallbackRetry,
		sessionHasHistory: params.sessionHasHistory,
		priorContextPrelude: claudeCliFallbackPrelude
	});
	const effectivePrompt = isRawModelRun ? resolvedPrompt : annotateInterSessionPromptText(resolvedPrompt, params.opts.inputProvenance);
	const bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(params.sessionEntry?.systemPromptReport);
	const bootstrapPromptWarningSignature = bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
	const sessionPinnedAgentHarnessId = isRawModelRun ? "pi" : resolveSessionPinnedAgentHarnessId({
		cfg: params.cfg,
		sessionAgentId: params.sessionAgentId,
		sessionEntry: params.sessionEntry,
		sessionHasHistory: params.sessionHasHistory,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey ?? params.sessionId
	});
	const agentRuntimeOverride = isRawModelRun ? void 0 : params.sessionEntry?.agentRuntimeOverride?.trim();
	const cliExecutionProvider = isRawModelRun ? params.providerOverride : resolveCliRuntimeExecutionProvider({
		provider: params.providerOverride,
		cfg: params.cfg,
		agentId: params.sessionAgentId,
		runtimeOverride: agentRuntimeOverride
	}) ?? params.providerOverride;
	const agentHarnessPolicy = isRawModelRun ? { runtime: "pi" } : resolveAgentHarnessPolicy({
		provider: params.providerOverride,
		modelId: params.modelOverride,
		config: params.cfg,
		agentId: params.sessionAgentId,
		sessionKey: params.sessionKey ?? params.sessionId
	});
	const harnessAuthSelection = resolveHarnessAuthProfileSelection({
		config: params.cfg,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		provider: params.providerOverride,
		authProfileProvider: params.authProfileProvider,
		sessionAuthProfileId: params.sessionEntry?.authProfileOverride,
		sessionAuthProfileSource: params.sessionEntry?.authProfileOverrideSource,
		harnessId: sessionPinnedAgentHarnessId,
		harnessRuntime: agentHarnessPolicy.runtime,
		allowHarnessAuthProfileForwarding: !isCliProvider(cliExecutionProvider, params.cfg)
	});
	const authProfileId = buildAgentRuntimeAuthPlan({
		provider: params.providerOverride,
		authProfileProvider: harnessAuthSelection.authProfileProvider,
		sessionAuthProfileId: harnessAuthSelection.authProfileId,
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		harnessId: sessionPinnedAgentHarnessId,
		harnessRuntime: agentHarnessPolicy.runtime,
		allowHarnessAuthProfileForwarding: !isCliProvider(cliExecutionProvider, params.cfg)
	}).forwardedAuthProfileId;
	if (!isRawModelRun && isCliProvider(cliExecutionProvider, params.cfg)) {
		const cliSessionBinding = getCliSessionBinding(params.sessionEntry, cliExecutionProvider);
		const resolveReusableCliSessionBinding = async () => {
			if (!isClaudeCliProvider(cliExecutionProvider) || !cliSessionBinding?.sessionId || await claudeCliSessionTranscriptHasContent({ sessionId: cliSessionBinding.sessionId })) return cliSessionBinding;
			log.warn(`cli session reset: provider=${sanitizeForLog(cliExecutionProvider)} reason=transcript-missing sessionKey=${params.sessionKey ?? params.sessionId}`);
			if (params.sessionKey && params.sessionStore && params.storePath) params.sessionEntry = await clearCliSessionInStore({
				provider: cliExecutionProvider,
				sessionKey: params.sessionKey,
				sessionStore: params.sessionStore,
				storePath: params.storePath
			}) ?? params.sessionEntry;
		};
		const runCliWithSession = (nextCliSessionId, activeCliSessionBinding = cliSessionBinding) => runCliAgent({
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			agentId: params.sessionAgentId,
			trigger: "user",
			sessionFile: params.sessionFile,
			workspaceDir: params.workspaceDir,
			config: params.cfg,
			prompt: effectivePrompt,
			provider: cliExecutionProvider,
			model: params.modelOverride,
			thinkLevel: params.resolvedThinkLevel,
			timeoutMs: params.timeoutMs,
			runId: params.runId,
			extraSystemPrompt: params.opts.extraSystemPrompt,
			inputProvenance: params.opts.inputProvenance,
			cliSessionId: nextCliSessionId,
			cliSessionBinding: nextCliSessionId === activeCliSessionBinding?.sessionId ? activeCliSessionBinding : void 0,
			authProfileId,
			bootstrapPromptWarningSignaturesSeen,
			bootstrapPromptWarningSignature,
			images: params.isFallbackRetry ? void 0 : params.opts.images,
			imageOrder: params.isFallbackRetry ? void 0 : params.opts.imageOrder,
			skillsSnapshot: params.skillsSnapshot,
			messageChannel: params.messageChannel,
			streamParams: params.opts.streamParams,
			messageProvider: params.opts.messageProvider ?? params.messageChannel,
			agentAccountId: params.runContext.accountId,
			senderIsOwner: params.opts.senderIsOwner,
			cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
			cleanupCliLiveSessionOnRunEnd: params.opts.cleanupCliLiveSessionOnRunEnd
		});
		return resolveReusableCliSessionBinding().then(async (activeCliSessionBinding) => {
			try {
				return await runCliWithSession(activeCliSessionBinding?.sessionId, activeCliSessionBinding);
			} catch (err) {
				if (err instanceof FailoverError && err.reason === "session_expired" && activeCliSessionBinding?.sessionId && params.sessionKey && params.sessionStore && params.storePath) {
					log.warn(`CLI session expired, clearing from session store: provider=${sanitizeForLog(cliExecutionProvider)} sessionKey=${params.sessionKey}`);
					params.sessionEntry = await clearCliSessionInStore({
						provider: cliExecutionProvider,
						sessionKey: params.sessionKey,
						sessionStore: params.sessionStore,
						storePath: params.storePath
					}) ?? params.sessionEntry;
					return await runCliWithSession(void 0).then(async (result) => {
						if (result.meta.agentMeta?.cliSessionBinding?.sessionId && params.sessionKey && params.sessionStore && params.storePath) {
							const entry = params.sessionStore[params.sessionKey];
							if (entry) {
								const updatedEntry = { ...entry };
								setCliSessionBinding(updatedEntry, cliExecutionProvider, result.meta.agentMeta.cliSessionBinding);
								updatedEntry.updatedAt = Date.now();
								await persistSessionEntry({
									sessionStore: params.sessionStore,
									sessionKey: params.sessionKey,
									storePath: params.storePath,
									entry: updatedEntry
								});
							}
						}
						return result;
					});
				}
				throw err;
			}
		});
	}
	return runEmbeddedPiAgent({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		agentId: params.sessionAgentId,
		trigger: "user",
		messageChannel: params.messageChannel,
		messageProvider: params.opts.messageProvider ?? params.messageChannel,
		agentAccountId: params.runContext.accountId,
		messageTo: params.opts.replyTo ?? params.opts.to,
		messageThreadId: params.opts.threadId,
		groupId: params.runContext.groupId,
		groupChannel: params.runContext.groupChannel,
		groupSpace: params.runContext.groupSpace,
		spawnedBy: params.spawnedBy,
		currentChannelId: params.runContext.currentChannelId,
		currentThreadTs: params.runContext.currentThreadTs,
		replyToMode: params.runContext.replyToMode,
		hasRepliedRef: params.runContext.hasRepliedRef,
		senderIsOwner: params.opts.senderIsOwner,
		sessionFile: params.sessionFile,
		workspaceDir: params.workspaceDir,
		config: params.cfg,
		agentHarnessId: sessionPinnedAgentHarnessId,
		skillsSnapshot: params.skillsSnapshot,
		prompt: effectivePrompt,
		images: params.isFallbackRetry ? void 0 : params.opts.images,
		imageOrder: params.isFallbackRetry ? void 0 : params.opts.imageOrder,
		clientTools: params.opts.clientTools,
		provider: params.providerOverride,
		model: params.modelOverride,
		modelFallbacksOverride: params.modelFallbacksOverride,
		authProfileId,
		authProfileIdSource: authProfileId ? harnessAuthSelection.authProfileIdSource : void 0,
		thinkLevel: params.resolvedThinkLevel,
		fastMode: params.fastMode,
		verboseLevel: params.resolvedVerboseLevel,
		timeoutMs: params.timeoutMs,
		runId: params.runId,
		lane: params.opts.lane,
		abortSignal: params.opts.abortSignal,
		extraSystemPrompt: params.opts.extraSystemPrompt,
		bootstrapContextMode: params.opts.bootstrapContextMode,
		bootstrapContextRunKind: params.opts.bootstrapContextRunKind,
		drainsContinuationDelegateQueue: params.opts.drainsContinuationDelegateQueue,
		internalEvents: params.opts.internalEvents,
		inputProvenance: params.opts.inputProvenance,
		streamParams: params.opts.streamParams,
		agentDir: params.agentDir,
		allowTransientCooldownProbe: params.allowTransientCooldownProbe,
		cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
		modelRun: params.opts.modelRun,
		promptMode: params.opts.promptMode,
		disableTools: params.opts.modelRun === true,
		onAgentEvent: params.onAgentEvent,
		suppressNextUserMessagePersistence: params.suppressPromptPersistenceOnRetry === true,
		onUserMessagePersisted: params.onUserMessagePersisted,
		bootstrapPromptWarningSignaturesSeen,
		bootstrapPromptWarningSignature
	});
}
function resolveSessionPinnedAgentHarnessId(params) {
	if (params.sessionEntry?.sessionId !== params.sessionId) return resolveConfiguredAgentHarnessId(params);
	if (params.sessionEntry.agentHarnessId) return params.sessionEntry.agentHarnessId;
	const configuredAgentHarnessId = resolveConfiguredAgentHarnessId(params);
	if (configuredAgentHarnessId) return configuredAgentHarnessId;
	if (!params.sessionHasHistory) return;
	return "pi";
}
function resolveConfiguredAgentHarnessId(params) {
	const policy = resolveAgentHarnessPolicy({
		config: params.cfg,
		agentId: params.sessionAgentId,
		sessionKey: params.sessionKey
	});
	if (policy.runtime === "auto" || isCliRuntimeAlias(policy.runtime)) return;
	return policy.runtime;
}
function buildAcpResult(params) {
	const normalizedFinalPayload = normalizeReplyPayload({ text: params.payloadText });
	return {
		payloads: normalizedFinalPayload ? [normalizedFinalPayload] : [],
		meta: {
			durationMs: Date.now() - params.startedAt,
			aborted: params.abortSignal?.aborted === true,
			stopReason: params.stopReason
		}
	};
}
function emitAcpLifecycleStart(params) {
	emitAgentEvent({
		runId: params.runId,
		stream: "lifecycle",
		data: {
			phase: "start",
			startedAt: params.startedAt
		}
	});
}
function emitAcpLifecycleEnd(params) {
	emitAgentEvent({
		runId: params.runId,
		stream: "lifecycle",
		data: {
			phase: "end",
			endedAt: Date.now()
		}
	});
}
function emitAcpLifecycleError(params) {
	emitAgentEvent({
		runId: params.runId,
		stream: "lifecycle",
		data: {
			phase: "error",
			error: params.message,
			endedAt: Date.now()
		}
	});
}
function emitAcpAssistantDelta(params) {
	emitAgentEvent({
		runId: params.runId,
		stream: "assistant",
		data: {
			text: params.text,
			delta: params.delta
		}
	});
}
//#endregion
export { emitAcpLifecycleStart as a, runAgentAttempt as c, emitAcpLifecycleError as i, emitAcpAssistantDelta as n, persistAcpTurnTranscript as o, emitAcpLifecycleEnd as r, persistCliTurnTranscript as s, buildAcpResult as t };
