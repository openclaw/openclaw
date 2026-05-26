import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { type OutboundTargetResolution } from "./targets-resolve-shared.js";
export declare function tryResolveLoadedOutboundTarget(params: {
    channel: GatewayMessageChannel;
    to?: string;
    allowFrom?: string[];
    cfg?: OpenClawConfig;
    accountId?: string | null;
    mode?: ChannelOutboundTargetMode;
}): OutboundTargetResolution | undefined;
