import type { DiagnosticRunFireReason } from "../../infra/diagnostic-events.js";
import type { GetReplyOptions } from "../types.js";
export declare function resolveReplyRunFireReason(params: {
    opts?: Pick<GetReplyOptions, "continuationTrigger" | "isHeartbeat">;
    drainsContinuationDelegateQueue?: boolean;
}): DiagnosticRunFireReason;
