import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import type { EmbeddedRunTrigger } from "./params.js";

/**
 * Builds the stable tool-run context forwarded into an embedded-attempt execution.
 */
export function buildEmbeddedAttemptToolRunContext(params: {
  trigger?: EmbeddedRunTrigger;
  jobId?: string;
  cronSessionTarget?: string;
  cronSessionIsNew?: boolean;
  memoryFlushWritePath?: string;
  toolsAllow?: string[];
  trace?: DiagnosticTraceContext;
}): {
  trigger?: EmbeddedRunTrigger;
  jobId?: string;
  cronSessionTarget?: string;
  cronSessionIsNew?: boolean;
  memoryFlushWritePath?: string;
  runtimeToolAllowlist?: string[];
  trace?: DiagnosticTraceContext;
} {
  return {
    trigger: params.trigger,
    jobId: params.jobId,
    cronSessionTarget: params.cronSessionTarget,
    cronSessionIsNew: params.cronSessionIsNew,
    memoryFlushWritePath: params.memoryFlushWritePath,
    ...(params.toolsAllow ? { runtimeToolAllowlist: params.toolsAllow } : {}),
    // Freeze trace metadata at the attempt boundary so later mutable diagnostic updates do not
    // rewrite the facts attached to tool calls already in flight.
    ...(params.trace ? { trace: freezeDiagnosticTraceContext(params.trace) } : {}),
  };
}
