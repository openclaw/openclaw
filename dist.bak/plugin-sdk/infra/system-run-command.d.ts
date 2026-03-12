export type SystemRunCommandValidation = {
    ok: true;
    shellCommand: string | null;
    cmdText: string;
} | {
    ok: false;
    message: string;
    details?: Record<string, unknown>;
};
export type ResolvedSystemRunCommand = {
    ok: true;
    argv: string[];
    rawCommand: string | null;
    shellCommand: string | null;
    cmdText: string;
} | {
    ok: false;
    message: string;
    details?: Record<string, unknown>;
};
export declare function formatExecCommand(argv: string[]): string;
export declare function extractShellCommandFromArgv(argv: string[]): string | null;
export declare function validateSystemRunCommandConsistency(params: {
    argv: string[];
    rawCommand?: string | null;
}): SystemRunCommandValidation;
export declare function resolveSystemRunCommand(params: {
    command?: unknown;
    rawCommand?: unknown;
}): ResolvedSystemRunCommand;
