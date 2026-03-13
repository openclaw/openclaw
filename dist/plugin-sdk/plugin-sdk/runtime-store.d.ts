export declare function createPluginRuntimeStore<T>(errorMessage: string): {
    setRuntime: (next: T) => void;
    clearRuntime: () => void;
    tryGetRuntime: () => T | null;
    getRuntime: () => T;
};
