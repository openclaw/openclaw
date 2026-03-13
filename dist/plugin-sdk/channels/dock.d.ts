import type { ChannelCapabilities, ChannelCommandAdapter, ChannelConfigAdapter, ChannelElevatedAdapter, ChannelGroupAdapter, ChannelId, ChannelAgentPromptAdapter, ChannelMentionAdapter, ChannelThreadingAdapter } from "./plugins/types.js";
export type ChannelDock = {
    id: ChannelId;
    capabilities: ChannelCapabilities;
    commands?: ChannelCommandAdapter;
    outbound?: {
        textChunkLimit?: number;
    };
    streaming?: ChannelDockStreaming;
    elevated?: ChannelElevatedAdapter;
    config?: Pick<ChannelConfigAdapter<unknown>, "resolveAllowFrom" | "formatAllowFrom" | "resolveDefaultTo">;
    groups?: ChannelGroupAdapter;
    mentions?: ChannelMentionAdapter;
    threading?: ChannelThreadingAdapter;
    agentPrompt?: ChannelAgentPromptAdapter;
};
type ChannelDockStreaming = {
    blockStreamingCoalesceDefaults?: {
        minChars?: number;
        idleMs?: number;
    };
};
export declare function listChannelDocks(): ChannelDock[];
export declare function getChannelDock(id: ChannelId): ChannelDock | undefined;
export {};
