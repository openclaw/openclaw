import type { StreamFn } from "@earendil-works/pi-agent-core";
import { diagnosticErrorCategory } from "../../../infra/diagnostic-error-metadata.js";
import { type DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
export { diagnosticErrorCategory };
type ModelCallDiagnosticContext = {
    runId: string;
    sessionKey?: string;
    sessionId?: string;
    provider: string;
    model: string;
    api?: string;
    transport?: string;
    trace: DiagnosticTraceContext;
    nextCallId: () => string;
    onStarted?: () => void;
};
export declare function wrapStreamFnWithDiagnosticModelCallEvents(streamFn: StreamFn, ctx: ModelCallDiagnosticContext): StreamFn;
