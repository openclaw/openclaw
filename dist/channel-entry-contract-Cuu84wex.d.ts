import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { n as ChannelConfigSchema } from "./types.config-U9f3z9SA.js";
import { n as ChannelOutboundAdapter } from "./outbound.types-COmT4EQP.js";
import { g as ChannelLegacyStateMigrationPlan } from "./types.core-1gFCH89g.js";
import { v as OpenClawPluginApi } from "./types-lCXG2pW_.js";
import { n as ChannelPlugin } from "./types.public-BfuQlAVf.js";
import { n as PluginRuntime } from "./types-DtDIgr2k.js";
import { t as PluginModuleLoaderFactory } from "./plugin-module-loader-cache-DTlAin7j.js";

//#region src/plugin-sdk/channel-entry-contract.d.ts
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
  outbound?: BundledEntryModuleRef;
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
type BundledChannelSetupEntryFeatures = {
  legacyStateMigrations?: boolean;
  legacySessionSurfaces?: boolean;
};
type BundledChannelEntryFeatures = {
  accountInspect?: boolean;
};
type BundledChannelLegacySessionSurface = {
  isLegacyGroupSessionKey?: (key: string) => boolean;
  canonicalizeLegacySessionKey?: (params: {
    key: string;
    agentId: string;
  }) => string | null | undefined;
};
type BundledChannelLegacyStateMigrationDetector = (params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
}) => ChannelLegacyStateMigrationPlan[] | Promise<ChannelLegacyStateMigrationPlan[] | null | undefined> | null | undefined;
type BundledChannelEntryContract<TPlugin = ChannelPlugin> = {
  kind: "bundled-channel-entry";
  id: string;
  name: string;
  description: string;
  configSchema: ChannelEntryConfigSchema<TPlugin>;
  features?: BundledChannelEntryFeatures;
  register: (api: OpenClawPluginApi) => void;
  loadChannelPlugin: (options?: BundledEntryModuleLoadOptions) => TPlugin;
  loadChannelOutbound?: (options?: BundledEntryModuleLoadOptions) => ChannelOutboundAdapter | undefined;
  loadChannelSecrets?: (options?: BundledEntryModuleLoadOptions) => ChannelPlugin["secrets"] | undefined;
  loadChannelAccountInspector?: (options?: BundledEntryModuleLoadOptions) => NonNullable<ChannelPlugin["config"]["inspectAccount"]>;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};
type BundledChannelSetupEntryContract<TPlugin = ChannelPlugin> = {
  kind: "bundled-channel-setup-entry";
  loadSetupPlugin: (options?: BundledEntryModuleLoadOptions) => TPlugin;
  loadSetupSecrets?: (options?: BundledEntryModuleLoadOptions) => ChannelPlugin["secrets"] | undefined;
  loadLegacyStateMigrationDetector?: (options?: BundledEntryModuleLoadOptions) => BundledChannelLegacyStateMigrationDetector;
  loadLegacySessionSurface?: (options?: BundledEntryModuleLoadOptions) => BundledChannelLegacySessionSurface;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
  features?: BundledChannelSetupEntryFeatures;
};
type BundledEntryModuleLoadOptions = {
  createLoaderForTest?: PluginModuleLoaderFactory;
};
declare function loadBundledEntryExportSync<T>(importMetaUrl: string, reference: BundledEntryModuleRef, options?: BundledEntryModuleLoadOptions): T;
declare function defineBundledChannelEntry<TPlugin = ChannelPlugin>({
  id,
  name,
  description,
  importMetaUrl,
  plugin,
  outbound,
  secrets,
  configSchema,
  runtime,
  accountInspect,
  features,
  registerCliMetadata,
  registerFull
}: DefineBundledChannelEntryOptions<TPlugin>): BundledChannelEntryContract<TPlugin>;
declare function defineBundledChannelSetupEntry<TPlugin = ChannelPlugin>({
  importMetaUrl,
  plugin,
  secrets,
  runtime,
  legacyStateMigrations,
  legacySessionSurface,
  features
}: DefineBundledChannelSetupEntryOptions): BundledChannelSetupEntryContract<TPlugin>;
//#endregion
export { BundledChannelSetupEntryContract as a, defineBundledChannelEntry as c, BundledChannelLegacyStateMigrationDetector as i, defineBundledChannelSetupEntry as l, BundledChannelEntryFeatures as n, BundledChannelSetupEntryFeatures as o, BundledChannelLegacySessionSurface as r, BundledEntryModuleLoadOptions as s, BundledChannelEntryContract as t, loadBundledEntryExportSync as u };