import type { OptionalBootstrapFileName } from "../../config/types.agent-defaults.js";
export declare function ensureSandboxWorkspace(workspaceDir: string, seedFrom?: string, skipBootstrap?: boolean, skipOptionalBootstrapFiles?: OptionalBootstrapFileName[]): Promise<void>;
