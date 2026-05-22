import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecApprovalDecision } from "./exec-approvals.js";
type ResolveApprovalOverGatewayParams = {
    cfg: OpenClawConfig;
    approvalId: string;
    decision: ExecApprovalDecision;
    senderId?: string | null;
    allowPluginFallback?: boolean;
    gatewayUrl?: string;
    clientDisplayName?: string;
};
export declare function resolveApprovalOverGateway(params: ResolveApprovalOverGatewayParams): Promise<void>;
export {};
