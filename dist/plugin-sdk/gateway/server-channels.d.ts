import { type ChannelId } from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
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
    /**
     * Optional channel runtime helpers for external channel plugins.
     *
     * When provided, this value is passed to all channel plugins via the
     * `channelRuntime` field in `ChannelGatewayContext`, enabling external
     * plugins to access advanced Plugin SDK features (AI dispatch, routing,
     * text processing, etc.).
     *
     * Built-in channels (slack, discord, telegram) typically don't use this
     * because they can directly import internal modules from the monorepo.
     *
     * This field is optional - omitting it maintains backward compatibility
     * with existing channels.
     *
     * @example
     * ```typescript
     * import { createPluginRuntime } from "../plugins/runtime/index.js";
     *
     * const channelManager = createChannelManager({
     *   loadConfig,
     *   channelLogs,
     *   channelRuntimeEnvs,
     *   channelRuntime: createPluginRuntime().channel,
     * });
     * ```
     *
     * @since Plugin SDK 2026.2.19
     * @see {@link ChannelGatewayContext.channelRuntime}
     */
    channelRuntime?: PluginRuntime["channel"];
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
