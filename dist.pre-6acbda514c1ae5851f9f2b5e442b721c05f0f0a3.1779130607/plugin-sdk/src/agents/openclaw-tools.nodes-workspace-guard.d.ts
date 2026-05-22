import type { ToolFsPolicy } from "./tool-fs-policy.js";
import type { AnyAgentTool } from "./tools/common.js";
export declare function applyNodesToolWorkspaceGuard(nodesToolBase: AnyAgentTool, options: {
    fsPolicy?: ToolFsPolicy;
    sandboxContainerWorkdir?: string;
    sandboxRoot?: string;
    workspaceDir: string;
}): AnyAgentTool;
