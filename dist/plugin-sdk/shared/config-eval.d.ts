export declare function isTruthy(value: unknown): boolean;
export declare function resolveConfigPath(config: unknown, pathStr: string): unknown;
export declare function isConfigPathTruthyWithDefaults(config: unknown, pathStr: string, defaults: Record<string, boolean>): boolean;
export type RuntimeRequires = {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
};
type RuntimeRequirementEvalParams = {
    requires?: RuntimeRequires;
    hasBin: (bin: string) => boolean;
    hasAnyRemoteBin?: (bins: string[]) => boolean;
    hasRemoteBin?: (bin: string) => boolean;
    hasEnv: (envName: string) => boolean;
    isConfigPathTruthy: (pathStr: string) => boolean;
};
export declare function evaluateRuntimeRequires(params: RuntimeRequirementEvalParams): boolean;
export declare function evaluateRuntimeEligibility(params: {
    os?: string[];
    remotePlatforms?: string[];
    always?: boolean;
} & RuntimeRequirementEvalParams): boolean;
export declare function resolveRuntimePlatform(): string;
export declare function hasBinary(bin: string): boolean;
export {};
