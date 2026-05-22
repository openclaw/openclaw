import type { OpenClawConfig, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordAutoThreadContext, DiscordAutoThreadReplyPlan, MaybeCreateDiscordAutoThreadParams } from "./threading.types.js";
export declare function resolveDiscordAutoThreadContext(params: {
    agentId: string;
    channel: string;
    messageChannelId: string;
    createdThreadId?: string | null;
    parentInheritanceEnabled?: boolean;
}): DiscordAutoThreadContext | null;
export declare function resolveDiscordAutoThreadReplyPlan(params: MaybeCreateDiscordAutoThreadParams & {
    replyToMode: ReplyToMode;
    agentId: string;
    channel: string;
    cfg: OpenClawConfig;
    threadParentInheritanceEnabled?: boolean;
}): Promise<DiscordAutoThreadReplyPlan>;
export declare function maybeCreateDiscordAutoThread(params: MaybeCreateDiscordAutoThreadParams): Promise<string | undefined>;
