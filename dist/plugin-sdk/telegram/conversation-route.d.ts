import { resolveConfiguredAcpRoute } from "../acp/persistent-bindings.route.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
export declare function resolveTelegramConversationRoute(params: {
    cfg: OpenClawConfig;
    accountId: string;
    chatId: number | string;
    isGroup: boolean;
    resolvedThreadId?: number;
    replyThreadId?: number;
    senderId?: string | number | null;
    topicAgentId?: string | null;
}): {
    route: ReturnType<typeof resolveAgentRoute>;
    configuredBinding: ReturnType<typeof resolveConfiguredAcpRoute>["configuredBinding"];
    configuredBindingSessionKey: string;
};
