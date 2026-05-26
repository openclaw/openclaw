import type { ChannelSetupWizard } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
type OptionalChannelSetupParams = {
    channel: string;
    label: string;
    npmSpec?: string;
    docsPath?: string;
};
export declare function createOptionalChannelSetupAdapter(params: OptionalChannelSetupParams): ChannelSetupAdapter;
export declare function createOptionalChannelSetupWizard(params: OptionalChannelSetupParams): ChannelSetupWizard;
export {};
