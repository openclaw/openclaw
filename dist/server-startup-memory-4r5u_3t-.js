import "./agent-scope-CtLXGcWm.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, n as listAgentIds, t as listAgentEntries } from "./agent-scope-config-CMp71_27.js";
import { r as getActiveMemorySearchManager } from "./memory-runtime-DxsWIMOy.js";
import { t as resolveMemorySearchConfig } from "./memory-search-BEQRq9yG.js";
import { t as resolveMemoryBackendConfig } from "./backend-config-9Mpek5eW.js";
//#region src/gateway/server-startup-memory.ts
function shouldRunQmdStartupBootSync(qmd) {
	return qmd.update.onBoot && qmd.update.startup !== "off";
}
function hasExplicitAgentMemorySearchConfig(cfg, agentId) {
	return listAgentEntries(cfg).some((entry) => normalizeAgentId(entry.id) === agentId && entry.memorySearch != null);
}
function shouldEagerlyStartAgentMemory(params) {
	if (params.agentCount <= 1) return true;
	if (params.agentId === resolveDefaultAgentId(params.cfg)) return true;
	if (params.cfg.agents?.defaults?.memorySearch?.enabled === true) return true;
	return hasExplicitAgentMemorySearchConfig(params.cfg, params.agentId);
}
async function startGatewayMemoryBackend(params) {
	const agentIds = listAgentIds(params.cfg);
	const armedAgentIds = [];
	const deferredAgentIds = [];
	for (const agentId of agentIds) {
		if (!resolveMemorySearchConfig(params.cfg, agentId)) continue;
		const resolved = resolveMemoryBackendConfig({
			cfg: params.cfg,
			agentId
		});
		if (!resolved) continue;
		if (resolved.backend !== "qmd" || !resolved.qmd) continue;
		if (!shouldRunQmdStartupBootSync(resolved.qmd)) continue;
		if (!shouldEagerlyStartAgentMemory({
			cfg: params.cfg,
			agentId,
			agentCount: agentIds.length
		})) {
			deferredAgentIds.push(agentId);
			continue;
		}
		const { manager, error } = await getActiveMemorySearchManager({
			cfg: params.cfg,
			agentId,
			purpose: "cli"
		});
		if (!manager) {
			params.log.warn(`qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`);
			continue;
		}
		try {
			await manager.sync?.({
				reason: "boot",
				force: true
			});
		} catch (err) {
			params.log.warn(`qmd memory startup boot sync failed for agent "${agentId}": ${String(err)}`);
			continue;
		} finally {
			await manager.close?.().catch((err) => {
				params.log.warn(`qmd memory startup manager close failed for agent "${agentId}": ${String(err)}`);
			});
		}
		armedAgentIds.push(agentId);
	}
	if (armedAgentIds.length > 0) params.log.info?.(`qmd memory startup boot sync completed for ${formatAgentCount(armedAgentIds.length)}: ${armedAgentIds.map((agentId) => `"${agentId}"`).join(", ")}`);
	if (deferredAgentIds.length > 0) params.log.info?.(`qmd memory startup initialization deferred for ${formatAgentCount(deferredAgentIds.length)}: ${deferredAgentIds.map((agentId) => `"${agentId}"`).join(", ")}`);
}
function formatAgentCount(count) {
	return count === 1 ? "1 agent" : `${count} agents`;
}
//#endregion
export { startGatewayMemoryBackend };
