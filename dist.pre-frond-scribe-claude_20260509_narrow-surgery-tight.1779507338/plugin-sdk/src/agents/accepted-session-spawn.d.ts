export type AcceptedSessionSpawn = {
    runId: string;
    childSessionKey: string;
};
export declare function normalizeAcceptedSessionSpawnResult(result: unknown): AcceptedSessionSpawn | null;
export declare function hasAcceptedSessionSpawn(acceptedSessionSpawns?: readonly unknown[]): boolean;
