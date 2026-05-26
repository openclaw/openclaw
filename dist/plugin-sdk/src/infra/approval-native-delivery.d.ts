import type { ChannelApprovalNativeAdapter, ChannelApprovalNativeSurface, ChannelApprovalNativeTarget } from "../channels/plugins/approval-native.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelApprovalKind } from "./approval-types.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";
type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
export type ChannelApprovalNativePlannedTarget = {
    surface: ChannelApprovalNativeSurface;
    target: ChannelApprovalNativeTarget;
    reason: "preferred" | "fallback";
};
export type ChannelApprovalNativeDeliveryPlan = {
    targets: ChannelApprovalNativePlannedTarget[];
    originTarget: ChannelApprovalNativeTarget | null;
    notifyOriginWhenDmOnly: boolean;
};
export declare function resolveChannelNativeApprovalDeliveryPlan(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ChannelApprovalKind;
    request: ApprovalRequest;
    adapter?: ChannelApprovalNativeAdapter | null;
}): Promise<ChannelApprovalNativeDeliveryPlan>;
export {};
