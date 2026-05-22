import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
export declare const slackApprovalCapability: ChannelApprovalCapability;
export declare const slackNativeApprovalAdapter: {
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
