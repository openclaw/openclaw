import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SlackChannelConfig } from "openclaw/plugin-sdk/config-contracts";
type SlackChannels = Record<string, SlackChannelConfig>;
type MigrationScope = "account" | "global";
type SlackChannelMigrationResult = {
    migrated: boolean;
    skippedExisting: boolean;
    scopes: MigrationScope[];
};
export declare function migrateSlackChannelsInPlace(channels: SlackChannels | undefined, oldChannelId: string, newChannelId: string): {
    migrated: boolean;
    skippedExisting: boolean;
};
export declare function migrateSlackChannelConfig(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    oldChannelId: string;
    newChannelId: string;
}): SlackChannelMigrationResult;
export {};
