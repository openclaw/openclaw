export declare const POSIX_INLINE_COMMAND_FLAGS: Set<string>;
export declare const POWERSHELL_INLINE_COMMAND_FLAGS: Set<string>;
export declare function resolveInlineCommandMatch(argv: string[], flags: ReadonlySet<string>, options?: {
    allowCombinedC?: boolean;
}): {
    command: string | null;
    valueTokenIndex: number | null;
};
export declare function hasPosixInteractiveStartupBeforeInlineCommand(argv: string[], flags: ReadonlySet<string>): boolean;
export declare function hasPosixLoginStartupBeforeInlineCommand(argv: string[], flags: ReadonlySet<string>): boolean;
export declare function hasFishInitCommandOption(argv: string[]): boolean;
export declare function hasFishAttachedCommandOption(argv: string[]): boolean;
