import { wrapToolWorkspaceRootGuardWithOptions } from "./pi-tools.read.js";
export function applyNodesToolWorkspaceGuard(nodesToolBase, options) {
    if (options.fsPolicy?.workspaceOnly !== true) {
        return nodesToolBase;
    }
    return wrapToolWorkspaceRootGuardWithOptions(nodesToolBase, options.sandboxRoot ?? options.workspaceDir, {
        containerWorkdir: options.sandboxContainerWorkdir,
        normalizeGuardedPathParams: true,
        pathParamKeys: ["outPath"],
    });
}
