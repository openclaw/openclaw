import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";
export declare function describeApprovalDeliveryDestination(params: {
    channelLabel: string;
    deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
}): string;
export declare function resolveApprovalRoutedElsewhereNoticeText(destinations: readonly string[]): string | null;
export declare function resolveApprovalDeliveryFailedNoticeText(params: {
    approvalId: string;
    approvalKind: "exec" | "plugin";
    allowedDecisions?: readonly string[];
}): string;
