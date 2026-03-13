import { type OpenClawConfig } from "../../config/config.js";
import { resolveThreadBindingThreadName } from "./thread-bindings.messages.js";
import { resolveThreadBindingsPath, resetThreadBindingsForTests } from "./thread-bindings.state.js";
import { type ThreadBindingManager } from "./thread-bindings.types.js";
export declare function createThreadBindingManager(params?: {
    accountId?: string;
    token?: string;
    cfg?: OpenClawConfig;
    persist?: boolean;
    enableSweeper?: boolean;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
}): ThreadBindingManager;
export declare function createNoopThreadBindingManager(accountId?: string): ThreadBindingManager;
export declare function getThreadBindingManager(accountId?: string): ThreadBindingManager | null;
export declare const __testing: {
    resolveThreadBindingsPath: typeof resolveThreadBindingsPath;
    resolveThreadBindingThreadName: typeof resolveThreadBindingThreadName;
    resetThreadBindingsForTests: typeof resetThreadBindingsForTests;
};
