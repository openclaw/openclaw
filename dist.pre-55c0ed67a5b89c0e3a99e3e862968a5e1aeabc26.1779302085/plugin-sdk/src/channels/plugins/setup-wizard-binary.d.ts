import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelSetupWizard, ChannelSetupWizardStatus, ChannelSetupWizardTextInput } from "./setup-wizard.js";
type SetupTextInputParams = Parameters<NonNullable<ChannelSetupWizardTextInput["currentValue"]>>[0];
export declare function createDetectedBinaryStatus(params: {
    channelLabel: string;
    binaryLabel: string;
    configuredLabel: string;
    unconfiguredLabel: string;
    configuredHint: string;
    unconfiguredHint: string;
    configuredScore: number;
    unconfiguredScore: number;
    resolveConfigured: (params: {
        cfg: OpenClawConfig;
        accountId?: string;
    }) => boolean | Promise<boolean>;
    resolveBinaryPath: (params: {
        cfg: OpenClawConfig;
        accountId?: string;
    }) => string;
    detectBinary?: (path: string) => Promise<boolean>;
}): ChannelSetupWizardStatus;
export declare function createCliPathTextInput(params: {
    inputKey: ChannelSetupWizardTextInput["inputKey"];
    message: string;
    resolvePath: (params: SetupTextInputParams) => string | undefined;
    shouldPrompt: NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>;
    helpTitle?: string;
    helpLines?: string[];
}): ChannelSetupWizardTextInput;
export declare function createDelegatedSetupWizardStatusResolvers(loadWizard: () => Promise<ChannelSetupWizard>): Pick<ChannelSetupWizardStatus, "resolveStatusLines" | "resolveSelectionHint" | "resolveQuickstartScore">;
export declare function createDelegatedTextInputShouldPrompt(params: {
    loadWizard: () => Promise<ChannelSetupWizard>;
    inputKey: ChannelSetupWizardTextInput["inputKey"];
}): NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>;
export {};
