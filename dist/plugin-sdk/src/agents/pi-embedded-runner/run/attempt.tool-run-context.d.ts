import { type DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { EmbeddedRunTrigger } from "./params.js";
export declare function buildEmbeddedAttemptToolRunContext(params: {
    trigger?: EmbeddedRunTrigger;
    jobId?: string;
    memoryFlushWritePath?: string;
    toolsAllow?: string[];
    trace?: DiagnosticTraceContext;
}): {
    trigger?: EmbeddedRunTrigger;
    jobId?: string;
    memoryFlushWritePath?: string;
    runtimeToolAllowlist?: string[];
    trace?: DiagnosticTraceContext;
};
