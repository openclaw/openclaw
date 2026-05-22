import { t as createSubsystemLogger } from "./subsystem-CgTF-J8V.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-j8teApmQ.js";
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
		...params.channelId ? { channelId: params.channelId } : {}
	};
}
//#endregion
//#region src/agents/harness/lifecycle-hook-helpers.ts
const log = createSubsystemLogger("agents/harness");
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
function runAgentHarnessAgentEndHook(params) {
	const hookRunner = params.hookRunner ?? getGlobalHookRunner();
	if (!hookRunner?.hasHooks("agent_end") || typeof hookRunner.runAgentEnd !== "function") return;
	hookRunner.runAgentEnd(params.event, buildAgentHookContext(params.ctx)).catch((error) => {
		log.warn(`agent_end hook failed: ${String(error)}`);
	});
}
async function runAgentHarnessBeforeAgentFinalizeHook(params) {
	const hookRunner = params.hookRunner ?? getGlobalHookRunner();
	if (!hookRunner?.hasHooks("before_agent_finalize") || typeof hookRunner.runBeforeAgentFinalize !== "function") return { action: "continue" };
	try {
		return normalizeBeforeAgentFinalizeResult(await hookRunner.runBeforeAgentFinalize(params.event, buildAgentHookContext(params.ctx)));
	} catch (error) {
		log.warn(`before_agent_finalize hook failed: ${String(error)}`);
		return { action: "continue" };
	}
}
function normalizeBeforeAgentFinalizeResult(result) {
	if (result?.action === "finalize") return result.reason?.trim() ? {
		action: "finalize",
		reason: result.reason.trim()
	} : { action: "finalize" };
	if (result?.action === "revise") {
		const reason = result.reason?.trim();
		return reason ? {
			action: "revise",
			reason
		} : { action: "continue" };
	}
	return { action: "continue" };
}
//#endregion
export { buildAgentHookContext as a, runAgentHarnessLlmOutputHook as i, runAgentHarnessBeforeAgentFinalizeHook as n, runAgentHarnessLlmInputHook as r, runAgentHarnessAgentEndHook as t };
