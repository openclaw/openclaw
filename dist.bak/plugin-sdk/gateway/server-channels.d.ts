import { type ChannelId } from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";
export type ChannelRuntimeSnapshot = {
    channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
    channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};
type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;
type ChannelManagerOptions = {
    loadConfig: () => OpenClawConfig;
    channelLogs: Record<ChannelId, SubsystemLogger>;
    channelRuntimeEnvs: Record<ChannelId, RuntimeEnv>;
};
export type ChannelManager = {
    getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
    startChannels: () => Promise<void>;
    startChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
    stopChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
    markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
    isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
    resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
};
export declare function createChannelManager(opts: ChannelManagerOptions): ChannelManager;
export {};
