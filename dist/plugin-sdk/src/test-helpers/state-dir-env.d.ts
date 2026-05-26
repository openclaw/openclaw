export declare function snapshotStateDirEnv(): {
    restore(): void;
};
export declare function restoreStateDirEnv(snapshot: ReturnType<typeof snapshotStateDirEnv>): void;
export declare function setStateDirEnv(stateDir: string): void;
export declare function withStateDirEnv<T>(prefix: string, fn: (ctx: {
    tempRoot: string;
    stateDir: string;
}) => Promise<T>): Promise<T>;
