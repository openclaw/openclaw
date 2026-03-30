import { type WorkspaceBootstrapFile } from "./workspace.js";
export declare function getOrLoadBootstrapFiles(params: {
    workspaceDir: string;
    sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]>;
export declare function clearBootstrapSnapshot(sessionKey: string): void;
export declare function clearAllBootstrapSnapshots(): void;
