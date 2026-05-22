import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type ConfiguredBindingRouteResult, type RuntimeConversationBindingRouteResult } from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { resolveSlackReplyToMode } from "../../account-reply-mode.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";
export type SlackRoutingContextDeps = {
    cfg: OpenClawConfig;
    teamId: string;
    threadInheritParent: boolean;
    threadHistoryScope: "thread" | "channel";
};
type SlackRoutingContext = {
    route: ReturnType<typeof resolveAgentRoute>;
    runtimeBinding: RuntimeConversationBindingRouteResult["bindingRecord"];
    runtimeBoundSessionKey: string | undefined;
    configuredBinding: ConfiguredBindingRouteResult["bindingResolution"];
    configuredBindingSessionKey: string;
    chatType: "direct" | "group" | "channel";
    replyToMode: ReturnType<typeof resolveSlackReplyToMode>;
    threadContext: ReturnType<typeof resolveSlackThreadContext>;
    threadTs: string | undefined;
    isThreadReply: boolean;
    threadKeys: ReturnType<typeof resolveThreadSessionKeys>;
    sessionKey: string;
    historyKey: string;
};
declare function normalizeSlackRouteBindingConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function resolveSlackRoutingContext(params: {
    ctx: SlackRoutingContextDeps;
    account: ResolvedSlackAccount;
    message: SlackMessageEvent;
    isDirectMessage: boolean;
    isGroupDm: boolean;
    isRoom: boolean;
    isRoomish: boolean;
    seedTopLevelRoomThread?: boolean;
    assistantThreadTs?: string;
}): SlackRoutingContext;
export declare const testing: {
    normalizeSlackRouteBindingConfig: typeof normalizeSlackRouteBindingConfig;
};
export { testing as __testing };
