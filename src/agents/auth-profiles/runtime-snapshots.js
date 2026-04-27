import { resolveAuthStorePath } from "./path-resolve.js";
const runtimeAuthStoreSnapshots = new Map();
function resolveRuntimeStoreKey(agentDir) {
    return resolveAuthStorePath(agentDir);
}
function cloneAuthProfileStore(store) {
    return structuredClone(store);
}
export function getRuntimeAuthProfileStoreSnapshot(agentDir) {
    const store = runtimeAuthStoreSnapshots.get(resolveRuntimeStoreKey(agentDir));
    return store ? cloneAuthProfileStore(store) : undefined;
}
export function hasRuntimeAuthProfileStoreSnapshot(agentDir) {
    return runtimeAuthStoreSnapshots.has(resolveRuntimeStoreKey(agentDir));
}
export function hasAnyRuntimeAuthProfileStoreSource(agentDir) {
    const requestedStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
    if (requestedStore && Object.keys(requestedStore.profiles).length > 0) {
        return true;
    }
    if (!agentDir) {
        return false;
    }
    const mainStore = getRuntimeAuthProfileStoreSnapshot();
    return Boolean(mainStore && Object.keys(mainStore.profiles).length > 0);
}
export function replaceRuntimeAuthProfileStoreSnapshots(entries) {
    runtimeAuthStoreSnapshots.clear();
    for (const entry of entries) {
        runtimeAuthStoreSnapshots.set(resolveRuntimeStoreKey(entry.agentDir), cloneAuthProfileStore(entry.store));
    }
}
export function clearRuntimeAuthProfileStoreSnapshots() {
    runtimeAuthStoreSnapshots.clear();
}
export function setRuntimeAuthProfileStoreSnapshot(store, agentDir) {
    runtimeAuthStoreSnapshots.set(resolveRuntimeStoreKey(agentDir), cloneAuthProfileStore(store));
}
