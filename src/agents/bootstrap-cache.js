import { loadWorkspaceBootstrapFiles } from "./workspace.js";
const cache = new Map();
export async function getOrLoadBootstrapFiles(params) {
    const existing = cache.get(params.sessionKey);
    if (existing) {
        return existing;
    }
    const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
    cache.set(params.sessionKey, files);
    return files;
}
export function clearBootstrapSnapshot(sessionKey) {
    cache.delete(sessionKey);
}
export function clearAllBootstrapSnapshots() {
    cache.clear();
}
