export declare function createSessionManagerRuntimeRegistry<TValue>(): {
    set: (sessionManager: unknown, value: TValue | null) => void;
    get: (sessionManager: unknown) => TValue | null;
};
