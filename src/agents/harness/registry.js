import { createSubsystemLogger } from "../../logging/subsystem.js";
const AGENT_HARNESS_REGISTRY_STATE = Symbol.for("openclaw.agentHarnessRegistryState");
const log = createSubsystemLogger("agents/harness");
function getAgentHarnessRegistryState() {
    const globalState = globalThis;
    globalState[AGENT_HARNESS_REGISTRY_STATE] ??= {
        harnesses: new Map(),
    };
    return globalState[AGENT_HARNESS_REGISTRY_STATE];
}
export function registerAgentHarness(harness, options) {
    const id = harness.id.trim();
    getAgentHarnessRegistryState().harnesses.set(id, {
        harness: {
            ...harness,
            id,
            pluginId: harness.pluginId ?? options?.ownerPluginId,
        },
        ownerPluginId: options?.ownerPluginId,
    });
}
export function getAgentHarness(id) {
    return getRegisteredAgentHarness(id)?.harness;
}
export function getRegisteredAgentHarness(id) {
    return getAgentHarnessRegistryState().harnesses.get(id.trim());
}
export function listAgentHarnessIds() {
    return [...getAgentHarnessRegistryState().harnesses.keys()];
}
export function listRegisteredAgentHarnesses() {
    return Array.from(getAgentHarnessRegistryState().harnesses.values());
}
export function clearAgentHarnesses() {
    getAgentHarnessRegistryState().harnesses.clear();
}
export function restoreRegisteredAgentHarnesses(entries) {
    const map = getAgentHarnessRegistryState().harnesses;
    map.clear();
    for (const entry of entries) {
        map.set(entry.harness.id, entry);
    }
}
export async function resetRegisteredAgentHarnessSessions(params) {
    await Promise.all(listRegisteredAgentHarnesses().map(async (entry) => {
        if (!entry.harness.reset) {
            return;
        }
        try {
            await entry.harness.reset(params);
        }
        catch (error) {
            log.warn(`${entry.harness.label} session reset hook failed`, {
                harnessId: entry.harness.id,
                error,
            });
        }
    }));
}
export async function disposeRegisteredAgentHarnesses() {
    await Promise.all(listRegisteredAgentHarnesses().map(async (entry) => {
        if (!entry.harness.dispose) {
            return;
        }
        try {
            await entry.harness.dispose();
        }
        catch (error) {
            log.warn(`${entry.harness.label} dispose hook failed`, {
                harnessId: entry.harness.id,
                error,
            });
        }
    }));
}
