import type { RepoOwnershipEntry, RepoOwnershipMap } from "../contracts/change-plan.js";
export type { RepoOwnershipEntry, RepoOwnershipMap } from "../contracts/change-plan.js";
export declare const REPO_OWNERSHIP_FILENAME = "repo-ownership.json";
export type LoadedRepoOwnershipRule = RepoOwnershipEntry & {
    resolvedLocalPath: string;
};
export type LoadedRepoOwnershipMap = Omit<RepoOwnershipMap, "repos"> & {
    repos: LoadedRepoOwnershipRule[];
};
