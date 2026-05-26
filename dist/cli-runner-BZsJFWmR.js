import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { s as resolveBlockMessage, t as getGlobalHookRunner } from "./hook-runner-global-BkXXy1ub.js";
import "./tokens-CFv3Qu_v.js";
import { _ as buildAgentHookContextChannelFields } from "./attempt.prompt-helpers-2z-P6Pk8.js";
import "./pi-embedded-helpers-bmljPI1n.js";
import { p as isFailoverErrorMessage, t as classifyFailoverReason } from "./errors-DYND-qcd.js";
import { c as resolveFailoverStatus, i as isFailoverError, t as FailoverError } from "./failover-error-CZCIurQK.js";
import { a as finalizeHarnessContextEngineTurn, n as bootstrapHarnessContextEngine, s as runHarnessContextEngineMaintenance } from "./context-engine-lifecycle-BMb8IJAk.js";
import { i as loadCliSessionHistoryMessages, o as buildAgentHookConversationMessages, r as loadCliSessionContextEngineMessages } from "./session-history-DvfnG51B.js";
import { a as runAgentHarnessLlmOutputHook, i as runAgentHarnessLlmInputHook, n as runAgentHarnessAgentEndHook, o as buildAgentHookContext, t as awaitAgentHarnessAgentEndHook } from "./lifecycle-hook-helpers-DfkD7GEX.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
//#region src/agents/cli-runner.ts
const log = createSubsystemLogger("agents/cli-runner");
function flushSessionManagerFile(sessionManager) {
	sessionManager["_rewriteFile"]?.();
}
function buildHandledReplyPayloads(reply) {
	const normalized = reply ?? { text: "NO_REPLY" };
	return [{
		text: normalized.text,
		mediaUrl: normalized.mediaUrl,
		mediaUrls: normalized.mediaUrls,
		replyToId: normalized.replyToId,
		audioAsVoice: normalized.audioAsVoice,
		isError: normalized.isError,
		isReasoning: normalized.isReasoning
	}];
}
function buildCliHookUserMessage(prompt) {
	return {
		role: "user",
		content: prompt,
		timestamp: Date.now()
	};
}
function buildCliHookAssistantMessage(params) {
	return {
		role: "assistant",
		content: [{
			type: "text",
			text: params.text
		}],
		api: "responses",
		provider: params.provider,
		model: params.model,
		...params.usage ? { usage: params.usage } : {},
		stopReason: "stop",
		timestamp: Date.now()
	};
}
function isAgentMessage(value) {
	return Boolean(value && typeof value === "object" && "role" in value);
}
function buildCliContextEngineUserMessage(prompt) {
	return {
		role: "user",
		content: prompt,
		timestamp: Date.now()
	};
}
function buildCliContextEngineAssistantMessage(params) {
	return buildCliHookAssistantMessage(params);
}
function shouldAwaitCliAgentEndHook(params) {
	return !params.messageChannel && !params.messageProvider;
}
async function runCliAgentEndHook(params, hookParams) {
	if (shouldAwaitCliAgentEndHook(params)) {
		await awaitAgentHarnessAgentEndHook(hookParams);
		return;
	}
	runAgentHarnessAgentEndHook(hookParams);
}
async function finalizeCliContextEngineTurn(params) {
	const { context } = params;
	if (!context.contextEngine) return;
	const { params: runParams } = context;
	const prePromptMessages = params.historyMessages.filter(isAgentMessage);
	const turnMessages = [];
	if (context.contextEngineTurnPrompt) turnMessages.push(buildCliContextEngineUserMessage(context.contextEngineTurnPrompt));
	if (params.assistantText) turnMessages.push(buildCliContextEngineAssistantMessage({
		text: params.assistantText,
		provider: runParams.provider,
		model: context.modelId,
		usage: params.output.usage
	}));
	let deferredTurnMaintenance;
	if ((await finalizeHarnessContextEngineTurn({
		contextEngine: context.contextEngine,
		promptError: false,
		aborted: runParams.abortSignal?.aborted === true,
		yieldAborted: false,
		sessionIdUsed: runParams.sessionId,
		sessionKey: runParams.sessionKey,
		sessionFile: runParams.sessionFile,
		messagesSnapshot: [...prePromptMessages, ...turnMessages],
		prePromptMessageCount: prePromptMessages.length,
		config: context.contextEngineConfig,
		runMaintenance: async (maintenanceParams) => await runHarnessContextEngineMaintenance({
			...maintenanceParams,
			onDeferredMaintenance: (promise) => {
				deferredTurnMaintenance = promise;
			}
		}),
		warn: (message) => log.warn(message)
	})).postTurnFinalizationSucceeded && deferredTurnMaintenance) context.contextEngineDeferredTurnMaintenance = deferredTurnMaintenance;
}
async function runCliAgent(params) {
	params.onExecutionStarted?.();
	if (params.trigger === "cron") {
		const startedAt = Date.now();
		const hookRunner = getGlobalHookRunner();
		if (hookRunner?.hasHooks("before_agent_reply")) {
			const hookContext = {
				runId: params.runId,
				jobId: params.jobId,
				agentId: params.agentId,
				sessionKey: params.sessionKey,
				sessionId: params.sessionId,
				workspaceDir: params.workspaceDir,
				trigger: params.trigger,
				...buildAgentHookContextChannelFields(params)
			};
			params.onExecutionPhase?.({
				phase: "before_agent_reply",
				provider: params.provider,
				model: params.model ?? ""
			});
			const hookResult = await hookRunner.runBeforeAgentReply({ cleanedBody: params.prompt }, hookContext);
			if (hookResult?.handled) return {
				payloads: buildHandledReplyPayloads(hookResult.reply),
				meta: {
					durationMs: Date.now() - startedAt,
					agentMeta: {
						sessionId: params.sessionId,
						provider: params.provider,
						model: params.model ?? ""
					},
					finalAssistantVisibleText: hookResult.reply?.text ?? "NO_REPLY",
					finalAssistantRawText: hookResult.reply?.text ?? "NO_REPLY"
				}
			};
			params.onExecutionPhase?.({
				phase: "runtime_plugins",
				provider: params.provider,
				model: params.model ?? ""
			});
		}
	}
	const { prepareCliRunContext } = await import("./prepare.runtime.js");
	const context = await prepareCliRunContext(params);
	try {
		return await runPreparedCliAgent(context);
	} finally {
		if (params.cleanupCliLiveSessionOnRunEnd === true) {
			const { closeClaudeLiveSessionForContext } = await import("./claude-live-session-DARBdiNA.js");
			await closeClaudeLiveSessionForContext(context);
		}
		if (params.cleanupBundleMcpOnRunEnd === true) {
			const { closeMcpLoopbackServer } = await import("./mcp-http-BO2CYtjK.js");
			await closeMcpLoopbackServer();
		}
	}
}
async function runPreparedCliAgent(context) {
	const { executePreparedCliRun } = await import("./execute.runtime.js");
	const { params } = context;
	const hookRunner = getGlobalHookRunner();
	const hasLlmInputHooks = hookRunner?.hasHooks("llm_input") === true;
	const hasLlmOutputHooks = hookRunner?.hasHooks("llm_output") === true;
	const hasAgentEndHooks = hookRunner?.hasHooks("agent_end") === true;
	const hasBeforeAgentRunHooks = hookRunner?.hasHooks("before_agent_run") === true;
	const historyMessages = hasLlmInputHooks || hasAgentEndHooks || hasBeforeAgentRunHooks ? await loadCliSessionHistoryMessages({
		sessionId: params.sessionId,
		sessionFile: params.sessionFile,
		sessionKey: params.sessionKey,
		agentId: params.agentId,
		config: params.config
	}) : [];
	const llmInputEvent = {
		runId: params.runId,
		sessionId: params.sessionId,
		provider: params.provider,
		model: context.modelId,
		systemPrompt: context.systemPrompt,
		prompt: params.prompt,
		historyMessages,
		imagesCount: params.images?.length ?? 0
	};
	const hookContext = {
		runId: params.runId,
		jobId: params.jobId,
		agentId: params.agentId,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		workspaceDir: params.workspaceDir,
		trigger: params.trigger,
		...context.contextWindowInfo?.tokens ? { contextTokenBudget: context.contextWindowInfo.tokens } : {},
		...context.contextWindowInfo?.source ? { contextWindowSource: context.contextWindowInfo.source } : {},
		...context.contextWindowInfo?.referenceTokens ? { contextWindowReferenceTokens: context.contextWindowInfo.referenceTokens } : {},
		...buildAgentHookContextChannelFields(params)
	};
	const buildAgentEndMessages = (lastAssistant) => [...buildAgentHookConversationMessages({
		historyMessages,
		currentTurnMessages: [buildCliHookUserMessage(params.prompt), ...lastAssistant ? [lastAssistant] : []]
	})];
	const buildFailedAgentEndEvent = (error) => ({
		messages: buildAgentEndMessages(),
		success: false,
		error,
		durationMs: Date.now() - context.started
	});
	const buildBlockedAgentEndEvent = (message) => ({
		messages: buildAgentHookConversationMessages({
			historyMessages,
			currentTurnMessages: [buildCliHookUserMessage(message)]
		}),
		success: false,
		error: message,
		durationMs: Date.now() - context.started
	});
	const buildBlockedBeforeAgentRunResult = (message) => ({
		payloads: [{
			text: message,
			isError: true
		}],
		meta: {
			durationMs: Date.now() - context.started,
			finalAssistantVisibleText: message,
			finalAssistantRawText: message,
			livenessState: "blocked",
			error: {
				kind: "hook_block",
				message
			},
			systemPromptReport: context.systemPromptReport,
			executionTrace: {
				winnerProvider: params.provider,
				winnerModel: context.modelId,
				attempts: [{
					provider: params.provider,
					model: context.modelId,
					result: "error",
					reason: "before_agent_run blocked the run"
				}],
				fallbackUsed: false,
				runner: "cli"
			},
			requestShaping: {
				...params.thinkLevel ? { thinking: params.thinkLevel } : {},
				...context.effectiveAuthProfileId ? { authMode: "auth-profile" } : {}
			},
			completion: {
				finishReason: "blocked",
				stopReason: "blocked",
				refusal: true
			},
			agentMeta: {
				sessionId: params.sessionId ?? "",
				provider: params.provider,
				model: context.modelId
			}
		}
	});
	const persistBlockedBeforeAgentRun = async (block) => {
		try {
			const nowMs = Date.now();
			const sessionManager = SessionManager.open(params.sessionFile);
			sessionManager.appendMessage({
				role: "user",
				content: [{
					type: "text",
					text: block.message
				}],
				timestamp: nowMs,
				idempotencyKey: `hook-block:before_agent_run:user:${params.runId}`,
				__openclaw: { beforeAgentRunBlocked: {
					blockedBy: block.pluginId,
					blockedAt: nowMs
				} }
			});
			flushSessionManagerFile(sessionManager);
		} catch (err) {
			log.warn(`before_agent_run block: failed to persist redacted CLI user message: ${formatErrorMessage(err)}`);
		}
	};
	const toCliRunFailure = (error) => {
		if (isFailoverError(error)) throw error;
		const message = formatErrorMessage(error);
		if (isFailoverErrorMessage(message, { provider: params.provider })) {
			const reason = classifyFailoverReason(message, { provider: params.provider }) ?? "unknown";
			const status = resolveFailoverStatus(reason);
			throw new FailoverError(message, {
				reason,
				provider: params.provider,
				model: context.modelId,
				sessionId: params.sessionId,
				lane: params.lane,
				status
			});
		}
		throw error;
	};
	const executeCliAttempt = async (cliSessionIdToUse) => {
		const output = await executePreparedCliRun(context, cliSessionIdToUse);
		const assistantText = output.text.trim();
		if (!assistantText) throw new FailoverError("CLI backend returned an empty response.", {
			reason: "empty_response",
			provider: params.provider,
			model: context.modelId,
			sessionId: params.sessionId,
			lane: params.lane
		});
		const assistantTexts = assistantText ? [assistantText] : [];
		const lastAssistant = assistantText.length > 0 ? buildCliHookAssistantMessage({
			text: assistantText,
			provider: params.provider,
			model: context.modelId,
			usage: output.usage
		}) : void 0;
		if (assistantText.length > 0 && hasLlmOutputHooks) runAgentHarnessLlmOutputHook({
			event: {
				runId: params.runId,
				sessionId: params.sessionId,
				provider: params.provider,
				model: context.modelId,
				...context.contextWindowInfo?.tokens ? { contextTokenBudget: context.contextWindowInfo.tokens } : {},
				...context.contextWindowInfo?.source ? { contextWindowSource: context.contextWindowInfo.source } : {},
				...context.contextWindowInfo?.referenceTokens ? { contextWindowReferenceTokens: context.contextWindowInfo.referenceTokens } : {},
				resolvedRef: `${params.provider}/${context.modelId}`,
				assistantTexts,
				...lastAssistant ? { lastAssistant } : {},
				...output.usage ? { usage: output.usage } : {}
			},
			ctx: hookContext,
			hookRunner
		});
		return {
			output,
			assistantText,
			lastAssistant
		};
	};
	const buildCliRunResult = (resultParams) => {
		const text = resultParams.output.text?.trim();
		const rawText = resultParams.output.rawText?.trim();
		return {
			payloads: text ? [{ text }] : void 0,
			meta: {
				durationMs: Date.now() - context.started,
				...resultParams.output.finalPromptText ? { finalPromptText: resultParams.output.finalPromptText } : {},
				...text || rawText ? {
					...text ? { finalAssistantVisibleText: text } : {},
					...rawText ? { finalAssistantRawText: rawText } : {}
				} : {},
				systemPromptReport: context.systemPromptReport,
				executionTrace: {
					winnerProvider: params.provider,
					winnerModel: context.modelId,
					attempts: [{
						provider: params.provider,
						model: context.modelId,
						result: "success"
					}],
					fallbackUsed: false,
					runner: "cli"
				},
				requestShaping: {
					...params.thinkLevel ? { thinking: params.thinkLevel } : {},
					...context.effectiveAuthProfileId ? { authMode: "auth-profile" } : {}
				},
				completion: {
					finishReason: "stop",
					stopReason: "completed",
					refusal: false
				},
				agentMeta: {
					sessionId: resultParams.effectiveCliSessionId ?? params.sessionId ?? "",
					provider: params.provider,
					model: context.modelId,
					usage: resultParams.output.usage,
					...resultParams.output.usage ? { lastCallUsage: resultParams.output.usage } : {},
					...resultParams.effectiveCliSessionId ? { cliSessionBinding: {
						sessionId: resultParams.effectiveCliSessionId,
						...context.effectiveAuthProfileId ? { authProfileId: context.effectiveAuthProfileId } : {},
						...context.authEpoch ? { authEpoch: context.authEpoch } : {},
						authEpochVersion: context.authEpochVersion,
						...context.extraSystemPromptHash ? { extraSystemPromptHash: context.extraSystemPromptHash } : {},
						...context.promptToolNamesHash ? { promptToolNamesHash: context.promptToolNamesHash } : {},
						...context.preparedBackend.mcpConfigHash ? { mcpConfigHash: context.preparedBackend.mcpConfigHash } : {},
						...context.preparedBackend.mcpResumeHash ? { mcpResumeHash: context.preparedBackend.mcpResumeHash } : {}
					} } : {}
				}
			}
		};
	};
	try {
		await bootstrapHarnessContextEngine({
			hadSessionFile: context.hadSessionFile,
			contextEngine: context.contextEngine,
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			sessionFile: params.sessionFile,
			config: context.contextEngineConfig,
			warn: (message) => log.warn(message)
		});
		const contextEngineHistoryMessages = context.contextEngine ? await loadCliSessionContextEngineMessages({
			sessionId: params.sessionId,
			sessionFile: params.sessionFile,
			sessionKey: params.sessionKey,
			agentId: params.agentId,
			config: params.config
		}) : [];
		if (hasBeforeAgentRunHooks && hookRunner) {
			let beforeRunResult;
			try {
				beforeRunResult = await hookRunner.runBeforeAgentRun({
					prompt: params.prompt,
					systemPrompt: context.systemPrompt,
					messages: buildAgentHookConversationMessages({
						historyMessages,
						currentTurnMessages: []
					}),
					channelId: hookContext.channelId,
					accountId: params.agentAccountId
				}, buildAgentHookContext(hookContext));
			} catch {
				const blockMessage = resolveBlockMessage({
					outcome: "block",
					reason: "before_agent_run hook failed"
				}, { blockedBy: "before_agent_run" });
				await persistBlockedBeforeAgentRun({
					message: blockMessage,
					pluginId: "before_agent_run"
				});
				await runCliAgentEndHook(params, {
					event: buildBlockedAgentEndEvent(blockMessage),
					ctx: hookContext,
					hookRunner
				});
				return buildBlockedBeforeAgentRunResult(blockMessage);
			}
			const beforeRunDecision = beforeRunResult?.decision;
			if (beforeRunDecision?.outcome === "block") {
				const blockMessage = resolveBlockMessage(beforeRunDecision, { blockedBy: beforeRunResult?.pluginId ?? "unknown" });
				await persistBlockedBeforeAgentRun({
					message: blockMessage,
					pluginId: beforeRunResult?.pluginId ?? "unknown"
				});
				await runCliAgentEndHook(params, {
					event: buildBlockedAgentEndEvent(blockMessage),
					ctx: hookContext,
					hookRunner
				});
				return buildBlockedBeforeAgentRunResult(blockMessage);
			}
		}
		runAgentHarnessLlmInputHook({
			event: llmInputEvent,
			ctx: hookContext,
			hookRunner
		});
		try {
			const { output, lastAssistant } = await executeCliAttempt(context.reusableCliSession.sessionId);
			const assistantText = output.text.trim();
			const effectiveCliSessionId = output.sessionId ?? context.reusableCliSession.sessionId;
			await finalizeCliContextEngineTurn({
				context,
				historyMessages: context.contextEngine ? contextEngineHistoryMessages : historyMessages,
				assistantText,
				output
			});
			await runCliAgentEndHook(params, {
				event: {
					messages: buildAgentEndMessages(lastAssistant),
					success: true,
					durationMs: Date.now() - context.started
				},
				ctx: hookContext,
				hookRunner
			});
			return buildCliRunResult({
				output,
				effectiveCliSessionId
			});
		} catch (err) {
			if (isFailoverError(err)) {
				const retryableSessionId = context.reusableCliSession.sessionId ?? params.cliSessionId;
				if (err.reason === "session_expired" && retryableSessionId && params.sessionKey) try {
					const { output, lastAssistant } = await executeCliAttempt(void 0);
					const assistantText = output.text.trim();
					const effectiveCliSessionId = output.sessionId;
					await finalizeCliContextEngineTurn({
						context,
						historyMessages: context.contextEngine ? contextEngineHistoryMessages : historyMessages,
						assistantText,
						output
					});
					await runCliAgentEndHook(params, {
						event: {
							messages: buildAgentEndMessages(lastAssistant),
							success: true,
							durationMs: Date.now() - context.started
						},
						ctx: hookContext,
						hookRunner
					});
					return buildCliRunResult({
						output,
						effectiveCliSessionId
					});
				} catch (retryErr) {
					await runCliAgentEndHook(params, {
						event: buildFailedAgentEndEvent(formatErrorMessage(retryErr)),
						ctx: hookContext,
						hookRunner
					});
					return toCliRunFailure(retryErr);
				}
				await runCliAgentEndHook(params, {
					event: buildFailedAgentEndEvent(formatErrorMessage(err)),
					ctx: hookContext,
					hookRunner
				});
				throw err;
			}
			await runCliAgentEndHook(params, {
				event: buildFailedAgentEndEvent(formatErrorMessage(err)),
				ctx: hookContext,
				hookRunner
			});
			return toCliRunFailure(err);
		}
	} finally {
		await context.preparedBackend.cleanup?.();
	}
}
//#endregion
export { runPreparedCliAgent as n, runCliAgent as t };
