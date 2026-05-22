import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { DiscordExecApprovalConfig } from "openclaw/plugin-sdk/config-contracts";
export { shouldHandleDiscordApprovalRequest } from "./approval-shared.js";
export declare function extractDiscordChannelId(sessionKey?: string | null): string | null;
export declare function createDiscordNativeApprovalAdapter(configOverride?: DiscordExecApprovalConfig | null): {
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
export declare function getDiscordApprovalCapability(): ChannelApprovalCapability;
