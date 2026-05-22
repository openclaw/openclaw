import type { PluginHookAgentContext } from "./hook-types.js";
export declare function resolveAgentHookChannelId(params: {
    sessionKey?: string | null;
    messageChannel?: string | null;
    messageProvider?: string | null;
    currentChannelId?: string | null;
    messageTo?: string | null;
}): string | undefined;
export declare function buildAgentHookContextChannelFields(params: {
    sessionKey?: string | null;
    messageChannel?: string | null;
    messageProvider?: string | null;
    currentChannelId?: string | null;
    messageTo?: string | null;
}): Pick<PluginHookAgentContext, "channelId" | "messageProvider">;
