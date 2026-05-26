export type CommitMetadataReaders = {
    readGitCommit?: (searchDir: string, packageRoot: string | null) => string | null | undefined;
    readBuildInfoCommit?: () => string | null;
    readPackageJsonCommit?: () => string | null;
};
export declare const resolveCommitHash: (options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    moduleUrl?: string;
    readers?: CommitMetadataReaders;
}) => string | null;
export declare const __testing: {
    clearCachedGitCommits: () => void;
};
