import { vi } from "vitest";
type QaRuntimeModule = {
    loadQaRuntimeModule: () => unknown;
};
type SurfaceLoaderMock = ReturnType<typeof vi.fn>;
export declare function cleanupTempDirs(tempDirs: string[]): void;
export declare function restorePrivateQaCliEnv(originalPrivateQaCli: string | undefined): void;
export declare function makePrivateQaSourceRoot(tempDirs: string[], prefix: string): string;
export declare function expectQaLabRuntimeSurfaceLoad(params: {
    importRuntime: () => Promise<QaRuntimeModule>;
    loadBundledPluginPublicSurfaceModuleSync: SurfaceLoaderMock;
}): Promise<void>;
export declare function expectPrivateQaLabRuntimeSurfaceLoad(params: {
    tempDirs: string[];
    importRuntime: () => Promise<QaRuntimeModule>;
    loadBundledPluginPublicSurfaceModuleSync: SurfaceLoaderMock;
    resolveOpenClawPackageRootSync: SurfaceLoaderMock;
}): Promise<void>;
export {};
