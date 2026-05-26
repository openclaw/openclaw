import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import type { ChannelApprovalCapability } from "./channel-contract.js";
import type { OpenClawConfig } from "./config-runtime.js";
type ApprovalKind = "exec" | "plugin";
type NativeApprovalDeliveryMode = "dm" | "channel" | "both";
type NativeApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type NativeApprovalTarget = {
    to: string;
    threadId?: string | number | null;
};
type ChannelApprovalCapabilitySurfaces = Pick<ChannelApprovalCapability, "delivery" | "nativeRuntime" | "render" | "native">;
type ApprovalAdapterParams = {
    cfg: OpenClawConfig;
    accountId?: string | null;
    senderId?: string | null;
};
type DeliverySuppressionParams = {
    cfg: OpenClawConfig;
    approvalKind: ApprovalKind;
    target: {
        channel: string;
        accountId?: string | null;
    };
    request: {
        request: {
            turnSourceChannel?: string | null;
            turnSourceAccountId?: string | null;
        };
    };
};
type ApproverRestrictedNativeApprovalParams = {
    channel: string;
    channelLabel: string;
    listAccountIds: (cfg: OpenClawConfig) => string[];
    hasApprovers: (params: ApprovalAdapterParams) => boolean;
    isExecAuthorizedSender: (params: ApprovalAdapterParams) => boolean;
    isPluginAuthorizedSender?: (params: ApprovalAdapterParams) => boolean;
    isNativeDeliveryEnabled: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => boolean;
    resolveNativeDeliveryMode: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => NativeApprovalDeliveryMode;
    requireMatchingTurnSourceChannel?: boolean;
    resolveSuppressionAccountId?: (params: DeliverySuppressionParams) => string | undefined;
    resolveOriginTarget?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        approvalKind: ApprovalKind;
        request: NativeApprovalRequest;
    }) => NativeApprovalTarget | null | Promise<NativeApprovalTarget | null>;
    resolveApproverDmTargets?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        approvalKind: ApprovalKind;
        request: NativeApprovalRequest;
    }) => NativeApprovalTarget[] | Promise<NativeApprovalTarget[]>;
    notifyOriginWhenDmOnly?: boolean;
    nativeRuntime?: ChannelApprovalCapability["nativeRuntime"];
    describeExecApprovalSetup?: ChannelApprovalCapability["describeExecApprovalSetup"];
};
export declare function createApproverRestrictedNativeApprovalAdapter(params: ApproverRestrictedNativeApprovalParams): {
    auth: {
        authorizeActorAction?: ChannelApprovalCapability["authorizeActorAction"];
        getActionAvailabilityState?: ChannelApprovalCapability["getActionAvailabilityState"];
        getExecInitiatingSurfaceState?: ChannelApprovalCapability["getExecInitiatingSurfaceState"];
        resolveApproveCommandBehavior?: ChannelApprovalCapability["resolveApproveCommandBehavior"];
    };
    delivery: ChannelApprovalCapability["delivery"];
    nativeRuntime: ChannelApprovalCapability["nativeRuntime"];
    render: ChannelApprovalCapability["render"];
    native: ChannelApprovalCapability["native"];
    describeExecApprovalSetup: ChannelApprovalCapability["describeExecApprovalSetup"];
};
export declare function createChannelApprovalCapability(params: {
    authorizeActorAction?: ChannelApprovalCapability["authorizeActorAction"];
    getActionAvailabilityState?: ChannelApprovalCapability["getActionAvailabilityState"];
    getExecInitiatingSurfaceState?: ChannelApprovalCapability["getExecInitiatingSurfaceState"];
    resolveApproveCommandBehavior?: ChannelApprovalCapability["resolveApproveCommandBehavior"];
    describeExecApprovalSetup?: ChannelApprovalCapability["describeExecApprovalSetup"];
    delivery?: ChannelApprovalCapability["delivery"];
    nativeRuntime?: ChannelApprovalCapability["nativeRuntime"];
    render?: ChannelApprovalCapability["render"];
    native?: ChannelApprovalCapability["native"];
    /** @deprecated Pass delivery/nativeRuntime/render/native directly. */
    approvals?: Partial<ChannelApprovalCapabilitySurfaces>;
}): ChannelApprovalCapability;
export declare function splitChannelApprovalCapability(capability: ChannelApprovalCapability): {
    auth: {
        authorizeActorAction?: ChannelApprovalCapability["authorizeActorAction"];
        getActionAvailabilityState?: ChannelApprovalCapability["getActionAvailabilityState"];
        getExecInitiatingSurfaceState?: ChannelApprovalCapability["getExecInitiatingSurfaceState"];
        resolveApproveCommandBehavior?: ChannelApprovalCapability["resolveApproveCommandBehavior"];
    };
    delivery: ChannelApprovalCapability["delivery"];
    nativeRuntime: ChannelApprovalCapability["nativeRuntime"];
    render: ChannelApprovalCapability["render"];
    native: ChannelApprovalCapability["native"];
    describeExecApprovalSetup: ChannelApprovalCapability["describeExecApprovalSetup"];
};
export declare function createApproverRestrictedNativeApprovalCapability(params: ApproverRestrictedNativeApprovalParams): ChannelApprovalCapability;
export {};
