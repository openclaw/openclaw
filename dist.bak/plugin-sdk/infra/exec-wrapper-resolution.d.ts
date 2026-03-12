export declare const MAX_DISPATCH_WRAPPER_DEPTH = 4;
export declare const POSIX_SHELL_WRAPPERS: Set<"ash" | "bash" | "dash" | "fish" | "ksh" | "sh" | "zsh">;
export declare const WINDOWS_CMD_WRAPPERS: Set<string>;
export declare const POWERSHELL_WRAPPERS: Set<string>;
export declare const DISPATCH_WRAPPER_EXECUTABLES: Set<string>;
export type ShellWrapperCommand = {
    isWrapper: boolean;
    command: string | null;
};
export declare function basenameLower(token: string): string;
export declare function normalizeExecutableToken(token: string): string;
export declare function isDispatchWrapperExecutable(token: string): boolean;
export declare function isShellWrapperExecutable(token: string): boolean;
export type ShellMultiplexerUnwrapResult = {
    kind: "not-wrapper";
} | {
    kind: "blocked";
    wrapper: string;
} | {
    kind: "unwrapped";
    wrapper: string;
    argv: string[];
};
export declare function unwrapKnownShellMultiplexerInvocation(argv: string[]): ShellMultiplexerUnwrapResult;
export declare function isEnvAssignment(token: string): boolean;
export declare function unwrapEnvInvocation(argv: string[]): string[] | null;
export type DispatchWrapperUnwrapResult = {
    kind: "not-wrapper";
} | {
    kind: "blocked";
    wrapper: string;
} | {
    kind: "unwrapped";
    wrapper: string;
    argv: string[];
};
export type DispatchWrapperExecutionPlan = {
    argv: string[];
    wrappers: string[];
    policyBlocked: boolean;
    blockedWrapper?: string;
};
export declare function unwrapKnownDispatchWrapperInvocation(argv: string[]): DispatchWrapperUnwrapResult;
export declare function unwrapDispatchWrappersForResolution(argv: string[], maxDepth?: number): string[];
export declare function resolveDispatchWrapperExecutionPlan(argv: string[], maxDepth?: number): DispatchWrapperExecutionPlan;
export declare function hasEnvManipulationBeforeShellWrapper(argv: string[]): boolean;
export declare function extractShellWrapperInlineCommand(argv: string[]): string | null;
export declare function extractShellWrapperCommand(argv: string[], rawCommand?: string | null): ShellWrapperCommand;
