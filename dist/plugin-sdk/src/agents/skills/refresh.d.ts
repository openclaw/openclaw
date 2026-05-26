import type { OpenClawConfig } from "../../config/types.openclaw.js";
export { bumpSkillsSnapshotVersion, getSkillsSnapshotVersion, registerSkillsChangeListener, shouldRefreshSnapshotForVersion, type SkillsChangeEvent, } from "./refresh-state.js";
export declare const DEFAULT_SKILLS_WATCH_IGNORED: RegExp[];
export declare function shouldIgnoreSkillsWatchPath(watchPath: string, stats?: {
    isDirectory?: () => boolean;
}): boolean;
export declare function ensureSkillsWatcher(params: {
    workspaceDir: string;
    config?: OpenClawConfig;
}): void;
export declare function resetSkillsRefreshForTest(): Promise<void>;
