import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { s as resolveBlockMessage, t as getGlobalHookRunner } from "./hook-runner-global-aUo3QVZe.js";
import "./tokens-CUA96vf1.js";
import { t as buildAgentHookContextChannelFields } from "./hook-agent-context-DJQE24WK.js";
import "./pi-embedded-helpers-CVGWGeIq.js";
import { p as isFailoverErrorMessage, t as classifyFailoverReason } from "./errors-DbMhA8M9.js";
import { i as isFailoverError, s as resolveFailoverStatus, t as FailoverError } from "./failover-error-B3fMvjfZ.js";
import { a as buildAgentHookContext, i as runAgentHarnessLlmOutputHook, r as runAgentHarnessLlmInputHook, t as runAgentHarnessAgentEndHook } from "./lifecycle-hook-helpers-CmTFojZU.js";
import { i as buildAgentHookConversationMessages, n as loadCliSessionHistoryMessages } from "./session-history-BqIMsxsA.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
//#region src/agents/cli-runner.ts
const log = createSubsystemLogger("agents/cli-runner");
function flushSessionManagerFile(sessionManager) {
	sessionManager._rewriteFile?.();
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
		}
	}
	const { prepareCliRunContext } = await import("./prepare.runtime.js");
	const context = await prepareCliRunContext(params);
	try {
		return await runPreparedCliAgent(context);
	} finally {
		if (params.cleanupCliLiveSessionOnRunEnd === true) {
			const { closeClaudeLiveSessionForContext } = await import("./claude-live-session-CSY7h1sv.js");
			await closeClaudeLiveSessionForContext(context);
		}
		if (params.cleanupBundleMcpOnRunEnd === true) {
			const { closeMcpLoopbackServer } = await import("./mcp-http-CL7Kpp6I.js");
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
						...context.preparedBackend.mcpConfigHash ? { mcpConfigHash: context.preparedBackend.mcpConfigHash } : {},
						...context.preparedBackend.mcpResumeHash ? { mcpResumeHash: context.preparedBackend.mcpResumeHash } : {}
					} } : {}
				}
			}
		};
	};
	try {
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
					accountId: params.agentAccountId,
					senderIsOwner: params.senderIsOwner
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
				runAgentHarnessAgentEndHook({
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
				runAgentHarnessAgentEndHook({
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
			const effectiveCliSessionId = output.sessionId ?? context.reusableCliSession.sessionId;
			runAgentHarnessAgentEndHook({
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
					const effectiveCliSessionId = output.sessionId;
					runAgentHarnessAgentEndHook({
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
					runAgentHarnessAgentEndHook({
						event: buildFailedAgentEndEvent(formatErrorMessage(retryErr)),
						ctx: hookContext,
						hookRunner
					});
					return toCliRunFailure(retryErr);
				}
				runAgentHarnessAgentEndHook({
					event: buildFailedAgentEndEvent(formatErrorMessage(err)),
					ctx: hookContext,
					hookRunner
				});
				throw err;
			}
			runAgentHarnessAgentEndHook({
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
