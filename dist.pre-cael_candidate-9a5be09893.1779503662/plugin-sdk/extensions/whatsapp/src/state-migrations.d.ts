import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
export declare function detectWhatsAppLegacyStateMigrations(params: {
    oauthDir: string;
}): ChannelLegacyStateMigrationPlan[];
