import fs from "node:fs/promises";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import { shouldIncludeHeartbeatGuidanceForSystemPrompt } from "./heartbeat-system-prompt.js";
import { buildBootstrapContextFiles, resolveBootstrapMaxChars, resolveBootstrapTotalMaxChars, } from "./pi-embedded-helpers.js";
import { DEFAULT_HEARTBEAT_FILENAME, filterBootstrapFilesForSession, isWorkspaceBootstrapPending, loadWorkspaceBootstrapFiles, } from "./workspace.js";
const CONTINUATION_SCAN_MAX_TAIL_BYTES = 256 * 1024;
const CONTINUATION_SCAN_MAX_RECORDS = 500;
export const FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE = "openclaw:bootstrap-context:full";
const BOOTSTRAP_WARNING_DEDUPE_LIMIT = 1024;
const seenBootstrapWarnings = new Set();
const bootstrapWarningOrder = [];
function rememberBootstrapWarning(key) {
    if (seenBootstrapWarnings.has(key)) {
        return false;
    }
    if (seenBootstrapWarnings.size >= BOOTSTRAP_WARNING_DEDUPE_LIMIT) {
        const oldest = bootstrapWarningOrder.shift();
        if (oldest) {
            seenBootstrapWarnings.delete(oldest);
        }
    }
    seenBootstrapWarnings.add(key);
    bootstrapWarningOrder.push(key);
    return true;
}
export function _resetBootstrapWarningCacheForTest() {
    seenBootstrapWarnings.clear();
    bootstrapWarningOrder.length = 0;
}
export function resolveContextInjectionMode(config) {
    return config?.agents?.defaults?.contextInjection ?? "always";
}
export async function hasCompletedBootstrapTurn(sessionFile) {
    try {
        const stat = await fs.lstat(sessionFile);
        if (stat.isSymbolicLink()) {
            return false;
        }
        const fh = await fs.open(sessionFile, "r");
        try {
            const bytesToRead = Math.min(stat.size, CONTINUATION_SCAN_MAX_TAIL_BYTES);
            if (bytesToRead <= 0) {
                return false;
            }
            const start = stat.size - bytesToRead;
            const buffer = Buffer.allocUnsafe(bytesToRead);
            const { bytesRead } = await fh.read(buffer, 0, bytesToRead, start);
            let text = buffer.toString("utf-8", 0, bytesRead);
            if (start > 0) {
                const firstNewline = text.indexOf("\n");
                if (firstNewline === -1) {
                    return false;
                }
                text = text.slice(firstNewline + 1);
            }
            const records = text
                .split(/\r?\n/u)
                .filter((line) => line.trim().length > 0)
                .slice(-CONTINUATION_SCAN_MAX_RECORDS);
            let compactedAfterLatestAssistant = false;
            for (let i = records.length - 1; i >= 0; i--) {
                const line = records[i];
                if (!line) {
                    continue;
                }
                let entry;
                try {
                    entry = JSON.parse(line);
                }
                catch {
                    continue;
                }
                const record = entry;
                if (record?.type === "compaction") {
                    compactedAfterLatestAssistant = true;
                    continue;
                }
                if (record?.type === "custom" &&
                    record.customType === FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE) {
                    return !compactedAfterLatestAssistant;
                }
            }
            return false;
        }
        finally {
            await fh.close();
        }
    }
    catch {
        return false;
    }
}
export function makeBootstrapWarn(params) {
    const warn = params.warn;
    if (!warn) {
        return undefined;
    }
    const workspacePrefix = params.workspaceDir ?? "";
    return (message) => {
        const key = `${workspacePrefix}\u0000${params.sessionLabel}\u0000${message}`;
        if (!rememberBootstrapWarning(key)) {
            return;
        }
        warn(`${message} (sessionKey=${params.sessionLabel})`);
    };
}
function sanitizeBootstrapFiles(files, warn) {
    const sanitized = [];
    for (const file of files) {
        const pathValue = normalizeOptionalString(file.path) ?? "";
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
function shouldExcludeHeartbeatBootstrapFile(params) {
    if (!params.config || params.runKind === "heartbeat") {
        return false;
    }
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
        sessionKey: params.sessionKey ?? params.sessionId,
        config: params.config,
        agentId: params.agentId,
    });
    if (sessionAgentId !== defaultAgentId) {
        return false;
    }
    return !shouldIncludeHeartbeatGuidanceForSystemPrompt({
        config: params.config,
        agentId: sessionAgentId,
        defaultAgentId,
    });
}
function filterHeartbeatBootstrapFile(files, excludeHeartbeatBootstrapFile) {
    if (!excludeHeartbeatBootstrapFile) {
        return files;
    }
    return files.filter((file) => file.name !== DEFAULT_HEARTBEAT_FILENAME);
}
export async function resolveBootstrapFilesForRun(params) {
    const excludeHeartbeatBootstrapFile = shouldExcludeHeartbeatBootstrapFile(params);
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
    return sanitizeBootstrapFiles(filterHeartbeatBootstrapFile(updated, excludeHeartbeatBootstrapFile), params.warn);
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
export { isWorkspaceBootstrapPending };
