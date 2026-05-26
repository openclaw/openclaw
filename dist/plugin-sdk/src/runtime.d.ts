export type RuntimeEnv = {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    exit: (code: number) => void;
};
export type OutputRuntimeEnv = RuntimeEnv & {
    writeStdout: (value: string) => void;
    writeJson: (value: unknown, space?: number) => void;
};
export declare const defaultRuntime: OutputRuntimeEnv;
export declare function createNonExitingRuntime(): OutputRuntimeEnv;
export declare function writeRuntimeJson(runtime: RuntimeEnv | OutputRuntimeEnv, value: unknown, space?: number): void;
