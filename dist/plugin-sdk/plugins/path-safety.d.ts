import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import type { LoadedRepoOwnershipMap, LoadedRepoOwnershipRule } from "../sre/repo-ownership/types.js";
export declare function isPathInside(baseDir: string, targetPath: string): boolean;
export declare function safeRealpathSync(targetPath: string, cache?: Map<string, string>): string | null;
export declare function safeStatSync(targetPath: string): fs.Stats | null;
export declare function formatPosixMode(mode: number): string;
export type RepoOwnershipMatch = {
    repo: LoadedRepoOwnershipRule;
    relativePath: string;
    owned: boolean;
};
type RepoOwnershipLoadOptions = {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
};
export declare function isOwnedRelativePath(relativePath: string, globs: string[]): boolean;
export declare function loadRepoOwnershipForRuntime(options?: RepoOwnershipLoadOptions): Promise<LoadedRepoOwnershipMap>;
export declare function matchRepoOwnershipPath(targetPath: string, map: LoadedRepoOwnershipMap): RepoOwnershipMatch | undefined;
export {};
