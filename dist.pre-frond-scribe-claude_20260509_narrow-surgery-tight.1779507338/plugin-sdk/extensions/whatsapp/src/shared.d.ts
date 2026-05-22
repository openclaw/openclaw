import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { type ChannelSetupWizard } from "openclaw/plugin-sdk/setup-runtime";
import { type ResolvedWhatsAppAccount } from "./accounts.js";
import { resolveLegacyGroupSessionKey } from "./group-session-contract.js";
import { collectUnsupportedSecretRefConfigCandidates } from "./security-contract.js";
import { deriveLegacySessionChatType, isLegacyGroupSessionKey } from "./session-contract.js";
export declare function loadWhatsAppChannelRuntime(): Promise<typeof import("./channel.runtime.js")>;
export declare const whatsappSetupWizardProxy: ChannelSetupWizard;
export declare function createWhatsAppPluginBase(params: {
    groups: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["groups"]>;
    setupWizard: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setupWizard"]>;
    setup: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setup"]>;
    isConfigured: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["config"]>["isConfigured"];
}): {
    id: import("openclaw/plugin-sdk").ChannelId;
    meta: import("openclaw/plugin-sdk/core").ChannelMeta;
    setup?: import("openclaw/plugin-sdk/setup-runtime").ChannelSetupAdapter;
    gatewayMethods?: string[];
    commands?: import("openclaw/plugin-sdk/channel-runtime").ChannelCommandAdapter;
    doctor?: import("openclaw/plugin-sdk/channel-contract").ChannelDoctorAdapter;
    streaming?: import("openclaw/plugin-sdk/channel-runtime").ChannelStreamingAdapter;
    agentPrompt?: import("openclaw/plugin-sdk/channel-runtime").ChannelAgentPromptAdapter;
    setupWizard: ChannelSetupWizard | import("openclaw/plugin-sdk/setup").ChannelSetupWizardAdapter;
    capabilities: import("openclaw/plugin-sdk").ChannelCapabilities;
    reload: {
        configPrefixes: string[];
        noopPrefixes?: string[];
    };
    gatewayMethodDescriptors: import("../../../dist/plugin-sdk/src/channels/plugins/types.plugin.js").ChannelGatewayMethodDescriptor[];
    configSchema: import("openclaw/plugin-sdk").ChannelConfigSchema;
    config: import("openclaw/plugin-sdk/channel-runtime").ChannelConfigAdapter<ResolvedWhatsAppAccount>;
    messaging: {
        defaultMarkdownTableMode: "bullets";
        deriveLegacySessionChatType: typeof deriveLegacySessionChatType;
        resolveLegacyGroupSessionKey: typeof resolveLegacyGroupSessionKey;
        isLegacyGroupSessionKey: typeof isLegacyGroupSessionKey;
        canonicalizeLegacySessionKey: (params: {
            key: string;
            agentId: string;
        }) => string | null;
    };
    secrets: {
        unsupportedSecretRefSurfacePatterns: readonly ["channels.whatsapp.creds.json", "channels.whatsapp.accounts.*.creds.json"];
        collectUnsupportedSecretRefConfigCandidates: typeof collectUnsupportedSecretRefConfigCandidates;
    };
    security: import("openclaw/plugin-sdk/channel-runtime").ChannelSecurityAdapter<ResolvedWhatsAppAccount>;
    groups: import("openclaw/plugin-sdk/channel-runtime").ChannelGroupAdapter;
};
