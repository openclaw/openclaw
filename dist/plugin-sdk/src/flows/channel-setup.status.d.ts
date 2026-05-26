import { listChannelPluginCatalogEntries } from "../channels/plugins/catalog.js";
import type { ChannelSetupPlugin } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupWizardAdapter, ChannelSetupStatus, SetupChannelsOptions } from "../commands/channel-setup/types.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type BundledPluginSource } from "../plugins/bundled-sources.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { FlowContribution } from "./types.js";
type ChannelStatusSummary = {
    installedPlugins: ChannelSetupPlugin[];
    catalogEntries: ReturnType<typeof listChannelPluginCatalogEntries>;
    installedCatalogEntries: ReturnType<typeof listChannelPluginCatalogEntries>;
    statusByChannel: Map<ChannelChoice, ChannelSetupStatus>;
    statusLines: string[];
};
type ChannelSetupSelectionContribution = FlowContribution & {
    kind: "channel";
    surface: "setup";
    channel: ChannelChoice;
    source: "catalog" | "core" | "plugin";
};
type ChannelSetupSelectionEntry = {
    id: ChannelChoice;
    meta: {
        id: string;
        label: string;
        selectionLabel?: string;
        exposure?: {
            setup?: boolean;
        };
        showConfigured?: boolean;
        showInSetup?: boolean;
    };
};
/**
 * Hint shown next to an installable channel option in the selection menu when
 * we don't yet have a runtime-collected status. Mirrors the "configured" /
 * "installed" affordance other channels get so users can see "download from
 * <npm-spec>" before committing to install.
 *
 * Bundled channels (the plugin lives under `extensions/<id>` in the host
 * repo, e.g. Signal / Tlon / Twitch / Slack) are NOT downloaded from npm —
 * they ship with the host. Even when their `package.json` declares an
 * `npmSpec` (or the catalog falls back to the package name), surfacing
 * "download from <npm-spec>" misleads users into believing the plugin is
 * missing. For bundled channels we suppress the npm hint entirely so the
 * menu shows the same neutral "plugin · install" affordance used when no
 * npm source is known.
 */
export declare function resolveCatalogChannelSelectionHint(entry: {
    install?: {
        npmSpec?: string;
    };
}, options?: {
    bundledLocalPath?: string | null;
}): string;
/**
 * Look up the bundled-source entry for a catalog channel, regardless of
 * whether the catalog refers to it by `pluginId` or `npmSpec`. We use this
 * to detect bundled channels in the selection menu so we can suppress the
 * misleading "download from <npm-spec>" hint for plugins that already ship
 * with the host (Signal / Tlon / Twitch / Slack ...).
 */
export declare function findBundledSourceForCatalogChannel(params: {
    bundled: ReadonlyMap<string, BundledPluginSource>;
    entry: {
        id: string;
        pluginId?: string;
        install?: {
            npmSpec?: string;
        };
    };
}): BundledPluginSource | undefined;
export declare function collectChannelStatus(params: {
    cfg: OpenClawConfig;
    options?: SetupChannelsOptions;
    accountOverrides: Partial<Record<ChannelChoice, string>>;
    installedPlugins?: ChannelSetupPlugin[];
    resolveAdapter?: (channel: ChannelChoice) => ChannelSetupWizardAdapter | undefined;
}): Promise<ChannelStatusSummary>;
export declare function noteChannelStatus(params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    options?: SetupChannelsOptions;
    accountOverrides?: Partial<Record<ChannelChoice, string>>;
    installedPlugins?: ChannelSetupPlugin[];
    resolveAdapter?: (channel: ChannelChoice) => ChannelSetupWizardAdapter | undefined;
}): Promise<void>;
export declare function noteChannelPrimer(prompter: WizardPrompter, channels: Array<{
    id: ChannelChoice;
    blurb: string;
    label: string;
}>): Promise<void>;
export declare function resolveQuickstartDefault(statusByChannel: Map<ChannelChoice, {
    quickstartScore?: number;
}>): ChannelChoice | undefined;
export declare function resolveChannelSelectionNoteLines(params: {
    cfg: OpenClawConfig;
    installedPlugins: ChannelSetupPlugin[];
    selection: ChannelChoice[];
}): string[];
export declare function resolveChannelSetupSelectionContributions(params: {
    entries: ChannelSetupSelectionEntry[];
    statusByChannel: Map<ChannelChoice, {
        selectionHint?: string;
    }>;
    resolveDisabledHint: (channel: ChannelChoice) => string | undefined;
}): ChannelSetupSelectionContribution[];
export {};
