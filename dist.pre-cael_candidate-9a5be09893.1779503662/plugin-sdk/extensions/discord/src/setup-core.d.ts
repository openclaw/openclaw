import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelSetupDmPolicy, ChannelSetupWizard } from "openclaw/plugin-sdk/setup-runtime";
export declare function parseDiscordAllowFromId(value: string): string | null;
export declare function createDiscordSetupWizardBase(handlers: {
    promptAllowFrom: NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>;
    resolveAllowFromEntries: NonNullable<NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]>;
    resolveGroupAllowlist: NonNullable<NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>>;
}): {
    channel: "discord";
    status: import("../../../dist/plugin-sdk/src/channels/plugins/setup-wizard-types.js").ChannelSetupWizardStatus;
    credentials: {
        inputKey: "token";
        providerHint: "discord";
        credentialLabel: string;
        preferredEnvVar: string;
        helpTitle: string;
        helpLines: string[];
        envPrompt: string;
        keepPrompt: string;
        inputPrompt: string;
        allowEnv: ({ accountId }: {
            accountId: string;
        }) => boolean;
        inspect: ({ cfg, accountId }: {
            cfg: OpenClawConfig;
            accountId: string;
        }) => {
            accountConfigured: boolean;
            hasConfiguredValue: boolean;
            resolvedValue: string | undefined;
            envValue: string | undefined;
        };
    }[];
    groupAccess: import("../../../dist/plugin-sdk/src/channels/plugins/setup-wizard-types.js").ChannelSetupWizardGroupAccess;
    allowFrom: import("../../../dist/plugin-sdk/src/channels/plugins/setup-wizard-types.js").ChannelSetupWizardAllowFrom;
    dmPolicy: ChannelSetupDmPolicy;
    disable: (cfg: OpenClawConfig) => OpenClawConfig;
};
