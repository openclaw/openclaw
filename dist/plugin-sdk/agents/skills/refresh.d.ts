import type { OpenClawConfig } from "../../config/config.js";
type SkillsChangeEvent = {
    workspaceDir?: string;
    reason: "watch" | "manual" | "remote-node";
    changedPath?: string;
};
export declare const DEFAULT_SKILLS_WATCH_IGNORED: RegExp[];
export declare function registerSkillsChangeListener(listener: (event: SkillsChangeEvent) => void): () => void;
export declare function bumpSkillsSnapshotVersion(params?: {
    workspaceDir?: string;
    reason?: SkillsChangeEvent["reason"];
    changedPath?: string;
}): number;
export declare function getSkillsSnapshotVersion(workspaceDir?: string): number;
export declare function ensureSkillsWatcher(params: {
    workspaceDir: string;
    config?: OpenClawConfig;
}): void;
export {};
