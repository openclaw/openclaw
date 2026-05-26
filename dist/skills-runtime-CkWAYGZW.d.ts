//#region src/agents/skills/refresh-state.d.ts
type SkillsChangeEvent = {
  workspaceDir?: string;
  reason: "watch" | "watch-targets" | "manual" | "remote-node" | "config-change";
  changedPath?: string;
};
declare function registerSkillsChangeListener(listener: (event: SkillsChangeEvent) => void): () => void;
declare function bumpSkillsSnapshotVersion(params?: {
  workspaceDir?: string;
  reason?: SkillsChangeEvent["reason"];
  changedPath?: string;
}): number;
declare function getSkillsSnapshotVersion(workspaceDir?: string): number;
declare function shouldRefreshSnapshotForVersion(cachedVersion?: number, nextVersion?: number): boolean;
//#endregion
export { shouldRefreshSnapshotForVersion as a, registerSkillsChangeListener as i, bumpSkillsSnapshotVersion as n, getSkillsSnapshotVersion as r, SkillsChangeEvent as t };