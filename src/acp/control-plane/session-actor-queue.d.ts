export declare class SessionActorQueue {
    private readonly queue;
    private readonly pendingBySession;
    getTailMapForTesting(): Map<string, Promise<void>>;
    getTotalPendingCount(): number;
    getPendingCountForSession(actorKey: string): number;
    run<T>(actorKey: string, op: () => Promise<T>): Promise<T>;
}
