import type { AcpRuntime } from "./types.js";
export type AcpRuntimeBackend = {
    id: string;
    runtime: AcpRuntime;
    healthy?: () => boolean;
};
type AcpRuntimeRegistryGlobalState = {
    backendsById: Map<string, AcpRuntimeBackend>;
};
export declare function registerAcpRuntimeBackend(backend: AcpRuntimeBackend): void;
export declare function unregisterAcpRuntimeBackend(id: string): void;
export declare function getAcpRuntimeBackend(id?: string): AcpRuntimeBackend | null;
export declare function requireAcpRuntimeBackend(id?: string): AcpRuntimeBackend;
export declare const __testing: {
    resetAcpRuntimeBackendsForTests(): void;
    getAcpRuntimeRegistryGlobalStateForTests(): AcpRuntimeRegistryGlobalState;
};
export {};
