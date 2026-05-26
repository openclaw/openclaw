import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelSetupDmPolicy } from "./setup-wizard-types.js";
import type { ChannelSetupWizard } from "./setup-wizard.js";
type PromptAllowFromParams = Parameters<NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>>[0];
type ResolveConfiguredParams = Parameters<ChannelSetupWizard["status"]["resolveConfigured"]>[0];
type ResolveAllowFromEntriesParams = Parameters<NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]>[0];
type ResolveAllowFromEntriesResult = Awaited<ReturnType<NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]>>;
type ResolveGroupAllowlistParams = Parameters<NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>>[0];
export declare function createDelegatedResolveConfigured(loadWizard: () => Promise<ChannelSetupWizard>): ({ cfg, accountId }: ResolveConfiguredParams) => Promise<boolean>;
export declare function createDelegatedPrepare(loadWizard: () => Promise<ChannelSetupWizard>): (params: Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0]) => Promise<void | {
    cfg?: OpenClawConfig;
    credentialValues?: import("./setup-wizard-types.js").ChannelSetupWizardCredentialValues;
} | {
    cfg?: OpenClawConfig;
    credentialValues?: import("./setup-wizard-types.js").ChannelSetupWizardCredentialValues;
} | undefined>;
export declare function createDelegatedFinalize(loadWizard: () => Promise<ChannelSetupWizard>): (params: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]) => Promise<void | {
    cfg?: OpenClawConfig;
    credentialValues?: import("./setup-wizard-types.js").ChannelSetupWizardCredentialValues;
} | {
    cfg?: OpenClawConfig;
    credentialValues?: import("./setup-wizard-types.js").ChannelSetupWizardCredentialValues;
} | undefined>;
type DelegatedStatusBase = Omit<ChannelSetupWizard["status"], "resolveConfigured" | "resolveStatusLines" | "resolveSelectionHint" | "resolveQuickstartScore">;
export declare function createDelegatedSetupWizardProxy(params: {
    channel: string;
    loadWizard: () => Promise<ChannelSetupWizard>;
    status: DelegatedStatusBase;
    credentials?: ChannelSetupWizard["credentials"];
    textInputs?: ChannelSetupWizard["textInputs"];
    completionNote?: ChannelSetupWizard["completionNote"];
    dmPolicy?: ChannelSetupWizard["dmPolicy"];
    disable?: ChannelSetupWizard["disable"];
    resolveShouldPromptAccountIds?: ChannelSetupWizard["resolveShouldPromptAccountIds"];
    onAccountRecorded?: ChannelSetupWizard["onAccountRecorded"];
    delegatePrepare?: boolean;
    delegateFinalize?: boolean;
}): ChannelSetupWizard;
export declare function createAllowlistSetupWizardProxy<TGroupResolved>(params: {
    loadWizard: () => Promise<ChannelSetupWizard>;
    createBase: (handlers: {
        promptAllowFrom: (params: PromptAllowFromParams) => Promise<OpenClawConfig>;
        resolveAllowFromEntries: (params: ResolveAllowFromEntriesParams) => Promise<ResolveAllowFromEntriesResult>;
        resolveGroupAllowlist: (params: ResolveGroupAllowlistParams) => Promise<TGroupResolved>;
    }) => ChannelSetupWizard;
    fallbackResolvedGroupAllowlist: (entries: string[]) => TGroupResolved;
}): ChannelSetupWizard;
export {};
