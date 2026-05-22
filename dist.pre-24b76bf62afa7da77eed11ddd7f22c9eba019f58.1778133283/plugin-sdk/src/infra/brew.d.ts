type BrewResolutionOptions = {
    homeDir?: string;
    /**
     * @deprecated No-op compatibility field for plugin SDK callers. Homebrew
     * env vars are ignored for resolution because workspace env can be untrusted.
     */
    env?: NodeJS.ProcessEnv;
};
export declare function resolveBrewPathDirs(opts?: BrewResolutionOptions): string[];
export declare function resolveBrewExecutable(opts?: BrewResolutionOptions): string | undefined;
export {};
