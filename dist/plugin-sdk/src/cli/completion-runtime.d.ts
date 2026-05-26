export declare const COMPLETION_SHELLS: readonly ["zsh", "bash", "powershell", "fish"];
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];
export declare const COMPLETION_SKIP_PLUGIN_COMMANDS_ENV = "OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS";
export declare function isCompletionShell(value: string): value is CompletionShell;
export declare function resolveShellFromEnv(env?: NodeJS.ProcessEnv): CompletionShell;
export declare function resolveCompletionCachePath(shell: CompletionShell, binName: string): string;
/** Check if the completion cache file exists for the given shell. */
export declare function completionCacheExists(shell: CompletionShell, binName?: string): Promise<boolean>;
export declare function formatCompletionSourceLine(shell: CompletionShell, _binName: string, cachePath: string): string;
export declare function formatCompletionReloadCommand(shell: CompletionShell, profilePath: string): string;
export declare function resolveCompletionProfilePath(shell: CompletionShell, options?: {
    env?: NodeJS.ProcessEnv;
    homeDir?: () => string;
    platform?: NodeJS.Platform;
}): string;
export declare function isCompletionInstalled(shell: CompletionShell, binName?: string): Promise<boolean>;
/**
 * Check if the profile uses the slow dynamic completion pattern.
 * Returns true if profile has `source <(openclaw completion ...)` instead of cached file.
 */
export declare function usesSlowDynamicCompletion(shell: CompletionShell, binName?: string): Promise<boolean>;
export declare function installCompletion(shell: string, yes: boolean, binName?: string): Promise<void>;
