import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginConfigUiHint } from "../plugins/types.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import type { WizardPrompter } from "./prompts.js";
/**
 * A discovered plugin that has configurable fields via uiHints.
 */
export type ConfigurablePlugin = {
    id: string;
    name: string;
    /** uiHints from the plugin manifest, keyed by config field name. */
    uiHints: Record<string, PluginConfigUiHint>;
    /** JSON schema from the plugin manifest (used for type/enum info). */
    jsonSchema?: JsonSchemaObject;
};
/**
 * Discover plugins that have non-advanced uiHints fields.
 * Returns only plugins that have at least one promptable field.
 */
export declare function discoverConfigurablePlugins(params: {
    manifestPlugins: ReadonlyArray<{
        id: string;
        name?: string;
        configUiHints?: Record<string, PluginConfigUiHint>;
        configSchema?: Record<string, unknown>;
        enabled?: boolean;
    }>;
}): ConfigurablePlugin[];
/**
 * Discover plugins with unconfigured non-advanced fields (for onboard flow).
 * Returns only plugins where at least one promptable field has no value yet.
 */
export declare function discoverUnconfiguredPlugins(params: {
    manifestPlugins: ReadonlyArray<{
        id: string;
        name?: string;
        configUiHints?: Record<string, PluginConfigUiHint>;
        configSchema?: Record<string, unknown>;
        enabled?: boolean;
    }>;
    config: OpenClawConfig;
}): ConfigurablePlugin[];
/**
 * Run the plugin configuration step for the onboard wizard.
 * Shows unconfigured plugin fields and prompts the user.
 */
export declare function setupPluginConfig(params: {
    config: OpenClawConfig;
    prompter: WizardPrompter;
    workspaceDir?: string;
}): Promise<OpenClawConfig>;
/**
 * Run the plugin configuration step for the configure wizard.
 * Shows all configurable plugins and all their non-advanced fields.
 */
export declare function configurePluginConfig(params: {
    config: OpenClawConfig;
    prompter: WizardPrompter;
    workspaceDir?: string;
}): Promise<OpenClawConfig>;
