import { i as OpenClawConfig } from "./types.openclaw-BlE9q7jU.js";
import { o as ExecApprovalDecision } from "./exec-approvals-BSL4o1U8.js";

//#region src/infra/approval-gateway-resolver.d.ts
type ResolveApprovalOverGatewayParams = {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: ExecApprovalDecision;
  senderId?: string | null;
  allowPluginFallback?: boolean;
  gatewayUrl?: string;
  clientDisplayName?: string;
};
declare function resolveApprovalOverGateway(params: ResolveApprovalOverGatewayParams): Promise<void>;
//#endregion
export { resolveApprovalOverGateway as t };