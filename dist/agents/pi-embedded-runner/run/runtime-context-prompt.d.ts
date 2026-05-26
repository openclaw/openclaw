import { c as OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE, t as CurrentTurnPromptContext } from "../../../params-DXH1hJUt.js";

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
declare function buildCurrentTurnPrompt(params: {
  context: CurrentTurnPromptContext | undefined;
  prompt: string;
}): string;
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
export { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE, buildCurrentTurnPrompt, buildCurrentTurnPromptContextPrefix, buildRuntimeContextSystemContext, buildRuntimeEventSystemContext, queueRuntimeContextForNextTurn, resolveRuntimeContextPromptParts };