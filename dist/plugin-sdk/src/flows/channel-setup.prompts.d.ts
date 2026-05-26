import type { ChannelSetupPlugin } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupWizardAdapter } from "../commands/channel-setup/types.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";
type ConfiguredChannelAction = "update" | "disable" | "delete" | "skip";
export declare function formatAccountLabel(accountId: string): string;
export declare function promptConfiguredAction(params: {
    prompter: WizardPrompter;
    label: string;
    supportsDisable: boolean;
    supportsDelete: boolean;
}): Promise<ConfiguredChannelAction>;
export declare function promptRemovalAccountId(params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    label: string;
    channel: ChannelChoice;
    plugin?: ChannelSetupPlugin;
}): Promise<string>;
export declare function maybeConfigureDmPolicies(params: {
    cfg: OpenClawConfig;
    selection: ChannelChoice[];
    prompter: WizardPrompter;
    accountIdsByChannel?: Map<ChannelChoice, string>;
    resolveAdapter?: (channel: ChannelChoice) => ChannelSetupWizardAdapter | undefined;
}): Promise<OpenClawConfig>;
export {};
