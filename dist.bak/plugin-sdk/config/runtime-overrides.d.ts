import type { OpenClawConfig } from "./types.js";
type OverrideTree = Record<string, unknown>;
export declare function getConfigOverrides(): OverrideTree;
export declare function resetConfigOverrides(): void;
export declare function setConfigOverride(pathRaw: string, value: unknown): {
    ok: boolean;
    error?: string;
};
export declare function unsetConfigOverride(pathRaw: string): {
    ok: boolean;
    removed: boolean;
    error?: string;
};
export declare function applyConfigOverrides(cfg: OpenClawConfig): OpenClawConfig;
export {};
