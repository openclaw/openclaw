import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelId } from "./plugins/types.public.js";
export type ReadOnlyInspectedAccount = Record<string, unknown>;
export declare function inspectReadOnlyChannelAccount(params: {
    channelId: ChannelId;
    cfg: OpenClawConfig;
    accountId?: string | null;
}): Promise<ReadOnlyInspectedAccount | null>;
