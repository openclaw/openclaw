import type { ChannelSetupWizard, ChannelSetupWizardAdapter } from "./setup-wizard-types.js";
import type { ChannelConfigSchema } from "./types.config.js";
export type { ChannelConfigRuntimeIssue, ChannelConfigRuntimeParseResult, ChannelConfigRuntimeSchema, ChannelConfigSchema, ChannelConfigUiHint, } from "./types.config.js";
import type { ChannelApprovalCapability, ChannelAuthAdapter, ChannelCommandAdapter, ChannelConfigAdapter, ChannelConversationBindingSupport, ChannelDoctorAdapter, ChannelDirectoryAdapter, ChannelResolverAdapter, ChannelElevatedAdapter, ChannelGatewayAdapter, ChannelGroupAdapter, ChannelHeartbeatAdapter, ChannelLifecycleAdapter, ChannelOutboundAdapter, ChannelPairingAdapter, ChannelSecretsAdapter, ChannelSecurityAdapter, ChannelSetupAdapter, ChannelStatusAdapter, ChannelAllowlistAdapter, ChannelConfiguredBindingProvider } from "./types.adapters.js";
import type { ChannelAgentTool, ChannelAgentToolFactory, ChannelCapabilities, ChannelId, ChannelAgentPromptAdapter, ChannelMentionAdapter, ChannelMessageActionAdapter, ChannelMessagingAdapter, ChannelMeta, ChannelStreamingAdapter, ChannelThreadingAdapter } from "./types.core.js";
/** Full capability contract for a native channel plugin. */
type ChannelPluginSetupWizard = ChannelSetupWizard | ChannelSetupWizardAdapter;
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
    setupWizard?: ChannelPluginSetupWizard;
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
    approvalCapability?: ChannelApprovalCapability;
    elevated?: ChannelElevatedAdapter;
    commands?: ChannelCommandAdapter;
    lifecycle?: ChannelLifecycleAdapter;
    secrets?: ChannelSecretsAdapter;
    allowlist?: ChannelAllowlistAdapter;
    doctor?: ChannelDoctorAdapter;
    bindings?: ChannelConfiguredBindingProvider;
    conversationBindings?: ChannelConversationBindingSupport;
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
