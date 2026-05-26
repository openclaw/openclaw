import type { RuntimeEnv } from "../runtime.js";
type FacadeModule = {
    ensureMatrixSdkInstalled: (params: {
        runtime: RuntimeEnv;
        confirm?: (message: string) => Promise<boolean>;
    }) => Promise<void>;
    isMatrixSdkAvailable: () => boolean;
};
export declare const ensureMatrixSdkInstalled: FacadeModule["ensureMatrixSdkInstalled"];
export declare const isMatrixSdkAvailable: FacadeModule["isMatrixSdkAvailable"];
export {};
