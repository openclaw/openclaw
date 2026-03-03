import fs from "node:fs";
import path from "node:path";
import { saveJsonFile } from "../../infra/json-file.js";
import { resolveUserPath } from "../../utils.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { AUTH_PROFILE_FILENAME, AUTH_STORE_VERSION, LEGACY_AUTH_FILENAME } from "./constants.js";
export function resolveAuthStorePath(agentDir) {
    const resolved = resolveUserPath(agentDir ?? resolveOpenClawAgentDir());
    return path.join(resolved, AUTH_PROFILE_FILENAME);
}
export function resolveLegacyAuthStorePath(agentDir) {
    const resolved = resolveUserPath(agentDir ?? resolveOpenClawAgentDir());
    return path.join(resolved, LEGACY_AUTH_FILENAME);
}
export function resolveAuthStorePathForDisplay(agentDir) {
    const pathname = resolveAuthStorePath(agentDir);
    return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}
export function ensureAuthStoreFile(pathname) {
    if (fs.existsSync(pathname)) {
        return;
    }
    const payload = {
        version: AUTH_STORE_VERSION,
        profiles: {},
    };
    saveJsonFile(pathname, payload);
}
