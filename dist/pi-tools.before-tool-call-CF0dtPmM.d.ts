import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { b as ToolLoopDetectionConfig } from "./types.tools-B8rv6fwX.js";
import { s as SandboxFsBridge } from "./backend-handle.types-CV0eiC5x.js";
import { t as DiagnosticTraceContext } from "./diagnostic-trace-context-Cr5jFRhS.js";
import { r as AnyAgentTool } from "./common-5s-NiX7e.js";

//#region src/agents/pi-tools.before-tool-call.d.ts
type ToolOutcomeObservation = {
  toolName: string;
  argsHash: string;
  resultHash: string;
};
type ToolOutcomeObserver = (observation: ToolOutcomeObservation) => void;
type HookContext = {
  agentId?: string;
  config?: OpenClawConfig; /** Tool execution cwd for host-derived path facts. */
  cwd?: string;
  sessionKey?: string; /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  channelId?: string;
  loopDetection?: ToolLoopDetectionConfig;
  onToolOutcome?: ToolOutcomeObserver;
  sandbox?: {
    root: string;
    bridge: SandboxFsBridge;
  };
};
declare function wrapToolWithBeforeToolCallHook(tool: AnyAgentTool, ctx?: HookContext): AnyAgentTool;
declare function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean;
//#endregion
export { isToolWrappedWithBeforeToolCallHook as n, wrapToolWithBeforeToolCallHook as r, ToolOutcomeObserver as t };