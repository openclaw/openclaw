import { isWorkspaceSetupCompleted } from "../../agents/workspace.js";
import { root } from "../../infra/fs-safe.js";
import type { GatewayRequestHandlers } from "./types.js";
export declare const __testing: {
    setDepsForTests(overrides: Partial<{
        root: typeof root;
        isWorkspaceSetupCompleted: typeof isWorkspaceSetupCompleted;
    }>): void;
    resetDepsForTests(): void;
};
export declare const agentsHandlers: GatewayRequestHandlers;
