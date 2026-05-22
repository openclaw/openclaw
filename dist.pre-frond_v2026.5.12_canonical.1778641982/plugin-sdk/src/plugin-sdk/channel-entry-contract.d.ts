import type { ChannelConfigSchema } from "../channels/plugins/types.config.js";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginCommandDefinition, PluginCommandContext } from "../plugins/types.js";
export type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginCommandDefinition, PluginCommandContext, };
type ChannelEntryConfigSchema<TPlugin> = TPlugin extends ChannelPlugin<unknown> ? NonNullable<TPlugin["configSchema"]> : ChannelConfigSchema;
type BundledEntryModuleRef = {
    specifier: string;
    exportName?: string;
};
type DefineBundledChannelEntryOptions<TPlugin = ChannelPlugin> = {
    id: string;
    name: string;
    description: string;
    importMetaUrl: string;
    plugin: BundledEntryModuleRef;
    secrets?: BundledEntryModuleRef;
    configSchema?: ChannelEntryConfigSchema<TPlugin> | (() => ChannelEntryConfigSchema<TPlugin>);
    runtime?: BundledEntryModuleRef;
    accountInspect?: BundledEntryModuleRef;
    features?: BundledChannelEntryFeatures;
    registerCliMetadata?: (api: OpenClawPluginApi) => void;
    registerFull?: (api: OpenClawPluginApi) => void;
};
type DefineBundledChannelSetupEntryOptions = {
    importMetaUrl: string;
    plugin: BundledEntryModuleRef;
    secrets?: BundledEntryModuleRef;
    runtime?: BundledEntryModuleRef;
    legacyStateMigrations?: BundledEntryModuleRef;
    legacySessionSurface?: BundledEntryModuleRef;
    features?: BundledChannelSetupEntryFeatures;
};
export type BundledChannelSetupEntryFeatures = {
    legacyStateMigrations?: boolean;
    legacySessionSurfaces?: boolean;
};
export type BundledChannelEntryFeatures = {
    accountInspect?: boolean;
};
export type BundledChannelLegacySessionSurface = {
    isLegacyGroupSessionKey?: (key: string) => boolean;
    canonicalizeLegacySessionKey?: (params: {
        key: string;
        agentId: string;
    }) => string | null | undefined;
};
export type BundledChannelLegacyStateMigrationDetector = (params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    stateDir: string;
    oauthDir: string;
}) => ChannelLegacyStateMigrationPlan[] | Promise<ChannelLegacyStateMigrationPlan[] | null | undefined> | null | undefined;
export type BundledChannelEntryContract<TPlugin = ChannelPlugin> = {
    kind: "bundled-channel-entry";
    id: string;
    name: string;
    description: string;
    configSchema: ChannelEntryConfigSchema<TPlugin>;
    features?: BundledChannelEntryFeatures;
    register: (api: OpenClawPluginApi) => void;
    loadChannelPlugin: (options?: BundledEntryModuleLoadOptions) => TPlugin;
    loadChannelSecrets?: (options?: BundledEntryModuleLoadOptions) => ChannelPlugin["secrets"] | undefined;
    loadChannelAccountInspector?: (options?: BundledEntryModuleLoadOptions) => NonNullable<ChannelPlugin["config"]["inspectAccount"]>;
    setChannelRuntime?: (runtime: PluginRuntime) => void;
};
export type BundledChannelSetupEntryContract<TPlugin = ChannelPlugin> = {
    kind: "bundled-channel-setup-entry";
    loadSetupPlugin: (options?: BundledEntryModuleLoadOptions) => TPlugin;
    loadSetupSecrets?: (options?: BundledEntryModuleLoadOptions) => ChannelPlugin["secrets"] | undefined;
    loadLegacyStateMigrationDetector?: (options?: BundledEntryModuleLoadOptions) => BundledChannelLegacyStateMigrationDetector;
    loadLegacySessionSurface?: (options?: BundledEntryModuleLoadOptions) => BundledChannelLegacySessionSurface;
    setChannelRuntime?: (runtime: PluginRuntime) => void;
    features?: BundledChannelSetupEntryFeatures;
};
export type BundledEntryModuleLoadOptions = Record<string, never>;
export declare function loadBundledEntryExportSync<T>(importMetaUrl: string, reference: BundledEntryModuleRef, options?: BundledEntryModuleLoadOptions): T;
export declare function defineBundledChannelEntry<TPlugin = ChannelPlugin>({ id, name, description, importMetaUrl, plugin, secrets, configSchema, runtime, accountInspect, features, registerCliMetadata, registerFull }: DefineBundledChannelEntryOptions<TPlugin>): BundledChannelEntryContract<TPlugin>;
export declare function defineBundledChannelSetupEntry<TPlugin = ChannelPlugin>({ importMetaUrl, plugin, secrets, runtime, legacyStateMigrations, legacySessionSurface, features }: DefineBundledChannelSetupEntryOptions): BundledChannelSetupEntryContract<TPlugin>;
