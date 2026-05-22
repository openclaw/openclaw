import type { ChannelGatewayContext } from "./runtime-api.js";
import type { ResolvedQaChannelAccount } from "./types.js";
export declare function startQaGatewayAccount(channelId: string, channelLabel: string, ctx: ChannelGatewayContext<ResolvedQaChannelAccount>): Promise<void>;
