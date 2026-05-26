import { n as resolveGlobalSingleton } from "./global-singleton-DE6St75u.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-BkXXy1ub.js";
import { createHash } from "node:crypto";
//#region src/agents/harness/hook-context.ts
function buildAgentHookContext(params) {
	return {
		runId: params.runId,
		...params.jobId ? { jobId: params.jobId } : {},
		...params.agentId ? { agentId: params.agentId } : {},
		...params.sessionKey ? { sessionKey: params.sessionKey } : {},
		...params.sessionId ? { sessionId: params.sessionId } : {},
		...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {},
		...params.modelProviderId ? { modelProviderId: params.modelProviderId } : {},
		...params.modelId ? { modelId: params.modelId } : {},
		...params.messageProvider ? { messageProvider: params.messageProvider } : {},
		...params.trigger ? { trigger: params.trigger } : {},
		...params.channelId ? { channelId: params.channelId } : {},
		...params.contextTokenBudget ? { contextTokenBudget: params.contextTokenBudget } : {},
		...params.contextWindowSource ? { contextWindowSource: params.contextWindowSource } : {},
		...params.contextWindowReferenceTokens ? { contextWindowReferenceTokens: params.contextWindowReferenceTokens } : {}
	};
}
//#endregion
//#region src/agents/harness/lifecycle-hook-helpers.ts
const log = createSubsystemLogger("agents/harness");
const FINALIZE_RETRY_BUDGET_KEY = Symbol.for("openclaw.pluginFinalizeRetryBudget");
const FINALIZE_RETRY_BUDGET_MAX_ENTRIES = 2048;
function getFinalizeRetryBudget() {
	return resolveGlobalSingleton(FINALIZE_RETRY_BUDGET_KEY, () => /* @__PURE__ */ new Map());
}
function countFinalizeRetryBudgetEntries(budget) {
	let count = 0;
	for (const runBudget of budget.values()) count += runBudget.size;
	return count;
}
function pruneFinalizeRetryBudget(budget) {
	while (countFinalizeRetryBudgetEntries(budget) > FINALIZE_RETRY_BUDGET_MAX_ENTRIES) {
		const oldestRunId = budget.keys().next().value;
		if (oldestRunId === void 0) return;
		const oldestRunBudget = budget.get(oldestRunId);
		const oldestRetryKey = oldestRunBudget?.keys().next().value;
		if (oldestRunBudget && oldestRetryKey !== void 0) oldestRunBudget.delete(oldestRetryKey);
		if (!oldestRunBudget || oldestRunBudget.size === 0) budget.delete(oldestRunId);
	}
}
function buildFinalizeRetryInstructionKey(instruction) {
	return `instruction:${createHash("sha256").update(instruction).digest("hex")}`;
}
function runAgentHarnessLlmInputHook(params) {
	const hookRunner = params.hookRunner ?? getGlobalHookRunner();
	if (!hookRunner?.hasHooks("llm_input") || typeof hookRunner.runLlmInput !== "function") return;
	hookRunner.runLlmInput(params.event, buildAgentHookContext(params.ctx)).catch((error) => {
		log.warn(`llm_input hook failed: ${String(error)}`);
	});
}
function runAgentHarnessLlmOutputHook(params) {
	const hookRunner = params.hookRunner ?? getGlobalHookRunner();
	if (!hookRunner?.hasHooks("llm_output") || typeof hookRunner.runLlmOutput !== "function") return;
	hookRunner.runLlmOutput(params.event, buildAgentHookContext(params.ctx)).catch((error) => {
		log.warn(`llm_output hook failed: ${String(error)}`);
	});
}
async function executeAgentHarnessAgentEndHook(params) {
	const hookRunner = params.hookRunner ?? getGlobalHookRunner();
	if (!hookRunner?.hasHooks("agent_end") || typeof hookRunner.runAgentEnd !== "function") return;
	try {
		const options = { unrefTimeout: params.unrefTimeout ?? false };
		await hookRunner.runAgentEnd(params.event, buildAgentHookContext(params.ctx), options);
	} catch (error) {
		log.warn(`agent_end hook failed: ${String(error)}`);
	}
}
function runAgentHarnessAgentEndHook(params) {
	executeAgentHarnessAgentEndHook({
		...params,
		unrefTimeout: true
	});
}
async function awaitAgentHarnessAgentEndHook(params) {
	await executeAgentHarnessAgentEndHook({
		...params,
		unrefTimeout: false
	});
}
async function runAgentHarnessBeforeAgentFinalizeHook(params) {
	const hookRunner = params.hookRunner ?? getGlobalHookRunner();
	if (!hookRunner?.hasHooks("before_agent_finalize") || typeof hookRunner.runBeforeAgentFinalize !== "function") return { action: "continue" };
	try {
		const eventForNormalization = {
			...params.event,
			runId: params.event.runId ?? params.ctx.runId
		};
		return normalizeBeforeAgentFinalizeResult(await hookRunner.runBeforeAgentFinalize(eventForNormalization, buildAgentHookContext(params.ctx)), eventForNormalization);
	} catch (error) {
		log.warn(`before_agent_finalize hook failed: ${String(error)}`);
		return { action: "continue" };
	}
}
function normalizeBeforeAgentFinalizeResult(result, event) {
	if (result?.action === "finalize") {
		const reason = normalizeTrimmedString(result.reason);
		return reason ? {
			action: "finalize",
			reason
		} : { action: "finalize" };
	}
	if (result?.action === "revise") {
		const retryCandidates = readBeforeAgentFinalizeRetryCandidates(result);
		if (retryCandidates.length > 0) {
			const reason = normalizeTrimmedString(result.reason);
			for (const retry of retryCandidates) {
				const retryInstruction = normalizeTrimmedString(retry.instruction);
				if (!retryInstruction) continue;
				const maxAttempts = typeof retry.maxAttempts === "number" && Number.isFinite(retry.maxAttempts) ? Math.max(1, Math.floor(retry.maxAttempts)) : 1;
				const retryRunId = event?.runId ?? event?.sessionId ?? "unknown-run";
				const retryKey = normalizeTrimmedString(retry.idempotencyKey) || buildFinalizeRetryInstructionKey(retryInstruction);
				const budget = getFinalizeRetryBudget();
				const runBudget = budget.get(retryRunId) ?? /* @__PURE__ */ new Map();
				const nextCount = (runBudget.get(retryKey) ?? 0) + 1;
				runBudget.delete(retryKey);
				runBudget.set(retryKey, nextCount);
				budget.delete(retryRunId);
				budget.set(retryRunId, runBudget);
				pruneFinalizeRetryBudget(budget);
				if (nextCount > maxAttempts) continue;
				return {
					action: "revise",
					reason: reason && reason.includes(retryInstruction) ? reason : [reason, retryInstruction].filter(Boolean).join("\n\n")
				};
			}
			return { action: "continue" };
		}
		const reason = normalizeTrimmedString(result.reason);
		return reason ? {
			action: "revise",
			reason
		} : { action: "continue" };
	}
	return { action: "continue" };
}
function readBeforeAgentFinalizeRetryCandidates(result) {
	const candidateList = result.retryCandidates;
	if (Array.isArray(candidateList) && candidateList.length > 0) return candidateList.filter(isBeforeAgentFinalizeRetry);
	return isBeforeAgentFinalizeRetry(result.retry) ? [result.retry] : [];
}
function isBeforeAgentFinalizeRetry(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function normalizeTrimmedString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
//#endregion
export { runAgentHarnessLlmOutputHook as a, runAgentHarnessLlmInputHook as i, runAgentHarnessAgentEndHook as n, buildAgentHookContext as o, runAgentHarnessBeforeAgentFinalizeHook as r, awaitAgentHarnessAgentEndHook as t };
