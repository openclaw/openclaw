import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { mt as ZodType } from "./schemas-CkRCGSfd.js";
import { P as ChannelSetupInput } from "./types.core-BkmTlRzr.js";
import { H as ChannelSetupAdapter } from "./types.adapters-y0dBEomF.js";

//#region src/channels/plugins/setup-helpers.d.ts
declare function applyAccountNameToChannelSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig;
declare function migrateBaseNameToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig;
declare function prepareScopedSetupConfig(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
  migrateBaseName?: boolean;
}): OpenClawConfig;
declare function applySetupAccountConfigPatch(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig;
declare function createPatchedAccountSetupAdapter(params: {
  channelKey: string;
  alwaysUseAccounts?: boolean;
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  validateInput?: ChannelSetupAdapter["validateInput"];
  buildPatch: (input: ChannelSetupInput) => Record<string, unknown>;
}): ChannelSetupAdapter;
declare function createZodSetupInputValidator<T extends ChannelSetupInput>(params: {
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
declare function createSetupInputPresenceValidator(params: {
  defaultAccountOnlyEnvError?: string;
  whenNotUseEnv?: SetupInputPresenceRequirement[];
  validate?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: ChannelSetupInput;
  }) => string | null;
}): NonNullable<ChannelSetupAdapter["validateInput"]>;
declare function createEnvPatchedAccountSetupAdapter(params: {
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
declare function patchScopedAccountConfig(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  patch: Record<string, unknown>;
  accountPatch?: Record<string, unknown>;
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  scopeDefaultToAccounts?: boolean;
}): OpenClawConfig;
declare function moveSingleAccountChannelSectionToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
}): OpenClawConfig;
//#endregion
export { createSetupInputPresenceValidator as a, moveSingleAccountChannelSectionToDefaultAccount as c, createPatchedAccountSetupAdapter as i, patchScopedAccountConfig as l, applySetupAccountConfigPatch as n, createZodSetupInputValidator as o, createEnvPatchedAccountSetupAdapter as r, migrateBaseNameToDefaultAccount as s, applyAccountNameToChannelSection as t, prepareScopedSetupConfig as u };