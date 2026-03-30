import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { type ChannelId } from "./index.js";
import type { ChannelPairingAdapter } from "./types.js";
export declare function listPairingChannels(): ChannelId[];
export declare function getPairingAdapter(channelId: ChannelId): ChannelPairingAdapter | null;
export declare function requirePairingAdapter(channelId: ChannelId): ChannelPairingAdapter;
export declare function resolvePairingChannel(raw: unknown): ChannelId;
export declare function notifyPairingApproved(params: {
    channelId: ChannelId;
    id: string;
    cfg: OpenClawConfig;
    runtime?: RuntimeEnv;
    /** Extension channels can pass their adapter directly to bypass registry lookup. */
    pairingAdapter?: ChannelPairingAdapter;
}): Promise<void>;
