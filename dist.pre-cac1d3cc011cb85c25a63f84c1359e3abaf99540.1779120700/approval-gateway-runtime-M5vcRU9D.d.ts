import { i as OpenClawConfig } from "./types.openclaw-C58U02FA.js";
import { o as ExecApprovalDecision } from "./exec-approvals-CkQi7uQJ.js";

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