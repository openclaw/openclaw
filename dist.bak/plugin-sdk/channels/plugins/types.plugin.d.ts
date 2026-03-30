import type { ChannelOnboardingAdapter } from "./onboarding-types.js";
import type { ChannelAuthAdapter, ChannelCommandAdapter, ChannelConfigAdapter, ChannelDirectoryAdapter, ChannelResolverAdapter, ChannelElevatedAdapter, ChannelGatewayAdapter, ChannelGroupAdapter, ChannelHeartbeatAdapter, ChannelOutboundAdapter, ChannelPairingAdapter, ChannelSecurityAdapter, ChannelSetupAdapter, ChannelStatusAdapter } from "./types.adapters.js";
import type { ChannelAgentTool, ChannelAgentToolFactory, ChannelCapabilities, ChannelId, ChannelAgentPromptAdapter, ChannelMentionAdapter, ChannelMessageActionAdapter, ChannelMessagingAdapter, ChannelMeta, ChannelStreamingAdapter, ChannelThreadingAdapter } from "./types.core.js";
export type ChannelConfigUiHint = {
    label?: string;
    help?: string;
    tags?: string[];
    advanced?: boolean;
    sensitive?: boolean;
    placeholder?: string;
    itemTemplate?: unknown;
};
export type ChannelConfigSchema = {
    schema: Record<string, unknown>;
    uiHints?: Record<string, ChannelConfigUiHint>;
};
export type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
    id: ChannelId;
    meta: ChannelMeta;
    capabilities: ChannelCapabilities;
    defaults?: {
        queue?: {
            debounceMs?: number;
        };
    };
    reload?: {
        configPrefixes: string[];
        noopPrefixes?: string[];
    };
    onboarding?: ChannelOnboardingAdapter;
    config: ChannelConfigAdapter<ResolvedAccount>;
    configSchema?: ChannelConfigSchema;
    setup?: ChannelSetupAdapter;
    pairing?: ChannelPairingAdapter;
    security?: ChannelSecurityAdapter<ResolvedAccount>;
    groups?: ChannelGroupAdapter;
    mentions?: ChannelMentionAdapter;
    outbound?: ChannelOutboundAdapter;
    status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
    gatewayMethods?: string[];
    gateway?: ChannelGatewayAdapter<ResolvedAccount>;
    auth?: ChannelAuthAdapter;
    elevated?: ChannelElevatedAdapter;
    commands?: ChannelCommandAdapter;
    streaming?: ChannelStreamingAdapter;
    threading?: ChannelThreadingAdapter;
    messaging?: ChannelMessagingAdapter;
    agentPrompt?: ChannelAgentPromptAdapter;
    directory?: ChannelDirectoryAdapter;
    resolver?: ChannelResolverAdapter;
    actions?: ChannelMessageActionAdapter;
    heartbeat?: ChannelHeartbeatAdapter;
    agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];
};
