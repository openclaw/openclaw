import { type LoadedRepoOwnershipMap } from "./types.js";
type ResolveRepoOwnershipMapPathOptions = {
    filePath?: string;
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
};
export declare function loadRepoOwnershipMap(filePath: string): Promise<LoadedRepoOwnershipMap>;
export declare function resolveRepoOwnershipMapPath(options?: ResolveRepoOwnershipMapPathOptions): string;
export {};
