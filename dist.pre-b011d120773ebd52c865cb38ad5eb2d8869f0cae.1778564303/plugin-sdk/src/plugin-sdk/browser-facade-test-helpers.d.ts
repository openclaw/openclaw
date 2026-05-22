import { vi } from "vitest";
type FacadeLoaderMock = ReturnType<typeof vi.fn>;
type ChromeExecutableFixture = {
    kind: string;
    path: string;
};
export declare function mockBrowserHostInspectionFacade(loadBundledPluginPublicSurfaceModuleSync: FacadeLoaderMock, executable: ChromeExecutableFixture): void;
export declare function expectBrowserHostInspectionDelegation(params: {
    executable: ChromeExecutableFixture;
    hostInspection: typeof import("./browser-host-inspection.js");
    loadBundledPluginPublicSurfaceModuleSync: FacadeLoaderMock;
}): void;
export declare function expectBrowserHostInspectionFacadeUnavailable(loadBundledPluginPublicSurfaceModuleSync: FacadeLoaderMock): Promise<void>;
export {};
