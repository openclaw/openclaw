import { i as OpenClawConfig } from "./types.openclaw-Cy0U3Gwh.js";
import { x as ToolLoopDetectionConfig } from "./types.tools-BpgZArJS.js";
import { r as AnyAgentTool } from "./common-D4gcZLB7.js";
import { i as DiagnosticTraceContext } from "./diagnostic-trace-context-CNh-gjbD.js";
import { s as SandboxFsBridge } from "./backend-handle.types-DIWGmbzs.js";

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
type HookBlockedKind = "veto" | "failure";
type HookBlockedReason = "plugin-before-tool-call" | "plugin-approval" | "tool-loop";
type HookOutcome = {
  blocked: true;
  kind?: HookBlockedKind;
  deniedReason?: HookBlockedReason;
  reason: string;
  params?: unknown;
} | {
  blocked: false;
  params: unknown;
};
declare function hasBeforeToolCallPolicy(): boolean;
declare function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
  approvalMode?: "request" | "report";
}): Promise<HookOutcome>;
declare function wrapToolWithBeforeToolCallHook(tool: AnyAgentTool, ctx?: HookContext, options?: {
  emitDiagnostics?: boolean;
}): AnyAgentTool;
declare function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean;
declare function setBeforeToolCallDiagnosticsEnabled(tool: AnyAgentTool, enabled: boolean): void;
//#endregion
export { runBeforeToolCallHook as a, isToolWrappedWithBeforeToolCallHook as i, ToolOutcomeObserver as n, setBeforeToolCallDiagnosticsEnabled as o, hasBeforeToolCallPolicy as r, wrapToolWithBeforeToolCallHook as s, HookContext as t };