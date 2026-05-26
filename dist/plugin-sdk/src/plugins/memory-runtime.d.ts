import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function getActiveMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status" | "cli";
}): Promise<{
    manager: import("./memory-state.js").RegisteredMemorySearchManager | null;
    error?: string;
}>;
export declare function resolveActiveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
}): import("./memory-state.js").MemoryRuntimeBackendConfig | null;
export declare function closeActiveMemorySearchManagers(cfg?: OpenClawConfig): Promise<void>;
