import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { l as SecretInput } from "./types.secrets-tbFW-hY6.js";
import { _ as GroupPolicy, h as DmPolicy } from "./types.base-DS--yneR.js";
import { i as WizardPrompter } from "./prompts-DgKIGa-v.js";
import { c as ChannelSetupWizardAdapter, d as ChannelSetupWizardStatus, f as ChannelSetupWizardTextInput, l as ChannelSetupWizardAllowFromEntry, n as ChannelSetupDmPolicy, p as PromptAccountId, r as ChannelSetupPlugin, s as ChannelSetupWizard, u as ChannelSetupWizardCredentialValues } from "./setup-wizard-types-BKBpG8mO.js";

//#region src/wizard/i18n/types.d.ts
type WizardLocale = "en" | "zh-CN" | "zh-TW";
type WizardI18nParams = Record<string, boolean | number | string | null | undefined>;
//#endregion
//#region src/wizard/i18n/index.d.ts
type SetupTranslator = (key: string, params?: WizardI18nParams) => string;
declare function createSetupTranslator(options?: {
  locale?: WizardLocale;
  keyPrefix?: string;
}): SetupTranslator;
//#endregion
//#region src/channels/plugins/setup-wizard-helpers.d.ts
declare const promptAccountId: PromptAccountId;
declare function addWildcardAllowFrom(allowFrom?: ReadonlyArray<string | number> | null): string[];
declare function mergeAllowFromEntries(current: Array<string | number> | null | undefined, additions: Array<string | number>): string[];
declare function splitSetupEntries(raw: string): string[];
type ParsedSetupEntry = {
  value: string;
} | {
  error: string;
};
declare function parseSetupEntriesWithParser(raw: string, parseEntry: (entry: string) => ParsedSetupEntry): {
  entries: string[];
  error?: string;
};
declare function parseSetupEntriesAllowingWildcard(raw: string, parseEntry: (entry: string) => ParsedSetupEntry): {
  entries: string[];
  error?: string;
};
declare function parseMentionOrPrefixedId(params: {
  value: string;
  mentionPattern: RegExp;
  prefixPattern?: RegExp;
  idPattern: RegExp;
  normalizeId?: (id: string) => string;
}): string | null;
declare function normalizeAllowFromEntries(entries: Array<string | number>, normalizeEntry?: (value: string) => string | null | undefined): string[];
declare function createStandardChannelSetupStatus(params: {
  channelLabel: string;
  configuredLabel: string;
  unconfiguredLabel: string;
  configuredHint?: string;
  unconfiguredHint?: string;
  configuredScore?: number;
  unconfiguredScore?: number;
  includeStatusLine?: boolean;
  resolveConfigured: ChannelSetupWizardStatus["resolveConfigured"];
  resolveExtraStatusLines?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
    configured: boolean;
  }) => string[] | Promise<string[]>;
}): ChannelSetupWizardStatus;
declare function resolveSetupAccountId(params: {
  accountId?: string;
  defaultAccountId: string;
}): string;
declare function setAccountAllowFromForChannel(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  allowFrom: string[];
}): OpenClawConfig;
declare function patchTopLevelChannelConfigSection(params: {
  cfg: OpenClawConfig;
  channel: string;
  enabled?: boolean;
  clearFields?: string[];
  patch: Record<string, unknown>;
}): OpenClawConfig;
declare function patchNestedChannelConfigSection(params: {
  cfg: OpenClawConfig;
  channel: string;
  section: string;
  enabled?: boolean;
  clearFields?: string[];
  patch: Record<string, unknown>;
}): OpenClawConfig;
declare function setTopLevelChannelAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: string;
  allowFrom: string[];
  enabled?: boolean;
}): OpenClawConfig;
declare function setNestedChannelAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: string;
  section: string;
  allowFrom: string[];
  enabled?: boolean;
}): OpenClawConfig;
declare function setTopLevelChannelDmPolicyWithAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: string;
  dmPolicy: DmPolicy;
  getAllowFrom?: (cfg: OpenClawConfig) => Array<string | number> | undefined;
}): OpenClawConfig;
declare function setNestedChannelDmPolicyWithAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: string;
  section: string;
  dmPolicy: DmPolicy;
  getAllowFrom?: (cfg: OpenClawConfig) => Array<string | number> | undefined;
  enabled?: boolean;
}): OpenClawConfig;
declare function setTopLevelChannelGroupPolicy(params: {
  cfg: OpenClawConfig;
  channel: string;
  groupPolicy: GroupPolicy;
  enabled?: boolean;
}): OpenClawConfig;
declare function createTopLevelChannelDmPolicy(params: {
  label: string;
  channel: string;
  policyKey: string;
  allowFromKey: string;
  getCurrent: (cfg: OpenClawConfig) => DmPolicy;
  promptAllowFrom?: ChannelSetupDmPolicy["promptAllowFrom"];
  getAllowFrom?: (cfg: OpenClawConfig) => Array<string | number> | undefined;
}): ChannelSetupDmPolicy;
declare function createNestedChannelDmPolicy(params: {
  label: string;
  channel: string;
  section: string;
  policyKey: string;
  allowFromKey: string;
  getCurrent: (cfg: OpenClawConfig) => DmPolicy;
  promptAllowFrom?: ChannelSetupDmPolicy["promptAllowFrom"];
  getAllowFrom?: (cfg: OpenClawConfig) => Array<string | number> | undefined;
  enabled?: boolean;
}): ChannelSetupDmPolicy;
declare function createTopLevelChannelDmPolicySetter(params: {
  channel: string;
  getAllowFrom?: (cfg: OpenClawConfig) => Array<string | number> | undefined;
}): (cfg: OpenClawConfig, dmPolicy: DmPolicy) => OpenClawConfig;
declare function createNestedChannelDmPolicySetter(params: {
  channel: string;
  section: string;
  getAllowFrom?: (cfg: OpenClawConfig) => Array<string | number> | undefined;
  enabled?: boolean;
}): (cfg: OpenClawConfig, dmPolicy: DmPolicy) => OpenClawConfig;
declare function createTopLevelChannelAllowFromSetter(params: {
  channel: string;
  enabled?: boolean;
}): (cfg: OpenClawConfig, allowFrom: string[]) => OpenClawConfig;
declare function createNestedChannelAllowFromSetter(params: {
  channel: string;
  section: string;
  enabled?: boolean;
}): (cfg: OpenClawConfig, allowFrom: string[]) => OpenClawConfig;
declare function createTopLevelChannelGroupPolicySetter(params: {
  channel: string;
  enabled?: boolean;
}): (cfg: OpenClawConfig, groupPolicy: "open" | "allowlist" | "disabled") => OpenClawConfig;
declare function setChannelDmPolicyWithAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: string;
  dmPolicy: DmPolicy;
}): OpenClawConfig;
declare function setCompatChannelDmPolicyWithAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: string;
  dmPolicy: DmPolicy;
}): OpenClawConfig;
declare function setAccountGroupPolicyForChannel(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  groupPolicy: GroupPolicy;
}): OpenClawConfig;
declare function setAccountDmAllowFromForChannel(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  allowFrom: string[];
}): OpenClawConfig;
declare function createCompatChannelDmPolicy(params: {
  label: string;
  channel: string;
  promptAllowFrom?: ChannelSetupDmPolicy["promptAllowFrom"];
}): ChannelSetupDmPolicy;
declare function resolveGroupAllowlistWithLookupNotes<TResolved>(params: {
  label: string;
  prompter: Pick<WizardPrompter, "note">;
  entries: string[];
  fallback: TResolved;
  resolve: () => Promise<TResolved>;
}): Promise<TResolved>;
declare function createAccountScopedAllowFromSection(params: {
  channel: string;
  credentialInputKey?: NonNullable<ChannelSetupWizard["allowFrom"]>["credentialInputKey"];
  helpTitle?: string;
  helpLines?: string[];
  message: string;
  placeholder: string;
  invalidWithoutCredentialNote: string;
  parseId: NonNullable<NonNullable<ChannelSetupWizard["allowFrom"]>["parseId"]>;
  resolveEntries: NonNullable<NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]>;
}): NonNullable<ChannelSetupWizard["allowFrom"]>;
declare function createAccountScopedGroupAccessSection<TResolved>(params: {
  channel: string;
  label: string;
  placeholder: string;
  helpTitle?: string;
  helpLines?: string[];
  skipAllowlistEntries?: boolean;
  currentPolicy: NonNullable<ChannelSetupWizard["groupAccess"]>["currentPolicy"];
  currentEntries: NonNullable<ChannelSetupWizard["groupAccess"]>["currentEntries"];
  updatePrompt: NonNullable<ChannelSetupWizard["groupAccess"]>["updatePrompt"];
  resolveAllowlist?: NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>;
  fallbackResolved: (entries: string[]) => TResolved;
  applyAllowlist: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    resolved: TResolved;
  }) => OpenClawConfig;
}): NonNullable<ChannelSetupWizard["groupAccess"]>;
type AccountScopedChannel = string;
type CompatDmChannel = string;
declare function setSetupChannelEnabled(cfg: OpenClawConfig, channel: string, enabled: boolean): OpenClawConfig;
declare function patchChannelConfigForAccount(params: {
  cfg: OpenClawConfig;
  channel: AccountScopedChannel;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig;
declare function buildSingleChannelSecretPromptState(params: {
  accountConfigured: boolean;
  hasConfigToken: boolean;
  allowEnv: boolean;
  envValue?: string;
}): {
  accountConfigured: boolean;
  hasConfigToken: boolean;
  canUseEnv: boolean;
};
type SingleChannelSecretInputPromptResult = {
  action: "keep";
} | {
  action: "use-env";
} | {
  action: "set";
  value: SecretInput;
  resolvedValue: string;
};
declare function runSingleChannelSecretStep(params: {
  cfg: OpenClawConfig;
  prompter: Pick<WizardPrompter, "confirm" | "text" | "select" | "note">;
  providerHint: string;
  credentialLabel: string;
  secretInputMode?: "plaintext" | "ref";
  accountConfigured: boolean;
  hasConfigToken: boolean;
  allowEnv: boolean;
  envValue?: string;
  envPrompt: string;
  keepPrompt: string;
  inputPrompt: string;
  preferredEnvVar?: string;
  onMissingConfigured?: () => Promise<void>;
  applyUseEnv?: (cfg: OpenClawConfig) => OpenClawConfig | Promise<OpenClawConfig>;
  applySet?: (cfg: OpenClawConfig, value: SecretInput, resolvedValue: string) => OpenClawConfig | Promise<OpenClawConfig>;
}): Promise<{
  cfg: OpenClawConfig;
  action: SingleChannelSecretInputPromptResult["action"];
  resolvedValue?: string;
}>;
declare function promptSingleChannelSecretInput(params: {
  cfg: OpenClawConfig;
  prompter: Pick<WizardPrompter, "confirm" | "text" | "select" | "note">;
  providerHint: string;
  credentialLabel: string;
  secretInputMode?: "plaintext" | "ref";
  accountConfigured: boolean;
  canUseEnv: boolean;
  hasConfigToken: boolean;
  envPrompt: string;
  keepPrompt: string;
  inputPrompt: string;
  preferredEnvVar?: string;
}): Promise<SingleChannelSecretInputPromptResult>;
type ParsedAllowFromResult = {
  entries: string[];
  error?: string;
};
declare function promptParsedAllowFromForAccount<TConfig extends OpenClawConfig>(params: {
  cfg: TConfig;
  accountId?: string;
  defaultAccountId: string;
  prompter: Pick<WizardPrompter, "note" | "text">;
  noteTitle?: string;
  noteLines?: string[];
  message: string;
  placeholder: string;
  parseEntries: (raw: string) => ParsedAllowFromResult;
  getExistingAllowFrom: (params: {
    cfg: TConfig;
    accountId: string;
  }) => Array<string | number>;
  mergeEntries?: (params: {
    existing: Array<string | number>;
    parsed: string[];
  }) => string[];
  applyAllowFrom: (params: {
    cfg: TConfig;
    accountId: string;
    allowFrom: string[];
  }) => TConfig | Promise<TConfig>;
}): Promise<TConfig>;
declare function createPromptParsedAllowFromForAccount<TConfig extends OpenClawConfig>(params: {
  defaultAccountId: string | ((cfg: TConfig) => string);
  noteTitle?: string;
  noteLines?: string[];
  message: string;
  placeholder: string;
  parseEntries: (raw: string) => ParsedAllowFromResult;
  getExistingAllowFrom: (params: {
    cfg: TConfig;
    accountId: string;
  }) => Array<string | number>;
  mergeEntries?: (params: {
    existing: Array<string | number>;
    parsed: string[];
  }) => string[];
  applyAllowFrom: (params: {
    cfg: TConfig;
    accountId: string;
    allowFrom: string[];
  }) => TConfig | Promise<TConfig>;
}): NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>;
declare function promptParsedAllowFromForScopedChannel(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  defaultAccountId: string;
  prompter: Pick<WizardPrompter, "note" | "text">;
  noteTitle: string;
  noteLines: string[];
  message: string;
  placeholder: string;
  parseEntries: (raw: string) => ParsedAllowFromResult;
  getExistingAllowFrom: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => Array<string | number>;
}): Promise<OpenClawConfig>;
declare function createTopLevelChannelParsedAllowFromPrompt(params: {
  channel: string;
  defaultAccountId: string | ((cfg: OpenClawConfig) => string);
  enabled?: boolean;
  noteTitle?: string;
  noteLines?: string[];
  message: string;
  placeholder: string;
  parseEntries: (raw: string) => ParsedAllowFromResult;
  getExistingAllowFrom?: (cfg: OpenClawConfig) => Array<string | number>;
  mergeEntries?: (params: {
    existing: Array<string | number>;
    parsed: string[];
  }) => string[];
}): NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>;
declare function createNestedChannelParsedAllowFromPrompt(params: {
  channel: string;
  section: string;
  defaultAccountId: string | ((cfg: OpenClawConfig) => string);
  enabled?: boolean;
  noteTitle?: string;
  noteLines?: string[];
  message: string;
  placeholder: string;
  parseEntries: (raw: string) => ParsedAllowFromResult;
  getExistingAllowFrom?: (cfg: OpenClawConfig) => Array<string | number>;
  mergeEntries?: (params: {
    existing: Array<string | number>;
    parsed: string[];
  }) => string[];
}): NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>;
declare function resolveParsedAllowFromEntries(params: {
  entries: string[];
  parseId: (raw: string) => string | null;
}): ChannelSetupWizardAllowFromEntry[];
declare function createAllowFromSection(params: {
  helpTitle?: string;
  helpLines?: string[];
  credentialInputKey?: NonNullable<ChannelSetupWizard["allowFrom"]>["credentialInputKey"];
  message: string;
  placeholder: string;
  invalidWithoutCredentialNote: string;
  parseInputs?: NonNullable<NonNullable<ChannelSetupWizard["allowFrom"]>["parseInputs"]>;
  parseId: NonNullable<NonNullable<ChannelSetupWizard["allowFrom"]>["parseId"]>;
  resolveEntries?: NonNullable<NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]>;
  apply: NonNullable<NonNullable<ChannelSetupWizard["allowFrom"]>["apply"]>;
}): NonNullable<ChannelSetupWizard["allowFrom"]>;
declare function noteChannelLookupSummary(params: {
  prompter: Pick<WizardPrompter, "note">;
  label: string;
  resolvedSections: Array<{
    title: string;
    values: string[];
  }>;
  unresolved?: string[];
}): Promise<void>;
declare function noteChannelLookupFailure(params: {
  prompter: Pick<WizardPrompter, "note">;
  label: string;
  error: unknown;
}): Promise<void>;
type AllowFromResolution = {
  input: string;
  resolved: boolean;
  id?: string | null;
};
declare function resolveEntriesWithOptionalToken<TResult>(params: {
  token?: string | null;
  entries: string[];
  buildWithoutToken: (input: string) => TResult;
  resolveEntries: (params: {
    token: string;
    entries: string[];
  }) => Promise<TResult[]>;
}): Promise<TResult[]>;
declare function promptResolvedAllowFrom(params: {
  prompter: WizardPrompter;
  existing: Array<string | number>;
  token?: string | null;
  message: string;
  placeholder: string;
  label: string;
  parseInputs: (value: string) => string[];
  parseId: (value: string) => string | null;
  invalidWithoutTokenNote: string;
  resolveEntries: (params: {
    token: string;
    entries: string[];
  }) => Promise<AllowFromResolution[]>;
}): Promise<string[]>;
declare function promptLegacyChannelAllowFrom(params: {
  cfg: OpenClawConfig;
  channel: CompatDmChannel;
  prompter: WizardPrompter;
  existing: Array<string | number>;
  token?: string | null;
  noteTitle: string;
  noteLines: string[];
  message: string;
  placeholder: string;
  parseId: (value: string) => string | null;
  invalidWithoutTokenNote: string;
  resolveEntries: (params: {
    token: string;
    entries: string[];
  }) => Promise<AllowFromResolution[]>;
}): Promise<OpenClawConfig>;
declare function promptLegacyChannelAllowFromForAccount<TAccount>(params: {
  cfg: OpenClawConfig;
  channel: CompatDmChannel;
  prompter: WizardPrompter;
  accountId?: string;
  defaultAccountId: string;
  resolveAccount: (cfg: OpenClawConfig, accountId: string) => TAccount;
  resolveExisting: (account: TAccount, cfg: OpenClawConfig) => Array<string | number>;
  resolveToken: (account: TAccount) => string | null | undefined;
  noteTitle: string;
  noteLines: string[];
  message: string;
  placeholder: string;
  parseId: (value: string) => string | null;
  invalidWithoutTokenNote: string;
  resolveEntries: (params: {
    token: string;
    entries: string[];
  }) => Promise<AllowFromResolution[]>;
}): Promise<OpenClawConfig>;
declare const setLegacyChannelDmPolicyWithAllowFrom: typeof setCompatChannelDmPolicyWithAllowFrom;
declare const createLegacyCompatChannelDmPolicy: typeof createCompatChannelDmPolicy;
//#endregion
//#region src/channels/plugins/setup-wizard.d.ts
type ChannelSetupWizardPlugin = ChannelSetupPlugin;
declare function buildChannelSetupWizardAdapterFromSetupWizard(params: {
  plugin: ChannelSetupWizardPlugin;
  wizard: ChannelSetupWizard;
}): ChannelSetupWizardAdapter;
//#endregion
//#region src/channels/plugins/setup-wizard-proxy.d.ts
type PromptAllowFromParams = Parameters<NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>>[0];
type ResolveConfiguredParams = Parameters<ChannelSetupWizard["status"]["resolveConfigured"]>[0];
type ResolveAllowFromEntriesParams = Parameters<NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]>[0];
type ResolveAllowFromEntriesResult = Awaited<ReturnType<NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]>>;
type ResolveGroupAllowlistParams = Parameters<NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>>[0];
declare function createDelegatedResolveConfigured(loadWizard: () => Promise<ChannelSetupWizard>): ({
  cfg,
  accountId
}: ResolveConfiguredParams) => Promise<boolean>;
declare function createDelegatedPrepare(loadWizard: () => Promise<ChannelSetupWizard>): (params: Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0]) => Promise<void | {
  cfg?: OpenClawConfig;
  credentialValues?: ChannelSetupWizardCredentialValues;
} | {
  cfg?: OpenClawConfig;
  credentialValues?: ChannelSetupWizardCredentialValues;
} | undefined>;
declare function createDelegatedFinalize(loadWizard: () => Promise<ChannelSetupWizard>): (params: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]) => Promise<void | {
  cfg?: OpenClawConfig;
  credentialValues?: ChannelSetupWizardCredentialValues;
} | {
  cfg?: OpenClawConfig;
  credentialValues?: ChannelSetupWizardCredentialValues;
} | undefined>;
type DelegatedStatusBase = Omit<ChannelSetupWizard["status"], "resolveConfigured" | "resolveStatusLines" | "resolveSelectionHint" | "resolveQuickstartScore">;
declare function createDelegatedSetupWizardProxy(params: {
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
declare function createAllowlistSetupWizardProxy<TGroupResolved>(params: {
  loadWizard: () => Promise<ChannelSetupWizard>;
  createBase: (handlers: {
    promptAllowFrom: (params: PromptAllowFromParams) => Promise<OpenClawConfig>;
    resolveAllowFromEntries: (params: ResolveAllowFromEntriesParams) => Promise<ResolveAllowFromEntriesResult>;
    resolveGroupAllowlist: (params: ResolveGroupAllowlistParams) => Promise<TGroupResolved>;
  }) => ChannelSetupWizard;
  fallbackResolvedGroupAllowlist: (entries: string[]) => TGroupResolved;
}): ChannelSetupWizard;
//#endregion
//#region src/channels/plugins/setup-wizard-binary.d.ts
type SetupTextInputParams = Parameters<NonNullable<ChannelSetupWizardTextInput["currentValue"]>>[0];
declare function createDetectedBinaryStatus(params: {
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
declare function createCliPathTextInput(params: {
  inputKey: ChannelSetupWizardTextInput["inputKey"];
  message: string;
  resolvePath: (params: SetupTextInputParams) => string | undefined;
  shouldPrompt: NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>;
  helpTitle?: string;
  helpLines?: string[];
}): ChannelSetupWizardTextInput;
declare function createDelegatedSetupWizardStatusResolvers(loadWizard: () => Promise<ChannelSetupWizard>): Pick<ChannelSetupWizardStatus, "resolveStatusLines" | "resolveSelectionHint" | "resolveQuickstartScore">;
declare function createDelegatedTextInputShouldPrompt(params: {
  loadWizard: () => Promise<ChannelSetupWizard>;
  inputKey: ChannelSetupWizardTextInput["inputKey"];
}): NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>;
//#endregion
export { setChannelDmPolicyWithAllowFrom as $, noteChannelLookupFailure as A, promptLegacyChannelAllowFromForAccount as B, createTopLevelChannelAllowFromSetter as C, createTopLevelChannelParsedAllowFromPrompt as D, createTopLevelChannelGroupPolicySetter as E, patchChannelConfigForAccount as F, resolveEntriesWithOptionalToken as G, promptParsedAllowFromForScopedChannel as H, patchNestedChannelConfigSection as I, resolveSetupAccountId as J, resolveGroupAllowlistWithLookupNotes as K, patchTopLevelChannelConfigSection as L, parseMentionOrPrefixedId as M, parseSetupEntriesAllowingWildcard as N, mergeAllowFromEntries as O, parseSetupEntriesWithParser as P, setAccountGroupPolicyForChannel as Q, promptAccountId as R, createStandardChannelSetupStatus as S, createTopLevelChannelDmPolicySetter as T, promptResolvedAllowFrom as U, promptParsedAllowFromForAccount as V, promptSingleChannelSecretInput as W, setAccountAllowFromForChannel as X, runSingleChannelSecretStep as Y, setAccountDmAllowFromForChannel as Z, createNestedChannelAllowFromSetter as _, createAllowlistSetupWizardProxy as a, setTopLevelChannelDmPolicyWithAllowFrom as at, createNestedChannelParsedAllowFromPrompt as b, createDelegatedResolveConfigured as c, SetupTranslator as ct, addWildcardAllowFrom as d, setLegacyChannelDmPolicyWithAllowFrom as et, buildSingleChannelSecretPromptState as f, createLegacyCompatChannelDmPolicy as g, createAllowFromSection as h, createDetectedBinaryStatus as i, setTopLevelChannelAllowFrom as it, noteChannelLookupSummary as j, normalizeAllowFromEntries as k, createDelegatedSetupWizardProxy as l, createSetupTranslator as lt, createAccountScopedGroupAccessSection as m, createDelegatedSetupWizardStatusResolvers as n, setNestedChannelDmPolicyWithAllowFrom as nt, createDelegatedFinalize as o, setTopLevelChannelGroupPolicy as ot, createAccountScopedAllowFromSection as p, resolveParsedAllowFromEntries as q, createDelegatedTextInputShouldPrompt as r, setSetupChannelEnabled as rt, createDelegatedPrepare as s, splitSetupEntries as st, createCliPathTextInput as t, setNestedChannelAllowFrom as tt, buildChannelSetupWizardAdapterFromSetupWizard as u, WizardI18nParams as ut, createNestedChannelDmPolicy as v, createTopLevelChannelDmPolicy as w, createPromptParsedAllowFromForAccount as x, createNestedChannelDmPolicySetter as y, promptLegacyChannelAllowFrom as z };