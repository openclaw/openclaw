import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ResolveDirectStatusReplyForSessionParams = {
    cfg: OpenClawConfig;
    sessionKey: string;
    channel: string;
    senderId?: string;
    senderIsOwner: boolean;
    isAuthorizedSender: boolean;
    isGroup: boolean;
    defaultGroupActivation: () => "always" | "mention";
};
export declare function resolveDirectStatusReplyForSession(params: ResolveDirectStatusReplyForSessionParams): Promise<ReplyPayload | undefined>;
