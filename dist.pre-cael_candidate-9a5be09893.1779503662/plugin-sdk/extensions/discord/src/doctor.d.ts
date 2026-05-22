import { type ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
type DiscordNumericIdHit = {
    path: string;
    entry: number;
    safe: boolean;
};
export declare function scanDiscordNumericIdEntries(cfg: OpenClawConfig): DiscordNumericIdHit[];
export declare function collectDiscordNumericIdWarnings(params: {
    hits: DiscordNumericIdHit[];
    doctorFixCommand: string;
}): string[];
export declare function maybeRepairDiscordNumericIds(cfg: OpenClawConfig, doctorFixCommand: string): {
    config: OpenClawConfig;
    changes: string[];
    warnings?: string[];
};
export declare function collectDiscordMissingEnvTokenWarnings(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): string[];
export declare const discordDoctor: ChannelDoctorAdapter;
export {};
