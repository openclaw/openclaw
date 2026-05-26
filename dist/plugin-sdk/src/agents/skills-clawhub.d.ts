import { type ClawHubSkillDetail, type ClawHubSkillSearchResult } from "../infra/clawhub.js";
export type ClawHubSkillOrigin = {
    version: 1;
    registry: string;
    slug: string;
    installedVersion: string;
    installedAt: number;
};
export type ClawHubSkillsLockfile = {
    version: 1;
    skills: Record<string, {
        version: string;
        installedAt: number;
    }>;
};
export type InstallClawHubSkillResult = {
    ok: true;
    slug: string;
    version: string;
    targetDir: string;
    detail: ClawHubSkillDetail;
} | {
    ok: false;
    error: string;
};
export type UpdateClawHubSkillResult = {
    ok: true;
    slug: string;
    previousVersion: string | null;
    version: string;
    changed: boolean;
    targetDir: string;
} | {
    ok: false;
    error: string;
};
type Logger = {
    info?: (message: string) => void;
};
export declare function readClawHubSkillsLockfile(workspaceDir: string): Promise<ClawHubSkillsLockfile>;
export declare function searchSkillsFromClawHub(params: {
    query?: string;
    limit?: number;
    baseUrl?: string;
}): Promise<ClawHubSkillSearchResult[]>;
export declare function installSkillFromClawHub(params: {
    workspaceDir: string;
    slug: string;
    version?: string;
    baseUrl?: string;
    force?: boolean;
    logger?: Logger;
}): Promise<InstallClawHubSkillResult>;
export declare function updateSkillsFromClawHub(params: {
    workspaceDir: string;
    slug?: string;
    baseUrl?: string;
    logger?: Logger;
}): Promise<UpdateClawHubSkillResult[]>;
export declare function readTrackedClawHubSkillSlugs(workspaceDir: string): Promise<string[]>;
export declare function untrackClawHubSkill(workspaceDir: string, slug: string): Promise<void>;
export {};
