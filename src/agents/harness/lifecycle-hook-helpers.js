import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { buildAgentHookContext } from "./hook-context.js";
const log = createSubsystemLogger("agents/harness");
export function runAgentHarnessLlmInputHook(params) {
    const hookRunner = params.hookRunner ?? getGlobalHookRunner();
    if (!hookRunner?.hasHooks("llm_input")) {
        return;
    }
    void hookRunner.runLlmInput(params.event, buildAgentHookContext(params.ctx)).catch((error) => {
        log.warn(`llm_input hook failed: ${String(error)}`);
    });
}
export function runAgentHarnessLlmOutputHook(params) {
    const hookRunner = params.hookRunner ?? getGlobalHookRunner();
    if (!hookRunner?.hasHooks("llm_output")) {
        return;
    }
    void hookRunner.runLlmOutput(params.event, buildAgentHookContext(params.ctx)).catch((error) => {
        log.warn(`llm_output hook failed: ${String(error)}`);
    });
}
export function runAgentHarnessAgentEndHook(params) {
    const hookRunner = params.hookRunner ?? getGlobalHookRunner();
    if (!hookRunner?.hasHooks("agent_end")) {
        return;
    }
    void hookRunner.runAgentEnd(params.event, buildAgentHookContext(params.ctx)).catch((error) => {
        log.warn(`agent_end hook failed: ${String(error)}`);
    });
}
