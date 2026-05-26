import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MsgContext } from "./templating.js";
export type CommandAuthorization = {
    providerId?: ChannelId;
    ownerList: string[];
    senderId?: string;
    senderIsOwner: boolean;
    isAuthorizedSender: boolean;
    from?: string;
    to?: string;
};
export declare function resolveCommandAuthorization(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
    commandAuthorized: boolean;
}): CommandAuthorization;
