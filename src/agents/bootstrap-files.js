import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import { buildBootstrapContextFiles, resolveBootstrapMaxChars, resolveBootstrapTotalMaxChars, } from "./pi-embedded-helpers.js";
import { filterBootstrapFilesForSession, loadWorkspaceBootstrapFiles, } from "./workspace.js";
export function makeBootstrapWarn(params) {
    if (!params.warn) {
        return undefined;
    }
    return (message) => params.warn?.(`${message} (sessionKey=${params.sessionLabel})`);
}
function sanitizeBootstrapFiles(files, warn) {
    const sanitized = [];
    for (const file of files) {
        const pathValue = typeof file.path === "string" ? file.path.trim() : "";
        if (!pathValue) {
            warn?.(`skipping bootstrap file "${file.name}" — missing or invalid "path" field (hook may have used "filePath" instead)`);
            continue;
        }
        sanitized.push({ ...file, path: pathValue });
    }
    return sanitized;
}
function applyContextModeFilter(params) {
    const contextMode = params.contextMode ?? "full";
    const runKind = params.runKind ?? "default";
    if (contextMode !== "lightweight") {
        return params.files;
    }
    if (runKind === "heartbeat") {
        return params.files.filter((file) => file.name === "HEARTBEAT.md");
    }
    // cron/default lightweight mode keeps bootstrap context empty on purpose.
    return [];
}
export async function resolveBootstrapFilesForRun(params) {
    const sessionKey = params.sessionKey ?? params.sessionId;
    const rawFiles = params.sessionKey
        ? await getOrLoadBootstrapFiles({
            workspaceDir: params.workspaceDir,
            sessionKey: params.sessionKey,
        })
        : await loadWorkspaceBootstrapFiles(params.workspaceDir);
    const bootstrapFiles = applyContextModeFilter({
        files: filterBootstrapFilesForSession(rawFiles, sessionKey),
        contextMode: params.contextMode,
        runKind: params.runKind,
    });
    const updated = await applyBootstrapHookOverrides({
        files: bootstrapFiles,
        workspaceDir: params.workspaceDir,
        config: params.config,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        agentId: params.agentId,
    });
    return sanitizeBootstrapFiles(updated, params.warn);
}
export async function resolveBootstrapContextForRun(params) {
    const bootstrapFiles = await resolveBootstrapFilesForRun(params);
    const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
        maxChars: resolveBootstrapMaxChars(params.config),
        totalMaxChars: resolveBootstrapTotalMaxChars(params.config),
        warn: params.warn,
    });
    return { bootstrapFiles, contextFiles };
}
