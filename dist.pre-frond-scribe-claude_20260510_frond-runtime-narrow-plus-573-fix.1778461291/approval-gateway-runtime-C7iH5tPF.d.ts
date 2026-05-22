import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { o as ExecApprovalDecision } from "./exec-approvals-Cny7WQkJ.js";

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