type SystemRunCommandValidation = {
    ok: true;
    shellPayload: string | null;
    commandText: string;
    previewText: string | null;
} | {
    ok: false;
    message: string;
    details?: Record<string, unknown>;
};
type ResolvedSystemRunCommand = {
    ok: true;
    argv: string[];
    commandText: string;
    shellPayload: string | null;
    previewText: string | null;
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
    allowLegacyShellText?: boolean;
}): SystemRunCommandValidation;
export declare function resolveSystemRunCommand(params: {
    command?: unknown;
    rawCommand?: unknown;
}): ResolvedSystemRunCommand;
export declare function resolveSystemRunCommandRequest(params: {
    command?: unknown;
    rawCommand?: unknown;
}): ResolvedSystemRunCommand;
export {};
