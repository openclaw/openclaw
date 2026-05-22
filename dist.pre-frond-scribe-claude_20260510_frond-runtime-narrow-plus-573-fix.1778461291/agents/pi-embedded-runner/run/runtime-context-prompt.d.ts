import { t as CurrentTurnPromptContext, u as OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../../../params-DQpvmtuc.js";

//#region src/agents/pi-embedded-runner/run/runtime-context-prompt.d.ts
type RuntimeContextSession = {
  sendCustomMessage: (message: {
    customType: string;
    content: string;
    display: boolean;
    details?: Record<string, unknown>;
  }, options?: {
    deliverAs?: "nextTurn";
    triggerTurn?: boolean;
  }) => Promise<void>;
};
type RuntimeContextPromptParts = {
  prompt: string;
  runtimeContext?: string;
  runtimeOnly?: boolean;
  runtimeSystemContext?: string;
};
declare function buildCurrentTurnPromptContextPrefix(context: CurrentTurnPromptContext | undefined): string;
declare function resolveRuntimeContextPromptParts(params: {
  effectivePrompt: string;
  transcriptPrompt?: string;
}): RuntimeContextPromptParts;
declare function buildRuntimeContextSystemContext(runtimeContext: string): string;
declare function buildRuntimeEventSystemContext(runtimeContext: string): string;
declare function queueRuntimeContextForNextTurn(params: {
  session: RuntimeContextSession;
  runtimeContext?: string;
}): Promise<void>;
//#endregion
export { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE, buildCurrentTurnPromptContextPrefix, buildRuntimeContextSystemContext, buildRuntimeEventSystemContext, queueRuntimeContextForNextTurn, resolveRuntimeContextPromptParts };