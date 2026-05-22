import { i as OpenClawConfig } from "./types.openclaw-C5VNg6h3.js";
import { o as ExecApprovalDecision } from "./exec-approvals-CZNu_RrP.js";

//#region src/infra/approval-gateway-resolver.d.ts
type ResolveApprovalOverGatewayParams = {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: ExecApprovalDecision;
  senderId?: string | null;
  allowPluginFallback?: boolean;
  resolveMethod?: "plugin";
  gatewayUrl?: string;
  clientDisplayName?: string;
};
declare function resolveApprovalOverGateway(params: ResolveApprovalOverGatewayParams): Promise<void>;
//#endregion
export { resolveApprovalOverGateway as t };