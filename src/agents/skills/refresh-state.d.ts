export type SkillsChangeEvent = {
    workspaceDir?: string;
    reason: "watch" | "manual" | "remote-node" | "config-change";
    changedPath?: string;
};
export declare function setSkillsChangeListenerErrorHandler(handler?: (err: unknown) => void): void;
export declare function registerSkillsChangeListener(listener: (event: SkillsChangeEvent) => void): () => void;
export declare function bumpSkillsSnapshotVersion(params?: {
    workspaceDir?: string;
    reason?: SkillsChangeEvent["reason"];
    changedPath?: string;
}): number;
export declare function getSkillsSnapshotVersion(workspaceDir?: string): number;
export declare function shouldRefreshSnapshotForVersion(cachedVersion?: number, nextVersion?: number): boolean;
export declare function resetSkillsRefreshStateForTest(): void;
