/** ClaWorks CLI binary name */
export declare const CLAWORKS_CLI_NAME = "claworks";
/** OpenClaw CLI binary name */
export declare const OPENCLAW_CLI_NAME = "openclaw";
/** Detect ClaWorks product mode via environment variable */
export declare function isClaworksCliProduct(env?: NodeJS.ProcessEnv): boolean;
/** Resolve display title for the given CLI name */
export declare function resolveCliProductTitle(cliName: string): string;
/** Resolve emoji for the given CLI name */
export declare function resolveCliProductEmoji(cliName: string): string;
export declare function resolveCliName(argv?: string[]): string;
export declare function replaceCliName(command: string, cliName?: string): string;
