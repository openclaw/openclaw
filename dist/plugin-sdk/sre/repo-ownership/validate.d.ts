import type { LoadedRepoOwnershipMap, RepoOwnershipMap } from "./types.js";
type RepoOwnershipValidationTarget = RepoOwnershipMap | LoadedRepoOwnershipMap;
declare function normalizeOwnedGlob(glob: string): string;
declare function globsOverlap(left: string, right: string): boolean;
export declare function validateRepoOwnershipMap(map: RepoOwnershipValidationTarget): RepoOwnershipValidationTarget;
export declare const __test__: {
    globsOverlap: typeof globsOverlap;
    normalizeOwnedGlob: typeof normalizeOwnedGlob;
};
export {};
