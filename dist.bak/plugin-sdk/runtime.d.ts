export type RuntimeEnv = {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    exit: (code: number) => void;
};
export declare const defaultRuntime: RuntimeEnv;
export declare function createNonExitingRuntime(): RuntimeEnv;
