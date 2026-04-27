import fs from "node:fs";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { resolveAuthStatePath } from "./paths.js";
function normalizeAuthProfileOrder(raw) {
    if (!raw || typeof raw !== "object") {
        return undefined;
    }
    const normalized = Object.entries(raw).reduce((acc, [provider, value]) => {
        if (!Array.isArray(value)) {
            return acc;
        }
        const list = value.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean);
        if (list.length > 0) {
            acc[provider] = list;
        }
        return acc;
    }, {});
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
export function coerceAuthProfileState(raw) {
    if (!raw || typeof raw !== "object") {
        return {};
    }
    const record = raw;
    return {
        order: normalizeAuthProfileOrder(record.order),
        lastGood: record.lastGood && typeof record.lastGood === "object"
            ? record.lastGood
            : undefined,
        usageStats: record.usageStats && typeof record.usageStats === "object"
            ? record.usageStats
            : undefined,
    };
}
export function mergeAuthProfileState(base, override) {
    const mergeRecord = (left, right) => {
        if (!left && !right) {
            return undefined;
        }
        if (!left) {
            return { ...right };
        }
        if (!right) {
            return { ...left };
        }
        return { ...left, ...right };
    };
    return {
        order: mergeRecord(base.order, override.order),
        lastGood: mergeRecord(base.lastGood, override.lastGood),
        usageStats: mergeRecord(base.usageStats, override.usageStats),
    };
}
export function loadPersistedAuthProfileState(agentDir) {
    return coerceAuthProfileState(loadJsonFile(resolveAuthStatePath(agentDir)));
}
export function buildPersistedAuthProfileState(store) {
    const state = coerceAuthProfileState(store);
    if (!state.order && !state.lastGood && !state.usageStats) {
        return null;
    }
    return {
        version: AUTH_STORE_VERSION,
        ...(state.order ? { order: state.order } : {}),
        ...(state.lastGood ? { lastGood: state.lastGood } : {}),
        ...(state.usageStats ? { usageStats: state.usageStats } : {}),
    };
}
export function savePersistedAuthProfileState(store, agentDir) {
    const payload = buildPersistedAuthProfileState(store);
    const statePath = resolveAuthStatePath(agentDir);
    if (!payload) {
        try {
            fs.unlinkSync(statePath);
        }
        catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
        return null;
    }
    saveJsonFile(statePath, payload);
    return payload;
}
