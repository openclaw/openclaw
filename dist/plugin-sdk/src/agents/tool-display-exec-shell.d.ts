type PreambleResult = {
    command: string;
    chdirPath?: string;
};
export declare function stripOuterQuotes(value: string | undefined): string | undefined;
export declare function splitShellWords(input: string | undefined, maxWords?: number): string[];
export declare function binaryName(token: string | undefined): string | undefined;
export declare function optionValue(words: string[], names: string[]): string | undefined;
export declare function positionalArgs(words: string[], from?: number, optionsWithValue?: string[]): string[];
export declare function firstPositional(words: string[], from?: number, optionsWithValue?: string[]): string | undefined;
export declare function trimLeadingEnv(words: string[]): string[];
export declare function unwrapShellWrapper(command: string): string;
export declare function splitTopLevelStages(command: string): string[];
export declare function splitTopLevelPipes(command: string): string[];
export declare function stripShellPreamble(command: string): PreambleResult;
export {};
