export declare function logDiscordResolvedConfig(params: {
    dmEnabled: boolean;
    dmPolicy: string;
    allowFrom?: string[];
    groupDmEnabled: boolean;
    groupDmChannels?: string[];
    groupPolicy: string;
    guildEntries?: Record<string, unknown>;
    historyLimit: number;
    mediaMaxBytes: number;
    nativeEnabled: boolean;
    nativeSkillsEnabled: boolean;
    useAccessGroups: boolean;
    threadBindingsEnabled: boolean;
    threadBindingIdleTimeoutMs: number;
    threadBindingMaxAgeMs: number;
}): void;
