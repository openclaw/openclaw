export type OomWrapOptions = {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    shellAvailable?: () => boolean;
};
export type OomScoreAdjustedSpawn = {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv | undefined;
    wrapped: boolean;
};
export declare function prepareOomScoreAdjustedSpawn(command: string, args?: readonly string[], options?: OomWrapOptions): OomScoreAdjustedSpawn;
export declare function wrapArgvForChildOomScoreRaise(argv: readonly string[], options?: OomWrapOptions): string[];
/**
 * Returns `baseEnv` with shell-init keys stripped when argv will be wrapped.
 * Unchanged (including `undefined`) when no wrap applies, so non-Linux and
 * opted-out paths keep exact inherited-env semantics.
 */
export declare function hardenedEnvForChildOomWrap(baseEnv: NodeJS.ProcessEnv | undefined, options?: OomWrapOptions): NodeJS.ProcessEnv | undefined;
