import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
type SnapshotPathSource = "skillsSnapshot.prompt" | "skillsSnapshot.resolvedSkills" | "systemPromptReport.injectedWorkspaceFiles";
export type StaleSessionSnapshotPathFinding = {
    sessionKey: string;
    field: SnapshotPathSource;
    cachedPath: string;
    expectedPath: string;
};
export declare function scanSessionStoreForStaleRuntimeSnapshotPaths(params: {
    store: Record<string, SessionEntry>;
    bundledSkillsDir: string | undefined;
    pathExists?: (filePath: string) => boolean;
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
}): StaleSessionSnapshotPathFinding[];
export declare function noteSessionSnapshotHealth(params?: {
    storePaths?: string[];
    bundledSkillsDir?: string;
    cfg?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): Promise<void>;
export {};
