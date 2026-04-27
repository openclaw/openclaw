import { freezeDiagnosticTraceContext, } from "../../../infra/diagnostic-trace-context.js";
export function buildEmbeddedAttemptToolRunContext(params) {
    return {
        trigger: params.trigger,
        memoryFlushWritePath: params.memoryFlushWritePath,
        ...(params.trace ? { trace: freezeDiagnosticTraceContext(params.trace) } : {}),
    };
}
