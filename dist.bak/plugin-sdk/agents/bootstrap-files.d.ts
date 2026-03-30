import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { type WorkspaceBootstrapFile } from "./workspace.js";
export declare function makeBootstrapWarn(params: {
    sessionLabel: string;
    warn?: (message: string) => void;
}): ((message: string) => void) | undefined;
export declare function resolveBootstrapFilesForRun(params: {
    workspaceDir: string;
    config?: OpenClawConfig;
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    warn?: (message: string) => void;
}): Promise<WorkspaceBootstrapFile[]>;
export declare function resolveBootstrapContextForRun(params: {
    workspaceDir: string;
    config?: OpenClawConfig;
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    warn?: (message: string) => void;
}): Promise<{
    bootstrapFiles: WorkspaceBootstrapFile[];
    contextFiles: EmbeddedContextFile[];
}>;
