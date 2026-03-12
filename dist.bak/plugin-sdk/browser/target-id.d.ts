export type TargetIdResolution = {
    ok: true;
    targetId: string;
} | {
    ok: false;
    reason: "not_found" | "ambiguous";
    matches?: string[];
};
export declare function resolveTargetIdFromTabs(input: string, tabs: Array<{
    targetId: string;
}>): TargetIdResolution;
