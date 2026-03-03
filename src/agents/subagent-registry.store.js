import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
const REGISTRY_VERSION = 2;
function resolveSubagentStateDir(env = process.env) {
    const explicit = env.OPENCLAW_STATE_DIR?.trim();
    if (explicit) {
        return resolveStateDir(env);
    }
    if (env.VITEST || env.NODE_ENV === "test") {
        return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid));
    }
    return resolveStateDir(env);
}
export function resolveSubagentRegistryPath() {
    return path.join(resolveSubagentStateDir(process.env), "subagents", "runs.json");
}
export function loadSubagentRegistryFromDisk() {
    const pathname = resolveSubagentRegistryPath();
    const raw = loadJsonFile(pathname);
    if (!raw || typeof raw !== "object") {
        return new Map();
    }
    const record = raw;
    if (record.version !== 1 && record.version !== 2) {
        return new Map();
    }
    const runsRaw = record.runs;
    if (!runsRaw || typeof runsRaw !== "object") {
        return new Map();
    }
    const out = new Map();
    const isLegacy = record.version === 1;
    let migrated = false;
    for (const [runId, entry] of Object.entries(runsRaw)) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const typed = entry;
        if (!typed.runId || typeof typed.runId !== "string") {
            continue;
        }
        const legacyCompletedAt = isLegacy && typeof typed.announceCompletedAt === "number"
            ? typed.announceCompletedAt
            : undefined;
        const cleanupCompletedAt = typeof typed.cleanupCompletedAt === "number" ? typed.cleanupCompletedAt : legacyCompletedAt;
        const cleanupHandled = typeof typed.cleanupHandled === "boolean"
            ? typed.cleanupHandled
            : isLegacy
                ? Boolean(typed.announceHandled ?? cleanupCompletedAt)
                : undefined;
        const requesterOrigin = normalizeDeliveryContext(typed.requesterOrigin ?? {
            channel: typeof typed.requesterChannel === "string" ? typed.requesterChannel : undefined,
            accountId: typeof typed.requesterAccountId === "string" ? typed.requesterAccountId : undefined,
        });
        const { announceCompletedAt: _announceCompletedAt, announceHandled: _announceHandled, requesterChannel: _channel, requesterAccountId: _accountId, ...rest } = typed;
        out.set(runId, {
            ...rest,
            requesterOrigin,
            cleanupCompletedAt,
            cleanupHandled,
            spawnMode: typed.spawnMode === "session" ? "session" : "run",
        });
        if (isLegacy) {
            migrated = true;
        }
    }
    if (migrated) {
        try {
            saveSubagentRegistryToDisk(out);
        }
        catch {
            // ignore migration write failures
        }
    }
    return out;
}
export function saveSubagentRegistryToDisk(runs) {
    const pathname = resolveSubagentRegistryPath();
    const serialized = {};
    for (const [runId, entry] of runs.entries()) {
        serialized[runId] = entry;
    }
    const out = {
        version: REGISTRY_VERSION,
        runs: serialized,
    };
    saveJsonFile(pathname, out);
}
