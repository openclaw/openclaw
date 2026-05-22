import type { ArchiveLogger } from "../infra/archive.js";
export declare const CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS: readonly ["SKILL.md", "skill.md", "skills.md", "SKILL.MD"];
type SkillArchiveInstallScan = false | {
    dangerouslyForceUnsafeInstall?: boolean;
    installId?: string;
    origin: string;
};
export type SkillArchiveInstallResult = {
    ok: true;
    targetDir: string;
} | {
    ok: false;
    error: string;
    failureKind: SkillArchiveInstallFailureKind;
};
export type SkillArchiveInstallFailureKind = "invalid-request" | "unavailable";
export declare function normalizeTrackedSkillSlug(raw: string): string;
export declare function validateRequestedSkillSlug(raw: string): string;
export declare function resolveWorkspaceSkillInstallDir(workspaceDir: string, slug: string): string;
export declare function installExtractedSkillRoot(params: {
    workspaceDir: string;
    slug: string;
    extractedRoot: string;
    mode: "install" | "update";
    timeoutMs?: number;
    logger?: ArchiveLogger;
    scan?: SkillArchiveInstallScan;
    rootMarkers?: readonly string[];
}): Promise<SkillArchiveInstallResult>;
export declare function installSkillArchiveFromPath(params: {
    archivePath: string;
    workspaceDir: string;
    slug: string;
    force?: boolean;
    timeoutMs?: number;
    logger?: ArchiveLogger;
    scan?: SkillArchiveInstallScan;
}): Promise<SkillArchiveInstallResult>;
export {};
