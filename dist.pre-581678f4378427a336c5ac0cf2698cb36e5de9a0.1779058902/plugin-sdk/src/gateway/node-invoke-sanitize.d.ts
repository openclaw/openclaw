import type { ExecApprovalManager } from "./exec-approval-manager.js";
import type { GatewayClient } from "./server-methods/types.js";
export declare function sanitizeNodeInvokeParamsForForwarding(opts: {
    nodeId: string;
    command: string;
    rawParams: unknown;
    client: GatewayClient | null;
    execApprovalManager?: ExecApprovalManager;
}): {
    ok: true;
    params: unknown;
} | {
    ok: false;
    message: string;
    details?: Record<string, unknown>;
};
