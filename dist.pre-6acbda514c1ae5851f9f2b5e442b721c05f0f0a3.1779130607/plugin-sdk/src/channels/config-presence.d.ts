import type { OpenClawConfig } from "../config/types.openclaw.js";
type ChannelPresenceOptions = {
    channelIds?: readonly string[];
    includePersistedAuthState?: boolean;
    persistedAuthStateProbe?: {
        listChannelIds: () => readonly string[];
        hasState: (params: {
            channelId: string;
            cfg: OpenClawConfig;
            env: NodeJS.ProcessEnv;
        }) => boolean;
    };
};
export type ChannelPresenceSignalSource = "config" | "env" | "persisted-auth";
type ChannelPresenceSignal = {
    channelId: string;
    source: ChannelPresenceSignalSource;
};
export declare function hasMeaningfulChannelConfig(value: unknown): boolean;
export declare function listExplicitlyDisabledChannelIdsForConfig(cfg: OpenClawConfig): string[];
export declare function listPotentialConfiguredChannelIds(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv, options?: ChannelPresenceOptions): string[];
export declare function listPotentialConfiguredChannelPresenceSignals(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv, options?: ChannelPresenceOptions): ChannelPresenceSignal[];
export declare function hasPotentialConfiguredChannels(cfg: OpenClawConfig | null | undefined, env?: NodeJS.ProcessEnv, options?: ChannelPresenceOptions): boolean;
export {};
