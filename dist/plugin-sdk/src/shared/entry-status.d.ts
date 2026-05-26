import { type RequirementConfigCheck, type RequirementRemote, type Requirements, type RequirementsMetadata } from "./requirements.js";
export type EntryMetadataRequirementsParams = Parameters<typeof evaluateEntryMetadataRequirements>[0];
export declare function evaluateEntryMetadataRequirements(params: {
    always: boolean;
    metadata?: (RequirementsMetadata & {
        emoji?: string;
        homepage?: string;
    }) | null;
    frontmatter?: {
        emoji?: string;
        homepage?: string;
        website?: string;
        url?: string;
    } | null;
    hasLocalBin: (bin: string) => boolean;
    localPlatform: string;
    remote?: RequirementRemote;
    isEnvSatisfied: (envName: string) => boolean;
    isConfigSatisfied: (pathStr: string) => boolean;
}): {
    emoji?: string;
    homepage?: string;
    required: Requirements;
    missing: Requirements;
    requirementsSatisfied: boolean;
    configChecks: RequirementConfigCheck[];
};
export declare function evaluateEntryMetadataRequirementsForCurrentPlatform(params: Omit<EntryMetadataRequirementsParams, "localPlatform">): ReturnType<typeof evaluateEntryMetadataRequirements>;
export declare function evaluateEntryRequirementsForCurrentPlatform(params: {
    always: boolean;
    entry: {
        metadata?: (RequirementsMetadata & {
            emoji?: string;
            homepage?: string;
        }) | null;
        frontmatter?: {
            emoji?: string;
            homepage?: string;
            website?: string;
            url?: string;
        } | null;
    };
    hasLocalBin: (bin: string) => boolean;
    remote?: RequirementRemote;
    isEnvSatisfied: (envName: string) => boolean;
    isConfigSatisfied: (pathStr: string) => boolean;
}): ReturnType<typeof evaluateEntryMetadataRequirements>;
