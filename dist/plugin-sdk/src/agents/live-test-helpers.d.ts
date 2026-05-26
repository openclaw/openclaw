export declare function isLiveTestEnabled(extraEnvVars?: readonly string[], env?: NodeJS.ProcessEnv): boolean;
export declare function isLiveProfileKeyModeEnabled(env?: NodeJS.ProcessEnv): boolean;
export declare function createSingleUserPromptMessage(content?: string): {
    role: "user";
    content: string;
    timestamp: number;
}[];
export declare function extractNonEmptyAssistantText(content: Array<{
    type?: string;
    text?: string;
}>): string;
