import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as resolveGlobalSingleton } from "./global-singleton-DE6St75u.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
//#region src/hooks/fire-and-forget.ts
const DEFAULT_MAX_CONCURRENT_FIRE_AND_FORGET_HOOKS = 16;
const DEFAULT_MAX_QUEUED_FIRE_AND_FORGET_HOOKS = 256;
const DEFAULT_FIRE_AND_FORGET_HOOK_TIMEOUT_MS = 2e3;
const MAX_HOOK_LOG_MESSAGE_LENGTH = 500;
const getFireAndForgetHookState = () => resolveGlobalSingleton(Symbol.for("openclaw.fireAndForgetHookState"), () => ({
	active: 0,
	queue: []
}));
function positiveIntegerOrDefault(value, fallback) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
function replaceLogControlCharacters(value) {
	let result = "";
	for (const char of value) {
		const codePoint = char.codePointAt(0);
		if (codePoint === void 0 || codePoint <= 31 || codePoint === 127 || codePoint === 8232 || codePoint === 8233) {
			result += " ";
			continue;
		}
		result += char;
	}
	return result;
}
function formatHookErrorForLog(err) {
	return (replaceLogControlCharacters(formatErrorMessage(err)).replace(/\s+/g, " ").trim() || "unknown error").slice(0, MAX_HOOK_LOG_MESSAGE_LENGTH);
}
function fireAndForgetHook(task, label, logger = logVerbose) {
	task.catch((err) => {
		logger(`${label}: ${formatHookErrorForLog(err)}`);
	});
}
function runFireAndForgetHookJob(state, job, limits) {
	state.active += 1;
	let didLogTimeout = false;
	const timeout = job.timeoutMs > 0 ? setTimeout(() => {
		didLogTimeout = true;
		job.logger(`${job.label}: timed out after ${job.timeoutMs}ms`);
	}, job.timeoutMs) : void 0;
	Promise.resolve().then(job.task).catch((err) => {
		if (!didLogTimeout) job.logger(`${job.label}: ${formatHookErrorForLog(err)}`);
	}).finally(() => {
		if (timeout) clearTimeout(timeout);
		state.active -= 1;
		drainFireAndForgetHookQueue(state, limits);
	});
}
function drainFireAndForgetHookQueue(state, limits) {
	while (state.active < limits.maxConcurrency) {
		const next = state.queue.shift();
		if (!next) return;
		runFireAndForgetHookJob(state, next, limits);
	}
}
function fireAndForgetBoundedHook(task, label, logger = logVerbose, options = {}) {
	const state = getFireAndForgetHookState();
	const maxConcurrency = positiveIntegerOrDefault(options.maxConcurrency, DEFAULT_MAX_CONCURRENT_FIRE_AND_FORGET_HOOKS);
	const maxQueue = positiveIntegerOrDefault(options.maxQueue, DEFAULT_MAX_QUEUED_FIRE_AND_FORGET_HOOKS);
	const timeoutMs = positiveIntegerOrDefault(options.timeoutMs, DEFAULT_FIRE_AND_FORGET_HOOK_TIMEOUT_MS);
	if (state.active >= maxConcurrency && state.queue.length >= maxQueue) {
		logger(`${label}: queue full; dropping hook`);
		return;
	}
	state.queue.push({
		task,
		label,
		logger,
		timeoutMs
	});
	drainFireAndForgetHookQueue(state, { maxConcurrency });
}
//#endregion
//#region src/shared/text/join-segments.ts
function concatOptionalTextSegments(params) {
	const separator = params.separator ?? "\n\n";
	if (params.left && params.right) return `${params.left}${separator}${params.right}`;
	return params.right ?? params.left;
}
function joinPresentTextSegments(segments, options) {
	const separator = options?.separator ?? "\n\n";
	const trim = options?.trim ?? false;
	const values = [];
	for (const segment of segments) {
		if (typeof segment !== "string") continue;
		const normalized = trim ? segment.trim() : segment;
		if (!normalized) continue;
		values.push(normalized);
	}
	return values.length > 0 ? values.join(separator) : void 0;
}
//#endregion
//#region src/plugins/hook-decision-types.ts
/** Prefix for user-facing replacement messages when a `block` decision stops a request. */
const BLOCK_MESSAGE_PREFIX = "Your message could not be sent";
function resolveBlockMessage(decision, params = {}) {
	const message = typeof decision.message === "string" ? decision.message.trim() : "";
	const blockedBy = params.blockedBy?.trim();
	if (message) return blockedBy ? `${BLOCK_MESSAGE_PREFIX}: ${message} (blocked by ${blockedBy})` : `${BLOCK_MESSAGE_PREFIX}: ${message}`;
	return blockedBy ? `${BLOCK_MESSAGE_PREFIX}: blocked by ${blockedBy}` : `${BLOCK_MESSAGE_PREFIX}: blocked`;
}
/**
* Type guard: does this object look like a HookDecision (has `outcome` field)?
*/
function isHookDecision(value) {
	if (typeof value !== "object" || value === null) return false;
	const v = value;
	const keys = Object.keys(v);
	if (v.outcome === "pass") return keys.length === 1;
	if (v.outcome !== "block") return false;
	const allowedBlockKeys = new Set([
		"outcome",
		"reason",
		"message",
		"category",
		"metadata"
	]);
	if (keys.some((key) => !allowedBlockKeys.has(key))) return false;
	if (typeof v.reason !== "string" || !v.reason.trim()) return false;
	if ("message" in v && (typeof v.message !== "string" || !v.message.trim())) return false;
	if ("category" in v && (typeof v.category !== "string" || !v.category.trim())) return false;
	if ("metadata" in v && (typeof v.metadata !== "object" || v.metadata === null || Array.isArray(v.metadata))) return false;
	return true;
}
//#endregion
//#region src/plugins/hooks.ts
/**
* Plugin Hook Runner
*
* Provides utilities for executing plugin lifecycle hooks with proper
* error handling and priority ordering.
*/
const DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK = {
	agent_end: 3e4,
	before_compaction: 3e4,
	after_compaction: 3e4
};
const DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK = {
	before_agent_run: 15e3,
	before_agent_start: 15e3,
	before_prompt_build: 15e3
};
/**
* Get hooks for a specific hook name, sorted by priority (higher first).
*/
function getHooksForName(registry, hookName) {
	return registry.typedHooks.filter((h) => h.hookName === hookName).toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
function getHooksForNameAndPlugin(registry, hookName, pluginId) {
	return getHooksForName(registry, hookName).filter((hook) => hook.pluginId === pluginId);
}
/**
* Create a hook runner for a specific registry.
*/
function createHookRunner(registry, options = {}) {
	const logger = options.logger;
	const catchErrors = options.catchErrors ?? true;
	const failurePolicyByHook = {
		before_agent_run: "fail-closed",
		...options.failurePolicyByHook
	};
	const voidHookTimeoutMsByHook = {
		...DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK,
		...options.voidHookTimeoutMsByHook
	};
	const modifyingHookTimeoutMsByHook = {
		...DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK,
		...options.modifyingHookTimeoutMsByHook
	};
	const shouldCatchHookErrors = (hookName) => catchErrors && (failurePolicyByHook[hookName] ?? "fail-open") === "fail-open";
	const firstDefined = (prev, next) => prev ?? next;
	const lastDefined = (prev, next) => next ?? prev;
	const stickyTrue = (prev, next) => prev === true || next === true ? true : void 0;
	const mergeBeforeModelResolve = (acc, next) => ({
		modelOverride: firstDefined(acc?.modelOverride, next.modelOverride),
		providerOverride: firstDefined(acc?.providerOverride, next.providerOverride)
	});
	const mergeBeforePromptBuild = (acc, next) => ({
		systemPrompt: firstDefined(acc?.systemPrompt, next.systemPrompt),
		prependContext: concatOptionalTextSegments({
			left: acc?.prependContext,
			right: next.prependContext
		}),
		appendContext: concatOptionalTextSegments({
			left: acc?.appendContext,
			right: next.appendContext
		}),
		prependSystemContext: concatOptionalTextSegments({
			left: acc?.prependSystemContext,
			right: next.prependSystemContext
		}),
		appendSystemContext: concatOptionalTextSegments({
			left: acc?.appendSystemContext,
			right: next.appendSystemContext
		})
	});
	const mergeAgentTurnPrepare = (acc, next) => ({
		prependContext: concatOptionalTextSegments({
			left: acc?.prependContext,
			right: next.prependContext
		}),
		appendContext: concatOptionalTextSegments({
			left: acc?.appendContext,
			right: next.appendContext
		})
	});
	const mergeBeforeAgentFinalize = (acc, next) => {
		const normalizeRetry = (retry) => {
			const instruction = typeof retry?.instruction === "string" ? retry.instruction.trim() : "";
			if (!instruction) return;
			return {
				...retry,
				instruction
			};
		};
		const readRetryCandidates = (result) => {
			if (!result || result.action !== "revise") return [];
			const candidateList = result.retryCandidates;
			if (Array.isArray(candidateList) && candidateList.length > 0) return candidateList.map((retry) => normalizeRetry(retry)).filter((retry) => retry !== void 0);
			const retry = normalizeRetry(result.retry);
			return retry ? [retry] : [];
		};
		const attachRetryCandidates = (result, candidates) => {
			if (result.action !== "revise" || candidates.length <= 1) return result;
			Object.defineProperty(result, "retryCandidates", {
				configurable: true,
				enumerable: false,
				value: candidates
			});
			return result;
		};
		if (acc?.action === "finalize") return acc;
		if (next.action === "finalize") return {
			action: "finalize",
			reason: next.reason
		};
		if (acc?.action === "revise" && next.action === "revise") {
			const retryCandidates = [...readRetryCandidates(acc), ...readRetryCandidates(next)];
			const retry = retryCandidates[0];
			return attachRetryCandidates({
				action: "revise",
				reason: concatOptionalTextSegments({
					left: acc.reason,
					right: next.reason
				}),
				...retry ? { retry } : {}
			}, retryCandidates);
		}
		if (acc?.action === "revise") return acc;
		if (next.action === "revise") {
			const retry = normalizeRetry(next.retry);
			return {
				action: "revise",
				reason: next.reason,
				...retry ? { retry } : {}
			};
		}
		return next.action === "continue" ? {
			action: "continue",
			reason: next.reason
		} : acc ?? next;
	};
	const mergeSubagentSpawningResult = (acc, next) => {
		if (acc?.status === "error") return acc;
		if (next.status === "error") return next;
		const deliveryOrigin = acc?.deliveryOrigin ?? next.deliveryOrigin;
		return {
			status: "ok",
			threadBindingReady: Boolean(acc?.threadBindingReady || next.threadBindingReady),
			...deliveryOrigin ? { deliveryOrigin } : {}
		};
	};
	const mergeSubagentDeliveryTargetResult = (acc, next) => {
		if (acc?.origin) return acc;
		return next;
	};
	const handleHookError = (params) => {
		const msg = `[hooks] ${params.hookName} handler from ${params.pluginId} failed: ${formatHookErrorForLog(params.error)}`;
		if (shouldCatchHookErrors(params.hookName)) {
			logger?.error(msg);
			return;
		}
		throw new Error(msg, { cause: params.error });
	};
	const sanitizeHookError = (error) => {
		return formatErrorMessage(error).split("\n")[0]?.trim() || "unknown error";
	};
	const isPromiseLike = (value) => {
		if (typeof value !== "object" && typeof value !== "function" || value === null) return false;
		return typeof value.then === "function";
	};
	const normalizePositiveTimeoutMs = (timeoutMs) => {
		if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
		return Math.floor(timeoutMs);
	};
	const getVoidHookTimeoutMs = (hookName, hook) => normalizePositiveTimeoutMs(hook.timeoutMs) ?? normalizePositiveTimeoutMs(voidHookTimeoutMsByHook[hookName]);
	const getModifyingHookTimeoutMs = (hookName, hook) => normalizePositiveTimeoutMs(hook.timeoutMs) ?? normalizePositiveTimeoutMs(modifyingHookTimeoutMsByHook[hookName]);
	const getClaimingHookTimeoutMs = (hookName, hook) => normalizePositiveTimeoutMs(hook.timeoutMs) ?? normalizePositiveTimeoutMs(modifyingHookTimeoutMsByHook[hookName]);
	const withHookTimeout = async (promise, timeoutMs, options = {}) => {
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => {
				reject(/* @__PURE__ */ new Error(`timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			if (options.unref) timer.unref?.();
		});
		try {
			return await Promise.race([promise, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	const runSyncHookHandler = (hook, event, ctx) => {
		const handler = hook.handler;
		return handler(event, ctx);
	};
	/**
	* Run a hook that doesn't return a value (fire-and-forget style).
	* All handlers are executed in parallel for performance.
	*/
	async function runVoidHook(hookName, event, ctx, options = {}) {
		const hooks = getHooksForName(registry, hookName);
		if (hooks.length === 0) return;
		logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers)`);
		const promises = hooks.map(async (hook) => {
			try {
				const promise = Promise.resolve(hook.handler(event, ctx));
				const timeoutMs = getVoidHookTimeoutMs(hookName, hook);
				if (timeoutMs) await withHookTimeout(promise, timeoutMs, { unref: options.unrefTimeout ?? true });
				else await promise;
			} catch (err) {
				handleHookError({
					hookName,
					pluginId: hook.pluginId,
					error: err
				});
			}
		});
		await Promise.all(promises);
	}
	/**
	* Run a hook that can return a modifying result.
	* Handlers are executed sequentially in priority order, and results are merged.
	*/
	async function runModifyingHook(hookName, event, ctx, policy = {}) {
		const hooks = getHooksForName(registry, hookName);
		if (hooks.length === 0) return;
		logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, sequential)`);
		let result;
		for (const hook of hooks) try {
			const handler = hook.handler;
			const promise = Promise.resolve(handler(event, ctx));
			const timeoutMs = getModifyingHookTimeoutMs(hookName, hook);
			const handlerResult = timeoutMs ? await withHookTimeout(promise, timeoutMs) : await promise;
			if (handlerResult !== void 0 && (handlerResult !== null || policy.mergeNullResults)) {
				if (policy.mergeResults) result = policy.mergeResults(result, handlerResult, hook);
				else result = handlerResult;
				if (result && policy.shouldStop?.(result)) {
					const terminalLabel = policy.terminalLabel ? ` ${policy.terminalLabel}` : "";
					const priority = hook.priority ?? 0;
					logger?.debug?.(`[hooks] ${hookName}${terminalLabel} decided by ${hook.pluginId} (priority=${priority}); skipping remaining handlers`);
					policy.onTerminal?.({
						hookName,
						pluginId: hook.pluginId,
						result
					});
					break;
				}
			}
		} catch (err) {
			handleHookError({
				hookName,
				pluginId: hook.pluginId,
				error: err
			});
		}
		return result;
	}
	/**
	* Run a sequential claim hook where the first `{ handled: true }` result wins.
	*/
	async function runClaimingHook(hookName, event, ctx) {
		const hooks = getHooksForName(registry, hookName);
		if (hooks.length === 0) return;
		logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, first-claim wins)`);
		return await runClaimingHooksList(hooks, hookName, event, ctx);
	}
	async function runClaimingHookForPlugin(hookName, pluginId, event, ctx) {
		const hooks = getHooksForNameAndPlugin(registry, hookName, pluginId);
		if (hooks.length === 0) return;
		logger?.debug?.(`[hooks] running ${hookName} for ${pluginId} (${hooks.length} handlers, targeted)`);
		return await runClaimingHooksList(hooks, hookName, event, ctx);
	}
	async function runClaimingHooksList(hooks, hookName, event, ctx) {
		for (const hook of hooks) try {
			const promise = Promise.resolve(hook.handler(event, ctx));
			const timeoutMs = getClaimingHookTimeoutMs(hookName, hook);
			const handlerResult = timeoutMs ? await withHookTimeout(promise, timeoutMs) : await promise;
			if (handlerResult?.handled) return handlerResult;
		} catch (err) {
			handleHookError({
				hookName,
				pluginId: hook.pluginId,
				error: err
			});
		}
	}
	async function runClaimingHookForPluginOutcome(hookName, pluginId, event, ctx) {
		if (!registry.plugins.some((plugin) => plugin.id === pluginId && plugin.status === "loaded")) return { status: "missing_plugin" };
		const hooks = getHooksForNameAndPlugin(registry, hookName, pluginId);
		if (hooks.length === 0) return { status: "no_handler" };
		logger?.debug?.(`[hooks] running ${hookName} for ${pluginId} (${hooks.length} handlers, targeted outcome)`);
		let firstError = null;
		for (const hook of hooks) try {
			const promise = Promise.resolve(hook.handler(event, ctx));
			const timeoutMs = getClaimingHookTimeoutMs(hookName, hook);
			const handlerResult = timeoutMs ? await withHookTimeout(promise, timeoutMs) : await promise;
			if (handlerResult?.handled) return {
				status: "handled",
				result: handlerResult
			};
		} catch (err) {
			firstError ??= sanitizeHookError(err);
			handleHookError({
				hookName,
				pluginId: hook.pluginId,
				error: err
			});
		}
		if (firstError) return {
			status: "error",
			error: firstError
		};
		return { status: "declined" };
	}
	function withAgentRunId(event, ctx) {
		if (event.runId || !ctx.runId) return event;
		return {
			...event,
			runId: ctx.runId
		};
	}
	/**
	* Run before_model_resolve hook.
	* Allows plugins to override provider/model before model resolution.
	*/
	async function runBeforeModelResolve(event, ctx) {
		return runModifyingHook("before_model_resolve", event, ctx, { mergeResults: mergeBeforeModelResolve });
	}
	/**
	* Run before_prompt_build hook.
	* Allows plugins to inject context and system prompt before prompt submission.
	*/
	async function runBeforePromptBuild(event, ctx) {
		return runModifyingHook("before_prompt_build", event, ctx, { mergeResults: mergeBeforePromptBuild });
	}
	async function runAgentTurnPrepare(event, ctx) {
		return runModifyingHook("agent_turn_prepare", event, ctx, { mergeResults: mergeAgentTurnPrepare });
	}
	/**
	* @deprecated Use runBeforeModelResolve and runBeforePromptBuild.
	*
	* Run before_agent_start hook.
	* Legacy compatibility hook that combines model resolve + prompt build phases.
	*/
	async function runBeforeAgentStart(event, ctx) {
		return runModifyingHook("before_agent_start", withAgentRunId(event, ctx), ctx, { mergeResults: (acc, next) => ({
			...mergeBeforePromptBuild(acc, next),
			...mergeBeforeModelResolve(acc, next)
		}) });
	}
	/**
	* Run before_agent_reply hook.
	* Allows plugins to intercept messages and return a synthetic reply,
	* short-circuiting the LLM agent. First handler to return { handled: true } wins.
	*/
	async function runBeforeAgentReply(event, ctx) {
		return runClaimingHook("before_agent_reply", event, ctx);
	}
	/**
	* Run model_call_started hook.
	* Allows plugins to observe sanitized model-call metadata.
	* Runs in parallel (fire-and-forget).
	*/
	async function runModelCallStarted(event, ctx) {
		return runVoidHook("model_call_started", event, ctx);
	}
	/**
	* Run model_call_ended hook.
	* Allows plugins to observe sanitized terminal model-call metadata.
	* Runs in parallel (fire-and-forget).
	*/
	async function runModelCallEnded(event, ctx) {
		return runVoidHook("model_call_ended", event, ctx);
	}
	/**
	* Run agent_end hook.
	* Allows plugins to analyze completed conversations.
	* Runs handlers in parallel.
	*/
	async function runAgentEnd(event, ctx, options) {
		return runVoidHook("agent_end", withAgentRunId(event, ctx), ctx, options);
	}
	/**
	* Run llm_input hook.
	* Allows plugins to observe the exact input payload sent to the LLM.
	* Runs in parallel (fire-and-forget).
	*/
	async function runLlmInput(event, ctx) {
		return runVoidHook("llm_input", event, ctx);
	}
	/**
	* Run llm_output hook.
	* Allows plugins to observe the exact output payload returned by the LLM.
	* Runs in parallel (fire-and-forget).
	*/
	async function runLlmOutput(event, ctx) {
		return runVoidHook("llm_output", event, ctx);
	}
	/**
	* Run before_agent_finalize hook.
	* Allows plugins to request one more model pass before a natural final reply
	* is accepted. This is not the user-facing /stop cancellation path.
	*/
	async function runBeforeAgentFinalize(event, ctx) {
		return runModifyingHook("before_agent_finalize", withAgentRunId(event, ctx), ctx, { mergeResults: mergeBeforeAgentFinalize });
	}
	/**
	* Run before_compaction hook.
	*/
	async function runBeforeCompaction(event, ctx) {
		return runVoidHook("before_compaction", event, ctx);
	}
	/**
	* Run after_compaction hook.
	*/
	async function runAfterCompaction(event, ctx) {
		return runVoidHook("after_compaction", event, ctx);
	}
	/**
	* Run before_reset hook.
	* Fired when /new or /reset clears a session, before messages are lost.
	* Runs in parallel (fire-and-forget).
	*/
	async function runBeforeReset(event, ctx) {
		return runVoidHook("before_reset", event, ctx);
	}
	/**
	* Run inbound_claim hook.
	* Allows plugins to claim an inbound event before commands/agent dispatch.
	*/
	async function runInboundClaim(event, ctx) {
		return runClaimingHook("inbound_claim", event, ctx);
	}
	async function runInboundClaimForPlugin(pluginId, event, ctx) {
		return runClaimingHookForPlugin("inbound_claim", pluginId, event, ctx);
	}
	async function runInboundClaimForPluginOutcome(pluginId, event, ctx) {
		return runClaimingHookForPluginOutcome("inbound_claim", pluginId, event, ctx);
	}
	/**
	* Run message_received hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runMessageReceived(event, ctx) {
		return runVoidHook("message_received", event, ctx);
	}
	/**
	* Run before_dispatch hook.
	* Allows plugins to inspect or handle a message before model dispatch.
	* First handler returning { handled: true } wins.
	*/
	async function runBeforeDispatch(event, ctx) {
		return runClaimingHook("before_dispatch", event, ctx);
	}
	/**
	* Run reply_dispatch hook.
	* Allows plugins to own reply dispatch before the default model path runs.
	* First handler returning { handled: true } wins.
	*/
	async function runReplyDispatch(event, ctx) {
		return runClaimingHook("reply_dispatch", event, ctx);
	}
	/**
	* Run message_sending hook.
	* Allows plugins to modify or cancel outgoing messages.
	* Runs sequentially.
	*/
	async function runMessageSending(event, ctx) {
		return runModifyingHook("message_sending", event, ctx, {
			mergeResults: (acc, next) => {
				if (acc?.cancel === true) return acc;
				return {
					content: lastDefined(acc?.content, next.content),
					cancel: stickyTrue(acc?.cancel, next.cancel),
					cancelReason: lastDefined(acc?.cancelReason, next.cancelReason),
					metadata: next.metadata ?? acc?.metadata
				};
			},
			shouldStop: (result) => result.cancel === true,
			terminalLabel: "cancel=true"
		});
	}
	/**
	* Run message_sent hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runMessageSent(event, ctx) {
		return runVoidHook("message_sent", event, ctx);
	}
	/**
	* Run before_agent_run gate hook.
	* Fires after session resolution and workspace preparation, before model inference.
	* Returns the most-restrictive pass/block decision from all handlers.
	* Handlers that return void are treated as pass.
	*/
	async function runBeforeAgentRun(event, ctx) {
		let winningPluginId;
		const decision = await runModifyingHook("before_agent_run", event, ctx, {
			mergeResults: (_acc, next, reg) => {
				if (next === void 0 || next === null) {
					const normalized = {
						outcome: "block",
						reason: "before_agent_run returned an invalid decision"
					};
					winningPluginId = reg.pluginId;
					return normalized;
				}
				const normalized = isHookDecision(next) ? next : {
					outcome: "block",
					reason: "before_agent_run returned an invalid decision"
				};
				const merged = !_acc || normalized.outcome === "block" && _acc.outcome !== "block" ? normalized : _acc;
				if (merged === normalized) winningPluginId = reg.pluginId;
				return merged;
			},
			mergeNullResults: true,
			shouldStop: (result) => result?.outcome === "block",
			terminalLabel: "gate-decision"
		});
		if (!decision) return;
		return {
			decision,
			pluginId: winningPluginId ?? "unknown"
		};
	}
	/**
	* Run before_tool_call hook.
	* Allows plugins to modify or block tool calls.
	* Runs sequentially.
	*/
	async function runBeforeToolCall(event, ctx) {
		return runModifyingHook("before_tool_call", event, ctx, {
			mergeResults: (acc, next, reg) => {
				if (acc?.block === true) return acc;
				const approvalPluginId = acc?.requireApproval?.pluginId;
				return {
					params: Boolean(approvalPluginId) && approvalPluginId !== reg.pluginId ? acc?.params : lastDefined(acc?.params, next.params),
					block: stickyTrue(acc?.block, next.block),
					blockReason: lastDefined(acc?.blockReason, next.blockReason),
					requireApproval: acc?.requireApproval ?? (next.requireApproval ? {
						...next.requireApproval,
						pluginId: reg.pluginId
					} : void 0)
				};
			},
			shouldStop: (result) => result.block === true,
			terminalLabel: "block=true"
		});
	}
	/**
	* Run after_tool_call hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runAfterToolCall(event, ctx) {
		return runVoidHook("after_tool_call", event, ctx);
	}
	/**
	* Run tool_result_persist hook.
	*
	* This hook is intentionally synchronous: it runs in hot paths where session
	* transcripts are appended synchronously.
	*
	* Handlers are executed sequentially in priority order (higher first). Each
	* handler may return `{ message }` to replace the message passed to the next
	* handler.
	*/
	function runToolResultPersist(event, ctx) {
		const hooks = getHooksForName(registry, "tool_result_persist");
		if (hooks.length === 0) return;
		let current = event.message;
		for (const hook of hooks) try {
			const out = runSyncHookHandler(hook, {
				...event,
				message: current
			}, ctx);
			if (isPromiseLike(out)) {
				const msg = `[hooks] tool_result_persist handler from ${hook.pluginId} returned a Promise; this hook is synchronous and the result was ignored.`;
				if (shouldCatchHookErrors("tool_result_persist")) {
					logger?.warn?.(msg);
					continue;
				}
				throw new Error(msg);
			}
			const next = out?.message;
			if (next) current = next;
		} catch (err) {
			const msg = `[hooks] tool_result_persist handler from ${hook.pluginId} failed: ${String(err)}`;
			if (shouldCatchHookErrors("tool_result_persist")) logger?.error(msg);
			else throw new Error(msg, { cause: err });
		}
		return { message: current };
	}
	/**
	* Run before_message_write hook.
	*
	* This hook is intentionally synchronous: it runs on the hot path where
	* session transcripts are appended synchronously.
	*
	* Handlers are executed sequentially in priority order (higher first).
	* If any handler returns { block: true }, the message is NOT written
	* to the session JSONL and we return immediately.
	* If a handler returns { message }, the modified message replaces the
	* original for subsequent handlers and the final write.
	*/
	function runBeforeMessageWrite(event, ctx) {
		const hooks = getHooksForName(registry, "before_message_write");
		if (hooks.length === 0) return;
		let current = event.message;
		for (const hook of hooks) try {
			const out = runSyncHookHandler(hook, {
				...event,
				message: current
			}, ctx);
			if (isPromiseLike(out)) {
				const msg = `[hooks] before_message_write handler from ${hook.pluginId} returned a Promise; this hook is synchronous and the result was ignored.`;
				if (shouldCatchHookErrors("before_message_write")) {
					logger?.warn?.(msg);
					continue;
				}
				throw new Error(msg);
			}
			const result = out;
			if (result?.block) return { block: true };
			if (result?.message) current = result.message;
		} catch (err) {
			const msg = `[hooks] before_message_write handler from ${hook.pluginId} failed: ${String(err)}`;
			if (shouldCatchHookErrors("before_message_write")) logger?.error(msg);
			else throw new Error(msg, { cause: err });
		}
		if (current !== event.message) return { message: current };
	}
	/**
	* Run session_start hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runSessionStart(event, ctx) {
		return runVoidHook("session_start", event, ctx);
	}
	/**
	* Run session_end hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runSessionEnd(event, ctx) {
		return runVoidHook("session_end", event, ctx);
	}
	/**
	* Run subagent_spawning hook.
	* Runs sequentially so channel plugins can deterministically provision session bindings.
	*/
	async function runSubagentSpawning(event, ctx) {
		return runModifyingHook("subagent_spawning", event, ctx, { mergeResults: mergeSubagentSpawningResult });
	}
	/**
	* Run subagent_delivery_target hook.
	* Runs sequentially so channel plugins can deterministically resolve routing.
	*/
	async function runSubagentDeliveryTarget(event, ctx) {
		return runModifyingHook("subagent_delivery_target", event, ctx, { mergeResults: mergeSubagentDeliveryTargetResult });
	}
	/**
	* Run subagent_spawned hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runSubagentSpawned(event, ctx) {
		return runVoidHook("subagent_spawned", event, ctx);
	}
	/**
	* Run subagent_ended hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runSubagentEnded(event, ctx) {
		return runVoidHook("subagent_ended", event, ctx);
	}
	/**
	* Run gateway_start hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runGatewayStart(event, ctx) {
		return runVoidHook("gateway_start", event, ctx);
	}
	/**
	* Run gateway_stop hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runGatewayStop(event, ctx) {
		return runVoidHook("gateway_stop", event, ctx);
	}
	async function runHeartbeatPromptContribution(event, ctx) {
		return runModifyingHook("heartbeat_prompt_contribution", event, ctx, { mergeResults: mergeAgentTurnPrepare });
	}
	/**
	* Run cron_changed hook for gateway-owned cron lifecycle changes.
	*/
	async function runCronChanged(event, ctx) {
		return runVoidHook("cron_changed", event, ctx);
	}
	/**
	* Run before_install hook.
	* Allows plugins to augment scan findings or block installs.
	* Runs sequentially so higher-priority hooks can block before lower ones run.
	*/
	async function runBeforeInstall(event, ctx) {
		return runModifyingHook("before_install", event, ctx, {
			mergeResults: (acc, next) => {
				if (acc?.block === true) return acc;
				const mergedFindings = [...acc?.findings ?? [], ...next.findings ?? []];
				return {
					findings: mergedFindings.length > 0 ? mergedFindings : void 0,
					block: stickyTrue(acc?.block, next.block),
					blockReason: lastDefined(acc?.blockReason, next.blockReason)
				};
			},
			shouldStop: (result) => result.block === true,
			terminalLabel: "block=true"
		});
	}
	function hasHooks(hookName) {
		return registry.typedHooks.some((h) => h.hookName === hookName);
	}
	/**
	* Get count of registered hooks for a given hook name.
	*/
	function getHookCount(hookName) {
		return registry.typedHooks.filter((h) => h.hookName === hookName).length;
	}
	return {
		runBeforeModelResolve,
		runAgentTurnPrepare,
		runBeforePromptBuild,
		runBeforeAgentStart,
		runBeforeAgentReply,
		runModelCallStarted,
		runModelCallEnded,
		runLlmInput,
		runLlmOutput,
		runBeforeAgentFinalize,
		runAgentEnd,
		runBeforeCompaction,
		runAfterCompaction,
		runBeforeReset,
		runBeforeAgentRun,
		runInboundClaim,
		runInboundClaimForPlugin,
		runInboundClaimForPluginOutcome,
		runMessageReceived,
		runBeforeDispatch,
		runReplyDispatch,
		runMessageSending,
		runMessageSent,
		runBeforeToolCall,
		runAfterToolCall,
		runToolResultPersist,
		runBeforeMessageWrite,
		runSessionStart,
		runSessionEnd,
		runSubagentSpawning,
		runSubagentDeliveryTarget,
		runSubagentSpawned,
		runSubagentEnded,
		runGatewayStart,
		runGatewayStop,
		runHeartbeatPromptContribution,
		runCronChanged,
		runBeforeInstall,
		hasHooks,
		getHookCount
	};
}
//#endregion
//#region src/plugins/hook-runner-global.ts
/**
* Global Plugin Hook Runner
*
* Singleton hook runner that's initialized when plugins are loaded
* and can be called from anywhere in the codebase.
*/
const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");
const getState = () => resolveGlobalSingleton(hookRunnerGlobalStateKey, () => ({
	hookRunner: null,
	registry: null
}));
const getLog = () => createSubsystemLogger("plugins");
/**
* Initialize the global hook runner with a plugin registry.
* Called once when plugins are loaded during gateway startup.
*/
function initializeGlobalHookRunner(registry) {
	const state = getState();
	const log = getLog();
	state.registry = registry;
	state.hookRunner = createHookRunner(registry, {
		logger: {
			debug: (msg) => log.debug(msg),
			warn: (msg) => log.warn(msg),
			error: (msg) => log.error(msg)
		},
		catchErrors: true,
		failurePolicyByHook: {
			before_agent_run: "fail-closed",
			before_tool_call: "fail-closed"
		}
	});
	const hookCount = registry.hooks.length;
	if (hookCount > 0) log.debug(`hook runner initialized with ${hookCount} registered hooks`);
}
/**
* Get the global hook runner.
* Returns null if plugins haven't been loaded yet.
*/
function getGlobalHookRunner() {
	return getState().hookRunner;
}
/**
* Get the global plugin registry.
* Returns null if plugins haven't been loaded yet.
*/
function getGlobalPluginRegistry() {
	return getState().registry;
}
/**
* Check if any hooks are registered for a given hook name.
*/
function hasGlobalHooks(hookName) {
	return getState().hookRunner?.hasHooks(hookName) ?? false;
}
async function runGlobalGatewayStopSafely(params) {
	const log = getLog();
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("gateway_stop")) return;
	try {
		await hookRunner.runGatewayStop(params.event, params.ctx);
	} catch (err) {
		if (params.onError) {
			params.onError(err);
			return;
		}
		log.warn(`gateway_stop hook failed: ${String(err)}`);
	}
}
/**
* Reset the global hook runner (for testing).
*/
function resetGlobalHookRunner() {
	const state = getState();
	state.hookRunner = null;
	state.registry = null;
}
//#endregion
export { resetGlobalHookRunner as a, joinPresentTextSegments as c, formatHookErrorForLog as d, initializeGlobalHookRunner as i, fireAndForgetBoundedHook as l, getGlobalPluginRegistry as n, runGlobalGatewayStopSafely as o, hasGlobalHooks as r, resolveBlockMessage as s, getGlobalHookRunner as t, fireAndForgetHook as u };
