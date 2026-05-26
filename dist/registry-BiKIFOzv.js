import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
//#region src/agents/harness/registry.ts
const AGENT_HARNESS_REGISTRY_STATE = Symbol.for("openclaw.agentHarnessRegistryState");
const log = createSubsystemLogger("agents/harness");
function getAgentHarnessRegistryState() {
	const globalState = globalThis;
	globalState[AGENT_HARNESS_REGISTRY_STATE] ??= { harnesses: /* @__PURE__ */ new Map() };
	return globalState[AGENT_HARNESS_REGISTRY_STATE];
}
function registerAgentHarness(harness, options) {
	const id = harness.id.trim();
	getAgentHarnessRegistryState().harnesses.set(id, {
		harness: {
			...harness,
			id,
			pluginId: harness.pluginId ?? options?.ownerPluginId
		},
		ownerPluginId: options?.ownerPluginId
	});
}
function getRegisteredAgentHarness(id) {
	return getAgentHarnessRegistryState().harnesses.get(id.trim());
}
function listAgentHarnessIds() {
	return [...getAgentHarnessRegistryState().harnesses.keys()];
}
function listRegisteredAgentHarnesses() {
	return Array.from(getAgentHarnessRegistryState().harnesses.values());
}
function clearAgentHarnesses() {
	getAgentHarnessRegistryState().harnesses.clear();
}
function restoreRegisteredAgentHarnesses(entries) {
	const map = getAgentHarnessRegistryState().harnesses;
	map.clear();
	for (const entry of entries) map.set(entry.harness.id, entry);
}
async function resetRegisteredAgentHarnessSessions(params) {
	await Promise.all(listRegisteredAgentHarnesses().map(async (entry) => {
		if (!entry.harness.reset) return;
		try {
			await entry.harness.reset(params);
		} catch (error) {
			log.warn(`${entry.harness.label} session reset hook failed`, {
				harnessId: entry.harness.id,
				error
			});
		}
	}));
}
async function disposeRegisteredAgentHarnesses() {
	await Promise.all(listRegisteredAgentHarnesses().map(async (entry) => {
		if (!entry.harness.dispose) return;
		try {
			await entry.harness.dispose();
		} catch (error) {
			log.warn(`${entry.harness.label} dispose hook failed`, {
				harnessId: entry.harness.id,
				error
			});
		}
	}));
}
//#endregion
export { listRegisteredAgentHarnesses as a, restoreRegisteredAgentHarnesses as c, listAgentHarnessIds as i, disposeRegisteredAgentHarnesses as n, registerAgentHarness as o, getRegisteredAgentHarness as r, resetRegisteredAgentHarnessSessions as s, clearAgentHarnesses as t };
