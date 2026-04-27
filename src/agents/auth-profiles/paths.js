import fs from "node:fs";
import { saveJsonFile } from "../../infra/json-file.js";
import { AUTH_STORE_VERSION } from "./constants.js";
export { resolveAuthStatePath, resolveAuthStatePathForDisplay, resolveAuthStorePath, resolveAuthStorePathForDisplay, resolveLegacyAuthStorePath, resolveOAuthRefreshLockPath, } from "./path-resolve.js";
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
