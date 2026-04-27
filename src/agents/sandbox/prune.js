import { loadConfig } from "../../config/config.js";
import { stopBrowserBridgeServer } from "../../plugin-sdk/browser-bridge.js";
import { defaultRuntime } from "../../runtime.js";
import { getSandboxBackendManager } from "./backend.js";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import { dockerSandboxBackendManager } from "./docker-backend.js";
import { readBrowserRegistry, readRegistry, removeBrowserRegistryEntry, removeRegistryEntry, } from "./registry.js";
let lastPruneAtMs = 0;
function shouldPruneSandboxEntry(cfg, now, entry) {
    const idleHours = cfg.prune.idleHours;
    const maxAgeDays = cfg.prune.maxAgeDays;
    if (idleHours === 0 && maxAgeDays === 0) {
        return false;
    }
    const idleMs = now - entry.lastUsedAtMs;
    const ageMs = now - entry.createdAtMs;
    return ((idleHours > 0 && idleMs > idleHours * 60 * 60 * 1000) ||
        (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000));
}
async function pruneSandboxRegistryEntries(params) {
    const now = Date.now();
    if (params.cfg.prune.idleHours === 0 && params.cfg.prune.maxAgeDays === 0) {
        return;
    }
    const registry = await params.read();
    for (const entry of registry.entries) {
        if (!shouldPruneSandboxEntry(params.cfg, now, entry)) {
            continue;
        }
        try {
            await params.removeRuntime(entry);
        }
        catch {
            // ignore prune failures
        }
        finally {
            await params.remove(entry.containerName);
            await params.onRemoved?.(entry);
        }
    }
}
async function pruneSandboxContainers(cfg) {
    const config = loadConfig();
    await pruneSandboxRegistryEntries({
        cfg,
        read: readRegistry,
        remove: removeRegistryEntry,
        removeRuntime: async (entry) => {
            const manager = getSandboxBackendManager(entry.backendId ?? "docker");
            await manager?.removeRuntime({
                entry,
                config,
            });
        },
    });
}
async function pruneSandboxBrowsers(cfg) {
    const config = loadConfig();
    await pruneSandboxRegistryEntries({
        cfg,
        read: readBrowserRegistry,
        remove: removeBrowserRegistryEntry,
        removeRuntime: async (entry) => {
            await dockerSandboxBackendManager.removeRuntime({
                entry: {
                    ...entry,
                    backendId: "docker",
                    runtimeLabel: entry.containerName,
                    configLabelKind: "Image",
                },
                config,
            });
        },
        onRemoved: async (entry) => {
            const bridge = BROWSER_BRIDGES.get(entry.sessionKey);
            if (bridge?.containerName === entry.containerName) {
                await stopBrowserBridgeServer(bridge.bridge.server).catch(() => undefined);
                BROWSER_BRIDGES.delete(entry.sessionKey);
            }
        },
    });
}
export async function maybePruneSandboxes(cfg) {
    const now = Date.now();
    if (now - lastPruneAtMs < 5 * 60 * 1000) {
        return;
    }
    lastPruneAtMs = now;
    try {
        await pruneSandboxContainers(cfg);
        await pruneSandboxBrowsers(cfg);
    }
    catch (error) {
        const message = error instanceof Error
            ? error.message
            : typeof error === "string"
                ? error
                : JSON.stringify(error);
        defaultRuntime.error?.(`Sandbox prune failed: ${message ?? "unknown error"}`);
    }
}
