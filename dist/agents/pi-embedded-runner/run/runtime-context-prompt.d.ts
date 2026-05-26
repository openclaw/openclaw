import { c as OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE, t as CurrentInboundPromptContext } from "../../../params-C8lj3xSa.js";

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
type EmptyTranscriptMode = "model-prompt" | "runtime-event";
declare function buildCurrentInboundPromptContextPrefix(context: CurrentInboundPromptContext | undefined): string;
declare function buildCurrentInboundPrompt(params: {
  context: CurrentInboundPromptContext | undefined;
  prompt: string;
}): string;
declare function resolveRuntimeContextPromptParts(params: {
  effectivePrompt: string;
  transcriptPrompt?: string;
  emptyTranscriptMode?: EmptyTranscriptMode;
}): RuntimeContextPromptParts;
declare function buildRuntimeContextSystemContext(runtimeContext: string): string;
declare function buildRuntimeEventSystemContext(runtimeContext: string): string;
declare function queueRuntimeContextForNextTurn(params: {
  session: RuntimeContextSession;
  runtimeContext?: string;
}): Promise<void>;
//#endregion
export { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE, buildCurrentInboundPrompt, buildCurrentInboundPromptContextPrefix, buildRuntimeContextSystemContext, buildRuntimeEventSystemContext, queueRuntimeContextForNextTurn, resolveRuntimeContextPromptParts };