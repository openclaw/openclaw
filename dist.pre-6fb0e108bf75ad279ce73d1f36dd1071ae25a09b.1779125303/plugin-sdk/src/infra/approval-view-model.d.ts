import type { ApprovalRequest, ApprovalResolved, ExpiredApprovalView, PendingApprovalView, ResolvedApprovalView } from "./approval-view-model.types.js";
export declare function buildPendingApprovalView(request: ApprovalRequest): PendingApprovalView;
export declare function buildResolvedApprovalView(request: ApprovalRequest, resolved: ApprovalResolved): ResolvedApprovalView;
export declare function buildExpiredApprovalView(request: ApprovalRequest): ExpiredApprovalView;
