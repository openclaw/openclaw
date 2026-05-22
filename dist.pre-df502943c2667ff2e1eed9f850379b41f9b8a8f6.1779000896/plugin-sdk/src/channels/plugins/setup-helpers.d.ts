import { type ZodType } from "zod";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";
import type { ChannelSetupInput } from "./types.core.js";
export declare function applyAccountNameToChannelSection(params: {
    cfg: OpenClawConfig;
    channelKey: string;
    accountId: string;
    name?: string;
    alwaysUseAccounts?: boolean;
}): OpenClawConfig;
export declare function migrateBaseNameToDefaultAccount(params: {
    cfg: OpenClawConfig;
    channelKey: string;
    alwaysUseAccounts?: boolean;
}): OpenClawConfig;
export declare function prepareScopedSetupConfig(params: {
    cfg: OpenClawConfig;
    channelKey: string;
    accountId: string;
    name?: string;
    alwaysUseAccounts?: boolean;
    migrateBaseName?: boolean;
}): OpenClawConfig;
export declare function applySetupAccountConfigPatch(params: {
    cfg: OpenClawConfig;
    channelKey: string;
    accountId: string;
    patch: Record<string, unknown>;
}): OpenClawConfig;
export declare function createPatchedAccountSetupAdapter(params: {
    channelKey: string;
    alwaysUseAccounts?: boolean;
    ensureChannelEnabled?: boolean;
    ensureAccountEnabled?: boolean;
    validateInput?: ChannelSetupAdapter["validateInput"];
    buildPatch: (input: ChannelSetupInput) => Record<string, unknown>;
}): ChannelSetupAdapter;
export declare function createZodSetupInputValidator<T extends ChannelSetupInput>(params: {
    schema: ZodType<T>;
    validate?: (params: {
        cfg: OpenClawConfig;
        accountId: string;
        input: T;
    }) => string | null;
}): NonNullable<ChannelSetupAdapter["validateInput"]>;
type SetupInputPresenceRequirement = {
    someOf: string[];
    message: string;
};
export declare function createSetupInputPresenceValidator(params: {
    defaultAccountOnlyEnvError?: string;
    whenNotUseEnv?: SetupInputPresenceRequirement[];
    validate?: (params: {
        cfg: OpenClawConfig;
        accountId: string;
        input: ChannelSetupInput;
    }) => string | null;
}): NonNullable<ChannelSetupAdapter["validateInput"]>;
export declare function createEnvPatchedAccountSetupAdapter(params: {
    channelKey: string;
    alwaysUseAccounts?: boolean;
    ensureChannelEnabled?: boolean;
    ensureAccountEnabled?: boolean;
    defaultAccountOnlyEnvError: string;
    missingCredentialError: string;
    hasCredentials: (input: ChannelSetupInput) => boolean;
    validateInput?: ChannelSetupAdapter["validateInput"];
    buildPatch: (input: ChannelSetupInput) => Record<string, unknown>;
}): ChannelSetupAdapter;
export declare function patchScopedAccountConfig(params: {
    cfg: OpenClawConfig;
    channelKey: string;
    accountId: string;
    patch: Record<string, unknown>;
    accountPatch?: Record<string, unknown>;
    ensureChannelEnabled?: boolean;
    ensureAccountEnabled?: boolean;
    scopeDefaultToAccounts?: boolean;
}): OpenClawConfig;
export declare function moveSingleAccountChannelSectionToDefaultAccount(params: {
    cfg: OpenClawConfig;
    channelKey: string;
}): OpenClawConfig;
export {};
