import { authorizeConfigWrite } from "../../channels/plugins/config-writes.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function resolveConfigWriteDeniedText(params: {
    cfg: OpenClawConfig;
    channel?: string | null;
    channelId: ChannelId | null;
    accountId?: string;
    gatewayClientScopes?: string[];
    target: Parameters<typeof authorizeConfigWrite>[0]["target"];
}): string | null;
