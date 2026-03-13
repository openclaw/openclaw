export declare function resolveEffectiveHomeDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string | undefined;
export declare function resolveRequiredHomeDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function expandHomePrefix(input: string, opts?: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
}): string;
