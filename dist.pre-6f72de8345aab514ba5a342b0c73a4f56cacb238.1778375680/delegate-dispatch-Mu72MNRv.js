import { t as createSubsystemLogger } from "./subsystem--HE_VOOc.js";
import { n as spawnSubagentDirect } from "./subagent-spawn-nS_WHCls.js";
import { t as resolveContinuationRuntimeConfig } from "./config-CeeZL2OF.js";
import { c as peekSoonestUnmaturedDelegateDueAt, n as consumePendingDelegates, s as highestDelayedContinuationReservationHop } from "./delegate-store-B_WXK4Ei.js";
import { i as failFlow } from "./task-flow-runtime-internal-DxnrJRWG.js";
import { a as enqueueSystemEvent } from "./system-events-DLH2vbkB.js";
import { l as retainContinuationTimerRef, o as registerContinuationTimerHandle, u as unregisterContinuationTimerHandle } from "./state-BL772dU8.js";
//#region src/auto-reply/continuation/scheduler.ts
/**
* Continuation scheduler — chain/cost enforcement and turn scheduling.
*
* Handles the post-response decision: should we schedule another turn (work)
* or dispatch a delegate? Enforces maxChainLength, costCapTokens, and delay
* clamping. Arms timers for delayed work/delegates.
*
* NO generation guard. Delayed work survives channel noise by design.
* Safety mechanisms: chain depth, token budget, per-turn delegate cap, delay bounds.
*
* RFC: docs/design/continue-work-signal-v2.md §3.1–§3.4
*/
const log$1 = createSubsystemLogger("continuation/scheduler");
/**
* Check chain and cost caps. Returns null if clear to proceed, or the
* rejection reason.
*/
function checkContinuationBudget(params) {
	const { chainState, config, sessionKey } = params;
	const allocatedChainHop = Math.max(chainState.currentChainCount, params.highestReservationHop ?? highestDelayedContinuationReservationHop(sessionKey));
	if (allocatedChainHop >= config.maxChainLength) {
		log$1.info(`[continuation] Chain depth ${allocatedChainHop}/${config.maxChainLength} — capped for session ${sessionKey}`);
		return "chain-capped";
	}
	if (config.costCapTokens > 0 && chainState.accumulatedChainTokens > config.costCapTokens) {
		log$1.info(`[continuation] Chain cost ${chainState.accumulatedChainTokens}/${config.costCapTokens} — capped for session ${sessionKey}`);
		return "cost-capped";
	}
	return null;
}
//#endregion
//#region src/auto-reply/continuation/delegate-dispatch.ts
/**
* Continuation delegate dispatch — spawn logic for both immediate and delayed delegates.
*
* Consumes pending delegates from the store and dispatches them via spawnSubagentDirect.
* Handles per-turn cap enforcement, chain-hop prefix, and mode flags.
*
* OBSERVABILITY: every spawn outcome (accepted/rejected/failed) is logged at info level,
* regardless of whether the spawn was immediate or timer-triggered. The old branch gated
* success logging behind `timerTriggered`, making immediate delegates invisible to operators.
* Do not reproduce this.
*
* RFC: docs/design/continue-work-signal-v2.md §3.2, §3.4
*/
const log = createSubsystemLogger("continuation/delegate-dispatch");
const HEDGE_DISPATCH_FAILURE_RETRY_MS = 3e4;
const hedgeTimers = /* @__PURE__ */ new Map();
function clearHedgeTimer(sessionKey) {
	const existing = hedgeTimers.get(sessionKey);
	if (existing) {
		clearTimeout(existing);
		hedgeTimers.delete(sessionKey);
		unregisterContinuationTimerHandle(sessionKey, existing);
	}
}
function formatErrorMessage(err) {
	return err instanceof Error ? err.message : String(err);
}
function surfaceHedgeDispatchFailure(sessionKey, errorMessage) {
	try {
		enqueueSystemEvent(`[system:continuation-warning] Hedge-timer dispatch failed; queued delegates may be orphaned. Error: ${errorMessage}. Re-issue continue_delegate if the work is still needed.`, { sessionKey });
	} catch (err) {
		log.error(`[continuation:delegate-hedge-event-error] error=${formatErrorMessage(err)} session=${sessionKey}`);
	}
}
function armHedgeTimer(sessionKey, fireAt, params) {
	clearHedgeTimer(sessionKey);
	const fireIn = Math.max(0, fireAt - Date.now());
	log.info(`[continuation:delegate-hedge-armed] fireIn=${fireIn}ms fireAt=${fireAt} session=${sessionKey}`);
	retainContinuationTimerRef(sessionKey);
	const handle = setTimeout(() => {
		hedgeTimers.delete(sessionKey);
		unregisterContinuationTimerHandle(sessionKey, handle);
		log.info(`[continuation:delegate-hedge-fired] session=${sessionKey}`);
		dispatchToolDelegates({
			sessionKey,
			chainState: params.loadFreshChainState ? params.loadFreshChainState() : params.chainState,
			ctx: params.ctx,
			maxChainLength: params.maxChainLength,
			loadFreshChainState: params.loadFreshChainState
		}).catch((err) => {
			const errorMessage = formatErrorMessage(err);
			log.error(`[continuation:delegate-hedge-error] error=${errorMessage} session=${sessionKey}`);
			surfaceHedgeDispatchFailure(sessionKey, errorMessage);
			try {
				armHedgeTimer(sessionKey, Date.now() + HEDGE_DISPATCH_FAILURE_RETRY_MS, params);
			} catch (rearmErr) {
				log.error(`[continuation:delegate-hedge-rearm-error] error=${formatErrorMessage(rearmErr)} session=${sessionKey}`);
			}
		});
	}, fireIn);
	registerContinuationTimerHandle(sessionKey, handle);
	handle.unref();
	hedgeTimers.set(sessionKey, handle);
}
/**
* Consume and dispatch all pending tool-dispatched delegates for a session.
*
* Called by agent-runner.ts after the response finalizes.
* Each delegate goes through chain/cost enforcement and is spawned via spawnSubagentDirect.
*/
function markDelegateFailed(delegate, summary) {
	if (!delegate.flowId || delegate.expectedRevision === void 0) return;
	failFlow({
		flowId: delegate.flowId,
		expectedRevision: delegate.expectedRevision,
		currentStep: "Delegate spawn failed",
		blockedSummary: summary,
		updatedAt: Date.now()
	});
}
async function dispatchToolDelegates(params) {
	const { sessionKey, chainState, ctx } = params;
	const config = resolveContinuationRuntimeConfig();
	const toolDelegates = consumePendingDelegates(sessionKey);
	const soonestUnmaturedDueAt = peekSoonestUnmaturedDelegateDueAt(sessionKey);
	if (soonestUnmaturedDueAt !== void 0) armHedgeTimer(sessionKey, soonestUnmaturedDueAt, {
		chainState: params.chainState,
		ctx: params.ctx,
		maxChainLength: params.maxChainLength,
		loadFreshChainState: params.loadFreshChainState
	});
	else clearHedgeTimer(sessionKey);
	if (toolDelegates.length === 0) return {
		dispatched: 0,
		rejected: 0,
		chainState
	};
	log.info(`[continue_delegate] Consuming ${toolDelegates.length} tool delegate(s) for session ${sessionKey}`);
	const { maxDelegatesPerTurn, maxChainLength } = config;
	const delegatesWithinLimit = toolDelegates.slice(0, maxDelegatesPerTurn);
	const delegatesOverLimit = toolDelegates.slice(maxDelegatesPerTurn);
	for (const dropped of delegatesOverLimit) {
		const summary = `Tool delegate rejected: maxDelegatesPerTurn exceeded (${maxDelegatesPerTurn}).`;
		log.info(`[continuation:delegate-rejected] maxDelegatesPerTurn=${maxDelegatesPerTurn} task=${dropped.task.slice(0, 80)} session=${sessionKey}`);
		markDelegateFailed(dropped, summary);
		enqueueSystemEvent(`[continuation] ${summary} Task: ${dropped.task}`, { sessionKey });
	}
	let dispatched = 0;
	let rejected = delegatesOverLimit.length;
	let currentChainCount = chainState.currentChainCount;
	let accumulatedTokens = chainState.accumulatedChainTokens;
	for (const delegate of delegatesWithinLimit) {
		const budgetCheck = checkContinuationBudget({
			chainState: {
				currentChainCount,
				chainStartedAt: chainState.chainStartedAt,
				accumulatedChainTokens: accumulatedTokens
			},
			config,
			sessionKey
		});
		if (budgetCheck) {
			const summary = `Tool delegate rejected: ${budgetCheck}.`;
			log.info(`[continuation:delegate-rejected] ${budgetCheck} task=${delegate.task.slice(0, 80)} session=${sessionKey}`);
			markDelegateFailed(delegate, summary);
			enqueueSystemEvent(`[continuation] ${summary} Task: ${delegate.task}`, { sessionKey });
			rejected++;
			continue;
		}
		const nextHop = currentChainCount + 1;
		const silent = delegate.mode === "silent" || delegate.mode === "silent-wake";
		const silentWake = delegate.mode === "silent-wake";
		const spawnCtx = {
			agentSessionKey: sessionKey,
			agentChannel: ctx.agentChannel,
			agentAccountId: ctx.agentAccountId,
			agentTo: ctx.agentTo,
			agentThreadId: ctx.agentThreadId
		};
		try {
			const result = await spawnSubagentDirect({
				task: `[continuation:chain-hop:${nextHop}] Delegated task (turn ${nextHop}/${maxChainLength}): ${delegate.task}`,
				drainsContinuationDelegateQueue: true,
				...silent ? { silentAnnounce: true } : {},
				...silentWake ? {
					silentAnnounce: true,
					wakeOnReturn: true
				} : {},
				...delegate.targetSessionKey ? { continuationTargetSessionKey: delegate.targetSessionKey } : {},
				...delegate.targetSessionKeys && delegate.targetSessionKeys.length > 0 ? { continuationTargetSessionKeys: delegate.targetSessionKeys } : {},
				...delegate.fanoutMode ? { continuationFanoutMode: delegate.fanoutMode } : {}
			}, spawnCtx);
			if (result.status === "accepted") {
				log.info(`[continuation:delegate-spawned] hop=${nextHop}/${maxChainLength} mode=${delegate.mode ?? "normal"} session=${sessionKey} task=${delegate.task.slice(0, 80)}`);
				enqueueSystemEvent(`[continuation:delegate-spawned] Spawned turn ${nextHop}/${maxChainLength}: ${delegate.task}`, { sessionKey });
				dispatched++;
				currentChainCount = nextHop;
			} else {
				const summary = `DELEGATE spawn ${result.status}: delegation was not accepted.`;
				log.info(`[continuation:delegate-spawn-rejected] status=${result.status} session=${sessionKey} task=${delegate.task.slice(0, 80)}`);
				markDelegateFailed(delegate, summary);
				enqueueSystemEvent(`[continuation] ${summary} Task: ${delegate.task}`, { sessionKey });
				rejected++;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const summary = `DELEGATE spawn failed: ${message}`;
			log.info(`[continuation:delegate-spawn-failed] error=${message} session=${sessionKey}`);
			markDelegateFailed(delegate, summary);
			enqueueSystemEvent(`[continuation] ${summary}. Task: ${delegate.task}`, { sessionKey });
			rejected++;
		}
	}
	return {
		dispatched,
		rejected,
		chainState: {
			currentChainCount,
			chainStartedAt: chainState.chainStartedAt,
			accumulatedChainTokens: accumulatedTokens
		}
	};
}
createSubsystemLogger("continuation/compaction");
//#endregion
export { dispatchToolDelegates as t };
