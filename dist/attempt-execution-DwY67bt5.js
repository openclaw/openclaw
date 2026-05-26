import { s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { c as readErrorName } from "./errors-b3ZrCRlt.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { r as annotateInterSessionPromptText } from "./input-provenance-CmqYxlZ2.js";
import { l as resolveOpenAIRuntimeProviderForPi } from "./openai-codex-routing-DwRY-_VI.js";
import { i as emitAgentEvent } from "./agent-events-BuYtWSh4.js";
import { a as resolveSessionTranscriptFile, c as appendSessionTranscriptMessage, i as readTailAssistantTextFromSessionTranscript } from "./transcript-BA0Ngd-A.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-ClYG_P1o.js";
import { d as resolveSessionWriteLockOptions, i as acquireSessionWriteLock } from "./session-write-lock-_a5O1H8L.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { t as isCliProvider } from "./model-selection-cli-DS-HhXIv.js";
import "./model-selection-P-81eBKx.js";
import { r as formatAcpErrorChain } from "./errors-BgH2aVJW.js";
import { at as buildUsageWithNoCost, n as resolveAvailableAgentHarnessPolicy } from "./selection-hR-AeOeU.js";
import { l as resolveBootstrapWarningSignaturesSeen } from "./bootstrap-budget-WP_UMPQC.js";
import { t as FailoverError } from "./failover-error-CZCIurQK.js";
import { i as resolveAuthProfileOrder } from "./order-DJrj83KE.js";
import { t as normalizeReplyPayload } from "./normalize-reply-yKKEXSMw.js";
import { c as resolveCliRuntimeExecutionProvider } from "./model-runtime-aliases-D35Lx2no.js";
import { r as getCliSessionBinding, s as setCliSessionBinding } from "./cli-session-FftCLDUT.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-CsSFzly6.js";
import { t as buildAgentRuntimeAuthPlan } from "./auth-BE2XVbyx.js";
import { t as runCliAgent } from "./cli-runner-BZsJFWmR.js";
import { t as persistSessionEntry } from "./attempt-execution.shared-BaO8yVdt.js";
import { i as resolveFallbackRetryPrompt, n as claudeCliSessionTranscriptHasContent, t as buildClaudeCliFallbackContextPrelude } from "./attempt-execution.helpers-C_PgVel2.js";
import { t as clearCliSessionInStore } from "./session-store-LyaMh5nn.js";
//#region src/agents/command/attempt-execution.ts
const log = createSubsystemLogger("agents/agent-command");
function shouldClearReusedCliSessionAfterError(err) {
	if (readErrorName(err) === "AbortError") return true;
	return err instanceof FailoverError && err.reason !== "session_expired";
}
function resolveClearedCliSessionReason(err) {
	if (err instanceof FailoverError) return err.reason;
	return readErrorName(err) || "error";
}
function normalizeTranscriptMirrorText(value) {
	return value.trim().replace(/\s+/gu, " ");
}
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
function resolveProfileAuthFromStore(params) {
	const profileId = params.profileId?.trim();
	if (!profileId) return {};
	const credential = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }).profiles[profileId];
	return {
		provider: credential?.provider,
		mode: credential?.type
	};
}
function resolveHarnessAuthProfileSelection(params) {
	const sessionAuthProfileId = params.sessionAuthProfileId?.trim();
	if (sessionAuthProfileId) {
		const profileAuth = resolveProfileAuthFromStore({
			agentDir: params.agentDir,
			profileId: sessionAuthProfileId
		});
		return {
			authProfileId: sessionAuthProfileId,
			authProfileIdSource: params.sessionAuthProfileSource,
			authProfileProvider: profileAuth.provider ?? params.authProfileProvider,
			authProfileMode: profileAuth.mode
		};
	}
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
		...resolveSessionWriteLockOptions(params.config),
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
		if (replyText) {
			let appendAssistant = true;
			if (params.embeddedAssistantGapFill) {
				const latest = await readTailAssistantTextFromSessionTranscript(sessionFile);
				const normalizedReply = normalizeTranscriptMirrorText(replyText);
				const normalizedLatest = latest?.text ? normalizeTranscriptMirrorText(latest.text) : "";
				if (normalizedLatest && normalizedLatest === normalizedReply) appendAssistant = false;
			}
			if (appendAssistant) await appendSessionTranscriptMessage({
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
		}
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
	const gapFill = params.embeddedAssistantGapFill ?? false;
	return await persistTextTurnTranscript({
		body: gapFill ? "" : params.body,
		transcriptBody: gapFill ? void 0 : params.transcriptBody,
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
		embeddedAssistantGapFill: gapFill,
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
	const requestedAgentHarnessId = isRawModelRun ? "pi" : void 0;
	const cliExecutionProvider = isRawModelRun ? params.providerOverride : resolveCliRuntimeExecutionProvider({
		provider: params.providerOverride,
		cfg: params.cfg,
		agentId: params.sessionAgentId,
		modelId: params.modelOverride,
		authProfileId: params.sessionEntry?.authProfileOverride
	}) ?? params.providerOverride;
	const agentHarnessPolicy = isRawModelRun ? { runtime: "pi" } : resolveAvailableAgentHarnessPolicy({
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
		harnessId: requestedAgentHarnessId,
		harnessRuntime: agentHarnessPolicy.runtime,
		allowHarnessAuthProfileForwarding: !isCliProvider(cliExecutionProvider, params.cfg)
	});
	const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
		provider: params.providerOverride,
		authProfileProvider: harnessAuthSelection.authProfileProvider,
		authProfileMode: harnessAuthSelection.authProfileMode,
		sessionAuthProfileId: harnessAuthSelection.authProfileId,
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		harnessId: requestedAgentHarnessId,
		harnessRuntime: agentHarnessPolicy.runtime,
		allowHarnessAuthProfileForwarding: !isCliProvider(cliExecutionProvider, params.cfg)
	});
	const authProfileId = runtimeAuthPlan.forwardedAuthProfileId;
	const embeddedPiProvider = resolveOpenAIRuntimeProviderForPi({
		provider: params.providerOverride,
		harnessRuntime: agentHarnessPolicy.runtime,
		agentHarnessId: requestedAgentHarnessId,
		authProfileProvider: runtimeAuthPlan.authProfileProviderForAuth,
		authProfileId,
		config: params.cfg,
		workspaceDir: params.workspaceDir
	});
	const embeddedPiHarnessOverride = requestedAgentHarnessId ?? (agentHarnessPolicy.runtime === "pi" && embeddedPiProvider !== params.providerOverride ? "pi" : void 0);
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
			toolsAllow: params.opts.toolsAllow,
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
				if (isClaudeCliProvider(cliExecutionProvider) && shouldClearReusedCliSessionAfterError(err) && activeCliSessionBinding?.sessionId && params.sessionKey && params.sessionStore && params.storePath) {
					log.warn(`CLI session cleared after failed reused turn: provider=${sanitizeForLog(cliExecutionProvider)} sessionKey=${params.sessionKey} reason=${sanitizeForLog(resolveClearedCliSessionReason(err))}`);
					params.sessionEntry = await clearCliSessionInStore({
						provider: cliExecutionProvider,
						sessionKey: params.sessionKey,
						sessionStore: params.sessionStore,
						storePath: params.storePath
					}) ?? params.sessionEntry;
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
		agentHarnessId: embeddedPiHarnessOverride,
		agentHarnessRuntimeOverride: embeddedPiHarnessOverride,
		skillsSnapshot: params.skillsSnapshot,
		prompt: effectivePrompt,
		images: params.isFallbackRetry ? void 0 : params.opts.images,
		imageOrder: params.isFallbackRetry ? void 0 : params.opts.imageOrder,
		clientTools: params.opts.clientTools,
		provider: embeddedPiProvider,
		model: params.modelOverride,
		modelFallbacksOverride: params.modelFallbacksOverride,
		authProfileId,
		authProfileIdSource: authProfileId ? harnessAuthSelection.authProfileIdSource : void 0,
		thinkLevel: params.resolvedThinkLevel,
		fastMode: params.fastMode,
		verboseLevel: params.resolvedVerboseLevel,
		bashElevated: params.opts.bashElevated,
		timeoutMs: params.timeoutMs,
		runId: params.runId,
		lane: params.opts.lane,
		abortSignal: params.opts.abortSignal,
		extraSystemPrompt: params.opts.extraSystemPrompt,
		bootstrapContextMode: params.opts.bootstrapContextMode,
		bootstrapContextRunKind: params.opts.bootstrapContextRunKind,
		toolsAllow: params.opts.toolsAllow,
		internalEvents: params.opts.internalEvents,
		inputProvenance: params.opts.inputProvenance,
		sourceReplyDeliveryMode: params.opts.sourceReplyDeliveryMode,
		streamParams: params.opts.streamParams,
		agentDir: params.agentDir,
		allowTransientCooldownProbe: params.allowTransientCooldownProbe,
		cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
		modelRun: params.opts.modelRun,
		promptMode: params.opts.promptMode,
		disableTools: params.opts.modelRun === true,
		onAgentEvent: params.onAgentEvent,
		deferTerminalLifecycleEnd: params.deferTerminalLifecycleEnd,
		suppressNextUserMessagePersistence: params.suppressPromptPersistenceOnRetry === true,
		onUserMessagePersisted: params.onUserMessagePersisted,
		bootstrapPromptWarningSignaturesSeen,
		bootstrapPromptWarningSignature
	});
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
const ACP_PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy"
];
function resolvePresentProxyEnvKeys(env = process.env) {
	return ACP_PROXY_ENV_KEYS.filter((key) => {
		const value = env[key];
		return typeof value === "string" && value.trim().length > 0;
	});
}
function sanitizeAcpDiagnosticText(value) {
	return redactSensitiveText(value).replace(/\s+/g, " ").trim().slice(0, 240);
}
function acpRuntimeEventDiagnostics(event) {
	if (event.type === "status") return {
		eventType: event.type,
		text: sanitizeAcpDiagnosticText(event.text),
		...event.tag ? { tag: event.tag } : {}
	};
	if (event.type === "tool_call") return {
		eventType: event.type,
		text: sanitizeAcpDiagnosticText(event.text),
		...event.tag ? { tag: event.tag } : {},
		...event.status ? { status: sanitizeAcpDiagnosticText(event.status) } : {},
		...event.title ? { title: sanitizeAcpDiagnosticText(event.title) } : {},
		...event.toolCallId ? { toolCallId: sanitizeAcpDiagnosticText(event.toolCallId) } : {}
	};
	if (event.type === "error") return {
		eventType: event.type,
		message: sanitizeAcpDiagnosticText(event.message),
		...event.code ? { code: sanitizeAcpDiagnosticText(event.code) } : {},
		...typeof event.retryable === "boolean" ? { retryable: event.retryable } : {}
	};
	if (event.type === "done") return {
		eventType: event.type,
		...event.stopReason ? { stopReason: sanitizeAcpDiagnosticText(event.stopReason) } : {}
	};
	return {
		eventType: event.type,
		stream: event.stream ?? "output"
	};
}
function emitAcpPromptSubmitted(params) {
	emitAgentEvent({
		runId: params.runId,
		stream: "acp",
		...params.sessionKey ? { sessionKey: params.sessionKey } : {},
		data: {
			phase: "prompt_submitted",
			at: params.at,
			proxyEnvKeys: resolvePresentProxyEnvKeys()
		}
	});
}
function emitAcpRuntimeEvent(params) {
	emitAgentEvent({
		runId: params.runId,
		stream: "acp",
		...params.sessionKey ? { sessionKey: params.sessionKey } : {},
		data: {
			phase: "runtime_event",
			...acpRuntimeEventDiagnostics(params.event)
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
		...params.sessionKey ? { sessionKey: params.sessionKey } : {},
		data: {
			phase: "error",
			error: formatAcpErrorChain(params.error),
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
export { emitAcpLifecycleStart as a, persistAcpTurnTranscript as c, emitAcpLifecycleError as i, persistCliTurnTranscript as l, emitAcpAssistantDelta as n, emitAcpPromptSubmitted as o, emitAcpLifecycleEnd as r, emitAcpRuntimeEvent as s, buildAcpResult as t, runAgentAttempt as u };
