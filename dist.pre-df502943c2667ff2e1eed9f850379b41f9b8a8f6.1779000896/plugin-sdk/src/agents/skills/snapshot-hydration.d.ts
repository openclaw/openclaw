type SnapshotWithRuntimeSkills = {
    resolvedSkills?: unknown;
};
type SnapshotRebuild<T extends SnapshotWithRuntimeSkills> = {
    resolvedSkills?: T["resolvedSkills"];
};
export declare function hydrateResolvedSkills<T extends SnapshotWithRuntimeSkills>(snapshot: T, rebuild: () => SnapshotRebuild<T>): T;
export declare function hydrateResolvedSkillsAsync<T extends SnapshotWithRuntimeSkills>(snapshot: T, rebuild: () => Promise<SnapshotRebuild<T>>): Promise<T>;
export {};
