export declare const COMMAND_CARRIER_EXECUTABLES: Set<string>;
export declare const SOURCE_EXECUTABLES: Set<string>;
export declare function isEnvAssignmentToken(token: string): boolean;
export type ParsedEnvInvocationPrelude = {
    assignmentKeys: string[];
    commandIndex: number;
    splitArgv?: string[];
    usesModifiers: boolean;
};
export declare function parseEnvInvocationPrelude(argv: string[], depth?: number): ParsedEnvInvocationPrelude | null;
export declare function envInvocationUsesModifiers(argv: string[]): boolean;
export declare function unwrapEnvInvocation(argv: string[]): string[] | null;
export declare function resolveEnvCarriedArgv(argv: string[], depth?: number): string[] | null;
export declare function resolveCarrierCommandArgv(argv: string[], depth?: number, options?: {
    includeExec?: boolean;
}): string[] | null;
