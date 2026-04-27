import { type DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { EmbeddedRunTrigger } from "./params.js";
export declare function buildEmbeddedAttemptToolRunContext(params: {
    trigger?: EmbeddedRunTrigger;
    memoryFlushWritePath?: string;
    trace?: DiagnosticTraceContext;
}): {
    trigger?: EmbeddedRunTrigger;
    memoryFlushWritePath?: string;
    trace?: DiagnosticTraceContext;
};
