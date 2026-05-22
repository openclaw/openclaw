import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
type CompletionShell = "zsh" | "bash" | "fish" | "powershell";
export type ShellCompletionStatus = {
    shell: CompletionShell;
    profileInstalled: boolean;
    cacheExists: boolean;
    cachePath: string;
    /** True if profile uses slow dynamic pattern like `source <(openclaw completion ...)` */
    usesSlowPattern: boolean;
};
/** Check the status of shell completion for the current shell. */
export declare function checkShellCompletionStatus(binName?: string): Promise<ShellCompletionStatus>;
export type DoctorCompletionOptions = {
    nonInteractive?: boolean;
};
/**
 * Doctor check for shell completion.
 * - If profile uses slow dynamic pattern: upgrade to cached version
 * - If profile has completion but no cache: auto-generate cache and upgrade profile
 * - If no completion at all: prompt to install (with user confirmation)
 */
export declare function doctorShellCompletion(runtime: RuntimeEnv, prompter: DoctorPrompter, options?: DoctorCompletionOptions): Promise<void>;
/**
 * Ensure completion cache exists. Used during setup/update to fix
 * cases where profile has completion but no cache.
 * This is a silent fix - no prompts.
 */
export declare function ensureCompletionCacheExists(binName?: string): Promise<boolean>;
export {};
