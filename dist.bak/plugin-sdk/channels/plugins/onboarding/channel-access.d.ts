import type { WizardPrompter } from "../../../wizard/prompts.js";
export type ChannelAccessPolicy = "allowlist" | "open" | "disabled";
export declare function parseAllowlistEntries(raw: string): string[];
export declare function formatAllowlistEntries(entries: string[]): string;
export declare function promptChannelAccessPolicy(params: {
    prompter: WizardPrompter;
    label: string;
    currentPolicy?: ChannelAccessPolicy;
    allowOpen?: boolean;
    allowDisabled?: boolean;
}): Promise<ChannelAccessPolicy>;
export declare function promptChannelAllowlist(params: {
    prompter: WizardPrompter;
    label: string;
    currentEntries?: string[];
    placeholder?: string;
}): Promise<string[]>;
export declare function promptChannelAccessConfig(params: {
    prompter: WizardPrompter;
    label: string;
    currentPolicy?: ChannelAccessPolicy;
    currentEntries?: string[];
    placeholder?: string;
    allowOpen?: boolean;
    allowDisabled?: boolean;
    defaultPrompt?: boolean;
    updatePrompt?: boolean;
}): Promise<{
    policy: ChannelAccessPolicy;
    entries: string[];
} | null>;
