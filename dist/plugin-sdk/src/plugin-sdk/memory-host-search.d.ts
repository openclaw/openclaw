import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RegisteredMemorySearchManager } from "../plugins/memory-state.js";
type ActiveMemorySearchPurpose = "default" | "status";
export type ActiveMemorySearchManagerResult = {
    manager: RegisteredMemorySearchManager | null;
    error?: string;
};
export declare function getActiveMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: ActiveMemorySearchPurpose;
}): Promise<ActiveMemorySearchManagerResult>;
export declare function closeActiveMemorySearchManagers(cfg?: OpenClawConfig): Promise<void>;
export {};
