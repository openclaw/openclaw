export type DiscordModelPickerPreferenceScope = {
    accountId?: string;
    guildId?: string;
    userId: string;
};
export declare function buildDiscordModelPickerPreferenceKey(scope: DiscordModelPickerPreferenceScope): string | null;
export declare function readDiscordModelPickerRecentModels(params: {
    scope: DiscordModelPickerPreferenceScope;
    limit?: number;
    allowedModelRefs?: Set<string>;
    env?: NodeJS.ProcessEnv;
}): Promise<string[]>;
export declare function recordDiscordModelPickerRecentModel(params: {
    scope: DiscordModelPickerPreferenceScope;
    modelRef: string;
    limit?: number;
    env?: NodeJS.ProcessEnv;
}): Promise<void>;
