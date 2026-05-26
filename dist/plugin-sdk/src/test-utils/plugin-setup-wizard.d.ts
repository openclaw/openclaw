import { type Mock } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../channels/plugins/setup-wizard.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { WizardPrompter } from "../wizard/prompts.js";
export type { WizardPrompter } from "../wizard/prompts.js";
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type QueuedWizardPrompter = {
    intro: AsyncUnknownMock;
    outro: AsyncUnknownMock;
    note: AsyncUnknownMock;
    plain: AsyncUnknownMock;
    select: AsyncUnknownMock;
    multiselect: AsyncUnknownMock;
    text: AsyncUnknownMock;
    confirm: AsyncUnknownMock;
    progress: Mock<() => {
        update: UnknownMock;
        stop: UnknownMock;
    }>;
    prompter: WizardPrompter;
};
export declare function selectFirstWizardOption<T>(params: {
    options: Array<{
        value: T;
    }>;
}): Promise<T>;
export declare function createTestWizardPrompter(overrides?: Partial<WizardPrompter>): WizardPrompter;
export declare function createQueuedWizardPrompter(params?: {
    selectValues?: string[];
    textValues?: string[];
    confirmValues?: boolean[];
}): QueuedWizardPrompter;
type SetupWizardAdapterParams = Parameters<typeof buildChannelSetupWizardAdapterFromSetupWizard>[0];
type SetupWizardCredentialValues = Record<string, string>;
type SetupWizardTestPlugin = {
    id: string;
    setupWizard?: ChannelPlugin["setupWizard"];
    config: Record<string, unknown>;
} & Record<string, unknown>;
export declare function createSetupWizardAdapter(params: SetupWizardAdapterParams): import("openclaw/plugin-sdk/setup").ChannelSetupWizardAdapter;
export declare function createPluginSetupWizardAdapter(plugin: SetupWizardTestPlugin): import("openclaw/plugin-sdk/setup").ChannelSetupWizardAdapter;
export declare function createPluginSetupWizardConfigure(plugin: SetupWizardTestPlugin): (ctx: import("../channels/plugins/setup-wizard-types.ts").ChannelSetupConfigureContext) => Promise<import("../channels/plugins/setup-wizard-types.ts").ChannelSetupResult>;
export declare function createPluginSetupWizardStatus(plugin: SetupWizardTestPlugin): (ctx: import("../channels/plugins/setup-wizard-types.ts").ChannelSetupStatusContext) => Promise<import("../channels/plugins/setup-wizard-types.ts").ChannelSetupStatus>;
export declare function runSetupWizardConfigure<TCfg, TOptions extends Record<string, unknown>, TAccountOverrides extends Record<string, string | undefined>, TRuntime, TResult>(params: {
    configure: (args: {
        cfg: TCfg;
        runtime: TRuntime;
        prompter: WizardPrompter;
        options: TOptions;
        accountOverrides: TAccountOverrides;
        shouldPromptAccountIds: boolean;
        forceAllowFrom: boolean;
    }) => Promise<TResult>;
    cfg?: TCfg;
    runtime?: TRuntime;
    prompter: WizardPrompter;
    options?: TOptions;
    accountOverrides?: TAccountOverrides;
    shouldPromptAccountIds?: boolean;
    forceAllowFrom?: boolean;
}): Promise<TResult>;
export declare function runSetupWizardPrepare<TCfg, TOptions extends Record<string, unknown>, TRuntime, TResult>(params: {
    prepare?: (args: {
        cfg: TCfg;
        accountId: string;
        credentialValues: Record<string, string>;
        runtime: TRuntime;
        prompter: WizardPrompter;
        options?: TOptions;
    }) => Promise<TResult> | TResult;
    cfg?: TCfg;
    accountId?: string;
    credentialValues?: Record<string, string>;
    runtime?: TRuntime;
    prompter?: WizardPrompter;
    options?: TOptions;
}): Promise<TResult | undefined>;
export declare function runSetupWizardFinalize<TCfg, TOptions extends Record<string, unknown>, TRuntime, TResult>(params: {
    finalize?: (args: {
        cfg: TCfg;
        accountId: string;
        credentialValues: Record<string, string>;
        runtime: TRuntime;
        prompter: WizardPrompter;
        options?: TOptions;
        forceAllowFrom: boolean;
    }) => Promise<TResult> | TResult;
    cfg?: TCfg;
    accountId?: string;
    credentialValues?: Record<string, string>;
    runtime?: TRuntime;
    prompter?: WizardPrompter;
    options?: TOptions;
    forceAllowFrom?: boolean;
}): Promise<TResult | undefined>;
export declare function promptSetupWizardAllowFrom<TCfg, TResult>(params: {
    promptAllowFrom?: (args: {
        cfg: TCfg;
        prompter: WizardPrompter;
        accountId: string;
    }) => Promise<TResult> | TResult;
    cfg?: TCfg;
    prompter?: WizardPrompter;
    accountId?: string;
}): Promise<TResult | undefined>;
export declare function resolveSetupWizardAllowFromEntries<TCfg, TResult>(params: {
    resolveEntries?: (args: {
        cfg: TCfg;
        accountId: string;
        credentialValues: Record<string, string>;
        entries: string[];
    }) => Promise<TResult> | TResult;
    entries: string[];
    cfg?: TCfg;
    accountId?: string;
    credentialValues?: SetupWizardCredentialValues;
}): Promise<TResult | undefined>;
export declare function resolveSetupWizardGroupAllowlist<TCfg, TResult>(params: {
    resolveAllowlist?: (args: {
        cfg: TCfg;
        accountId: string;
        credentialValues: Record<string, string>;
        entries: string[];
        prompter: Pick<WizardPrompter, "note">;
    }) => Promise<TResult> | TResult;
    entries: string[];
    cfg?: TCfg;
    accountId?: string;
    credentialValues?: SetupWizardCredentialValues;
    prompter?: Pick<WizardPrompter, "note">;
}): Promise<TResult | undefined>;
