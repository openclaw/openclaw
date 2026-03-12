import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy, GroupPolicy } from "../../../config/types.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { PromptAccountId } from "../onboarding-types.js";
export declare const promptAccountId: PromptAccountId;
export declare function addWildcardAllowFrom(allowFrom?: Array<string | number> | null): string[];
export declare function mergeAllowFromEntries(current: Array<string | number> | null | undefined, additions: Array<string | number>): string[];
export declare function splitOnboardingEntries(raw: string): string[];
type ParsedOnboardingEntry = {
    value: string;
} | {
    error: string;
};
export declare function parseOnboardingEntriesWithParser(raw: string, parseEntry: (entry: string) => ParsedOnboardingEntry): {
    entries: string[];
    error?: string;
};
export declare function parseOnboardingEntriesAllowingWildcard(raw: string, parseEntry: (entry: string) => ParsedOnboardingEntry): {
    entries: string[];
    error?: string;
};
export declare function parseMentionOrPrefixedId(params: {
    value: string;
    mentionPattern: RegExp;
    prefixPattern?: RegExp;
    idPattern: RegExp;
    normalizeId?: (id: string) => string;
}): string | null;
export declare function normalizeAllowFromEntries(entries: Array<string | number>, normalizeEntry?: (value: string) => string | null | undefined): string[];
export declare function resolveOnboardingAccountId(params: {
    accountId?: string;
    defaultAccountId: string;
}): string;
export declare function resolveAccountIdForConfigure(params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    label: string;
    accountOverride?: string;
    shouldPromptAccountIds: boolean;
    listAccountIds: (cfg: OpenClawConfig) => string[];
    defaultAccountId: string;
}): Promise<string>;
export declare function setAccountAllowFromForChannel(params: {
    cfg: OpenClawConfig;
    channel: "imessage" | "signal";
    accountId: string;
    allowFrom: string[];
}): OpenClawConfig;
export declare function setChannelDmPolicyWithAllowFrom(params: {
    cfg: OpenClawConfig;
    channel: "imessage" | "signal" | "telegram";
    dmPolicy: DmPolicy;
}): OpenClawConfig;
export declare function setLegacyChannelDmPolicyWithAllowFrom(params: {
    cfg: OpenClawConfig;
    channel: LegacyDmChannel;
    dmPolicy: DmPolicy;
}): OpenClawConfig;
export declare function setLegacyChannelAllowFrom(params: {
    cfg: OpenClawConfig;
    channel: LegacyDmChannel;
    allowFrom: string[];
}): OpenClawConfig;
export declare function setAccountGroupPolicyForChannel(params: {
    cfg: OpenClawConfig;
    channel: "discord" | "slack";
    accountId: string;
    groupPolicy: GroupPolicy;
}): OpenClawConfig;
type AccountScopedChannel = "discord" | "slack" | "telegram" | "imessage" | "signal";
type LegacyDmChannel = "discord" | "slack";
export declare function patchLegacyDmChannelConfig(params: {
    cfg: OpenClawConfig;
    channel: LegacyDmChannel;
    patch: Record<string, unknown>;
}): OpenClawConfig;
export declare function setOnboardingChannelEnabled(cfg: OpenClawConfig, channel: AccountScopedChannel, enabled: boolean): OpenClawConfig;
export declare function patchChannelConfigForAccount(params: {
    cfg: OpenClawConfig;
    channel: AccountScopedChannel;
    accountId: string;
    patch: Record<string, unknown>;
}): OpenClawConfig;
export declare function applySingleTokenPromptResult(params: {
    cfg: OpenClawConfig;
    channel: "discord" | "telegram";
    accountId: string;
    tokenPatchKey: "token" | "botToken";
    tokenResult: {
        useEnv: boolean;
        token: string | null;
    };
}): OpenClawConfig;
export declare function promptSingleChannelToken(params: {
    prompter: Pick<WizardPrompter, "confirm" | "text">;
    accountConfigured: boolean;
    canUseEnv: boolean;
    hasConfigToken: boolean;
    envPrompt: string;
    keepPrompt: string;
    inputPrompt: string;
}): Promise<{
    useEnv: boolean;
    token: string | null;
}>;
type ParsedAllowFromResult = {
    entries: string[];
    error?: string;
};
export declare function promptParsedAllowFromForScopedChannel(params: {
    cfg: OpenClawConfig;
    channel: "imessage" | "signal";
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
export declare function noteChannelLookupSummary(params: {
    prompter: Pick<WizardPrompter, "note">;
    label: string;
    resolvedSections: Array<{
        title: string;
        values: string[];
    }>;
    unresolved?: string[];
}): Promise<void>;
export declare function noteChannelLookupFailure(params: {
    prompter: Pick<WizardPrompter, "note">;
    label: string;
    error: unknown;
}): Promise<void>;
type AllowFromResolution = {
    input: string;
    resolved: boolean;
    id?: string | null;
};
export declare function promptResolvedAllowFrom(params: {
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
export declare function promptLegacyChannelAllowFrom(params: {
    cfg: OpenClawConfig;
    channel: LegacyDmChannel;
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
export {};
