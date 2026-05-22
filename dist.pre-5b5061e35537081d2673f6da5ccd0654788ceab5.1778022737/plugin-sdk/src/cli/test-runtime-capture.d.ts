import type { OutputRuntimeEnv } from "../runtime.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
export type CliMockOutputRuntime = OutputRuntimeEnv & {
    log: MockFn<OutputRuntimeEnv["log"]>;
    error: MockFn<OutputRuntimeEnv["error"]>;
    exit: MockFn<OutputRuntimeEnv["exit"]>;
    writeJson: MockFn<OutputRuntimeEnv["writeJson"]>;
    writeStdout: MockFn<OutputRuntimeEnv["writeStdout"]>;
};
export type CliRuntimeCapture = {
    runtimeLogs: string[];
    runtimeErrors: string[];
    defaultRuntime: CliMockOutputRuntime;
    resetRuntimeCapture: () => void;
};
type MockCallsWithFirstArg = {
    mock: {
        calls: Array<[unknown, ...unknown[]]>;
    };
};
export declare function createCliRuntimeCapture(): CliRuntimeCapture;
export declare function mockRuntimeModule<TModule extends {
    defaultRuntime: OutputRuntimeEnv;
}>(loadActual: () => Promise<TModule>, defaultRuntime: TModule["defaultRuntime"]): Promise<TModule>;
export declare function spyRuntimeLogs(runtime: Pick<OutputRuntimeEnv, "log">): import("vitest").Mock<(...args: unknown[]) => void>;
export declare function spyRuntimeErrors(runtime: Pick<OutputRuntimeEnv, "error">): import("vitest").Mock<(...args: unknown[]) => void>;
export declare function spyRuntimeJson(runtime: Pick<OutputRuntimeEnv, "writeJson">): import("vitest").Mock<(value: unknown, space?: number) => void>;
export declare function firstWrittenJsonArg<T>(writeJson: MockCallsWithFirstArg): T | null;
export {};
