export type Requirements = {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
};
export type RequirementConfigCheck = {
    path: string;
    satisfied: boolean;
};
export type RequirementsMetadata = {
    requires?: Partial<Pick<Requirements, "bins" | "anyBins" | "env" | "config">>;
    os?: string[];
};
export type RequirementRemote = {
    hasBin?: (bin: string) => boolean;
    hasAnyBin?: (bins: string[]) => boolean;
    platforms?: string[];
};
type RequirementsEvaluationContext = {
    always: boolean;
    hasLocalBin: (bin: string) => boolean;
    localPlatform: string;
    isEnvSatisfied: (envName: string) => boolean;
    isConfigSatisfied: (pathStr: string) => boolean;
};
type RequirementsEvaluationRemoteContext = {
    hasRemoteBin?: (bin: string) => boolean;
    hasRemoteAnyBin?: (bins: string[]) => boolean;
    remotePlatforms?: string[];
};
export declare function resolveMissingBins(params: {
    required: string[];
    hasLocalBin: (bin: string) => boolean;
    hasRemoteBin?: (bin: string) => boolean;
}): string[];
export declare function resolveMissingAnyBins(params: {
    required: string[];
    hasLocalBin: (bin: string) => boolean;
    hasRemoteAnyBin?: (bins: string[]) => boolean;
}): string[];
export declare function resolveMissingOs(params: {
    required: string[];
    localPlatform: string;
    remotePlatforms?: string[];
}): string[];
export declare function resolveMissingEnv(params: {
    required: string[];
    isSatisfied: (envName: string) => boolean;
}): string[];
export declare function buildConfigChecks(params: {
    required: string[];
    isSatisfied: (pathStr: string) => boolean;
}): RequirementConfigCheck[];
export declare function evaluateRequirements(params: RequirementsEvaluationContext & RequirementsEvaluationRemoteContext & {
    required: Requirements;
}): {
    missing: Requirements;
    eligible: boolean;
    configChecks: RequirementConfigCheck[];
};
export declare function evaluateRequirementsFromMetadata(params: RequirementsEvaluationContext & RequirementsEvaluationRemoteContext & {
    metadata?: RequirementsMetadata;
}): {
    required: Requirements;
    missing: Requirements;
    eligible: boolean;
    configChecks: RequirementConfigCheck[];
};
export declare function evaluateRequirementsFromMetadataWithRemote(params: RequirementsEvaluationContext & {
    metadata?: RequirementsMetadata;
    remote?: RequirementRemote;
}): {
    required: Requirements;
    missing: Requirements;
    eligible: boolean;
    configChecks: RequirementConfigCheck[];
};
export {};
