type MockFactory<TModule extends object> = Partial<TModule> | ((actual: TModule) => Partial<TModule>);
export declare function mockNodeBuiltinModule<TModule extends object>(loadActual: () => Promise<TModule>, factory: MockFactory<TModule>, options?: {
    mirrorToDefault?: boolean;
}): Promise<TModule>;
export declare function mockNodeChildProcessSpawnSync(spawnSync: (...args: unknown[]) => unknown): Promise<typeof import("node:child_process")>;
export declare function mockNodeChildProcessExecFile(execFile: typeof import("node:child_process").execFile): Promise<typeof import("node:child_process")>;
export {};
