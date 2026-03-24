export declare const DATA_INCIDENT_RE: RegExp;
export declare const EXACT_ARTIFACT_RE: RegExp;
export declare const HUMAN_CORRECTION_RE: RegExp;
export declare function matchesHumanCorrection(text: string): boolean;
export declare function extractResolverFamily(text: string): "vaultV2ByAddress" | "vaultByAddress" | undefined;
export declare function extractInlineJsonTextValue(line: string): string | undefined;
