import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelSetupWizardAdapter } from "./types.js";
export declare function resolveChannelSetupWizardAdapterForPlugin(plugin?: ChannelPlugin): ChannelSetupWizardAdapter | undefined;
export declare function getChannelSetupWizardAdapter(channel: ChannelChoice): ChannelSetupWizardAdapter | undefined;
