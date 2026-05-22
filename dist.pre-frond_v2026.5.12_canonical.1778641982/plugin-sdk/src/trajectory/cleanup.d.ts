export type RemovedTrajectoryArtifact = {
    kind: "pointer" | "runtime";
    path: string;
};
export declare function removeSessionTrajectoryArtifacts(params: {
    sessionId: string;
    sessionFile?: string;
    storePath: string;
    restrictToStoreDir?: boolean;
}): Promise<RemovedTrajectoryArtifact[]>;
export declare function removeRemovedSessionTrajectoryArtifacts(params: {
    removedSessionFiles: Iterable<[string, string | undefined]>;
    referencedSessionIds: ReadonlySet<string>;
    storePath: string;
    restrictToStoreDir?: boolean;
}): Promise<RemovedTrajectoryArtifact[]>;
