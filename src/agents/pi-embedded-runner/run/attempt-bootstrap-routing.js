import { resolveBootstrapMode } from "../../bootstrap-mode.js";
import { buildAgentUserPromptPrefix } from "../../system-prompt.js";
export function shouldStripBootstrapFromEmbeddedContext(_params) {
    return true;
}
export function resolveAttemptBootstrapRouting(params) {
    const bootstrapMode = resolveBootstrapMode({
        bootstrapPending: params.workspaceBootstrapPending,
        runKind: params.bootstrapContextRunKind ?? "default",
        isInteractiveUserFacing: params.trigger === "user" || params.trigger === "manual",
        isPrimaryRun: params.isPrimaryRun,
        isCanonicalWorkspace: (params.isCanonicalWorkspace ?? true) &&
            params.effectiveWorkspace === params.resolvedWorkspace,
        hasBootstrapFileAccess: params.hasBootstrapFileAccess,
    });
    return {
        bootstrapMode,
        shouldStripBootstrapFromContext: shouldStripBootstrapFromEmbeddedContext({
            bootstrapMode,
        }),
        userPromptPrefixText: buildAgentUserPromptPrefix({
            bootstrapMode,
        }),
    };
}
export async function resolveAttemptWorkspaceBootstrapRouting(params) {
    const workspaceBootstrapPending = await params.isWorkspaceBootstrapPending(params.resolvedWorkspace);
    return resolveAttemptBootstrapRouting({
        ...params,
        workspaceBootstrapPending,
    });
}
