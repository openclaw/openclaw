import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelPlugin } from "./types.plugin.js";
export type ChannelCommandDefaults = Pick<NonNullable<ChannelPlugin["commands"]>, "nativeCommandsAutoEnabled" | "nativeSkillsAutoEnabled">;
export declare function isSafeManifestChannelId(channelId: string): boolean;
export declare function readOwnRecordValue(record: Record<string, unknown>, key: string): unknown;
export declare function normalizeChannelCommandDefaults(value: ChannelCommandDefaults | undefined): ChannelCommandDefaults | undefined;
export declare function resolveReadOnlyChannelCommandDefaults(channelId: string, options: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    workspaceDir?: string;
    config: OpenClawConfig;
}): ChannelCommandDefaults | undefined;
