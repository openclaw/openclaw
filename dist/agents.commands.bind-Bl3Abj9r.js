import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import "./agent-scope-CtLXGcWm.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, t as listAgentEntries } from "./agent-scope-config-CMp71_27.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { i as listRouteBindings, t as isRouteBinding } from "./bindings-D1F1bOgs.js";
import { r as logConfigUpdated } from "./logging-t-RUPR6R.js";
import { t as describeBinding } from "./agents.binding-format-B_OLxIww.js";
import { n as requireValidConfig, r as requireValidConfigFileSnapshot } from "./agents.command-shared-at9V0DWB.js";
//#region src/commands/agents.commands.bind.ts
const agentBindingsModuleLoader = createLazyImportLoader(() => import("./agents.bindings-CKOkzFEa.js"));
function loadAgentBindingsModule() {
	return agentBindingsModuleLoader.load();
}
function resolveAgentId(cfg, agentInput, params) {
	if (!cfg) return null;
	if (agentInput?.trim()) return normalizeAgentId(agentInput);
	if (params?.fallbackToDefault) return resolveDefaultAgentId(cfg);
	return null;
}
function hasAgent(cfg, agentId) {
	if (!cfg) return false;
	const targetAgentId = normalizeAgentId(agentId);
	const agents = listAgentEntries(cfg);
	if (agents.length === 0) return targetAgentId === normalizeAgentId(resolveDefaultAgentId(cfg));
	return agents.some((agent) => normalizeAgentId(agent.id) === targetAgentId);
}
function formatBindingOwnerLine(binding) {
	return `${normalizeAgentId(binding.agentId)} <- ${describeBinding(binding)}`;
}
function resolveTargetAgentIdOrExit(params) {
	const agentId = resolveAgentId(params.cfg, params.agentInput?.trim(), { fallbackToDefault: true });
	if (!agentId) {
		params.runtime.error(`Unable to resolve agent id. Run ${formatCliCommand("openclaw agents list")} to choose one.`);
		params.runtime.exit(1);
		return null;
	}
	if (!hasAgent(params.cfg, agentId)) {
		params.runtime.error(`Agent "${agentId}" not found. Run ${formatCliCommand("openclaw agents list")} to see configured agents.`);
		params.runtime.exit(1);
		return null;
	}
	return agentId;
}
function formatBindingConflicts(conflicts) {
	return conflicts.map((conflict) => `${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`);
}
async function resolveParsedBindingsOrExit(params) {
	const specs = (params.bindValues ?? []).map((value) => value.trim()).filter(Boolean);
	if (specs.length === 0) {
		params.runtime.error(params.emptyMessage);
		params.runtime.exit(1);
		return null;
	}
	const { parseBindingSpecs } = await loadAgentBindingsModule();
	const parsed = parseBindingSpecs({
		agentId: params.agentId,
		specs,
		config: params.cfg
	});
	if (parsed.errors.length > 0) {
		params.runtime.error(parsed.errors.join("\n"));
		params.runtime.exit(1);
		return null;
	}
	return parsed;
}
function emitJsonPayload(params) {
	if (!params.json) return false;
	writeRuntimeJson(params.runtime, params.payload);
	if ((params.conflictCount ?? 0) > 0) params.runtime.exit(1);
	return true;
}
async function resolveConfigAndTargetAgentIdOrExit(params) {
	const configSnapshot = await requireValidConfigFileSnapshot(params.runtime);
	if (!configSnapshot) return null;
	const cfg = configSnapshot.sourceConfig ?? configSnapshot.config;
	const agentId = resolveTargetAgentIdOrExit({
		cfg,
		runtime: params.runtime,
		agentInput: params.agentInput
	});
	if (!agentId) return null;
	return {
		cfg,
		agentId,
		baseHash: configSnapshot.hash
	};
}
async function agentsBindingsCommand(opts, runtime = defaultRuntime) {
	const cfg = await requireValidConfig(runtime);
	if (!cfg) return;
	const filterAgentId = resolveAgentId(cfg, opts.agent?.trim());
	if (opts.agent && !filterAgentId) {
		runtime.error(`Agent id is required. Run ${formatCliCommand("openclaw agents list")} to choose one.`);
		runtime.exit(1);
		return;
	}
	if (filterAgentId && !hasAgent(cfg, filterAgentId)) {
		runtime.error(`Agent "${filterAgentId}" not found. Run ${formatCliCommand("openclaw agents list")} to see configured agents.`);
		runtime.exit(1);
		return;
	}
	const filtered = listRouteBindings(cfg).filter((binding) => !filterAgentId || normalizeAgentId(binding.agentId) === filterAgentId);
	if (opts.json) {
		writeRuntimeJson(runtime, filtered.map((binding) => ({
			agentId: normalizeAgentId(binding.agentId),
			match: binding.match,
			description: describeBinding(binding)
		})));
		return;
	}
	if (filtered.length === 0) {
		runtime.log(filterAgentId ? `No routing bindings for agent "${filterAgentId}".` : "No routing bindings.");
		return;
	}
	runtime.log(["Routing bindings:", ...filtered.map((binding) => `- ${formatBindingOwnerLine(binding)}`)].join("\n"));
}
async function agentsBindCommand(opts, runtime = defaultRuntime) {
	const resolved = await resolveConfigAndTargetAgentIdOrExit({
		runtime,
		agentInput: opts.agent
	});
	if (!resolved) return;
	const { cfg, agentId, baseHash } = resolved;
	const parsed = await resolveParsedBindingsOrExit({
		runtime,
		cfg,
		agentId,
		bindValues: opts.bind,
		emptyMessage: "Provide at least one --bind <channel[:accountId]>."
	});
	if (!parsed) return;
	const { applyAgentBindings } = await loadAgentBindingsModule();
	const result = applyAgentBindings(cfg, parsed.bindings);
	if (result.added.length > 0 || result.updated.length > 0) {
		await replaceConfigFile({
			nextConfig: result.config,
			...baseHash !== void 0 ? { baseHash } : {}
		});
		if (!opts.json) logConfigUpdated(runtime);
	}
	const payload = {
		agentId,
		added: result.added.map(describeBinding),
		updated: result.updated.map(describeBinding),
		skipped: result.skipped.map(describeBinding),
		conflicts: formatBindingConflicts(result.conflicts)
	};
	if (emitJsonPayload({
		runtime,
		json: opts.json,
		payload,
		conflictCount: result.conflicts.length
	})) return;
	if (result.added.length > 0) {
		runtime.log("Added bindings:");
		for (const binding of result.added) runtime.log(`- ${describeBinding(binding)}`);
	} else if (result.updated.length === 0) runtime.log("No new bindings added.");
	if (result.updated.length > 0) {
		runtime.log("Updated bindings:");
		for (const binding of result.updated) runtime.log(`- ${describeBinding(binding)}`);
	}
	if (result.skipped.length > 0) {
		runtime.log("Already present:");
		for (const binding of result.skipped) runtime.log(`- ${describeBinding(binding)}`);
	}
	if (result.conflicts.length > 0) {
		runtime.error("Skipped bindings already claimed by another agent:");
		for (const conflict of result.conflicts) runtime.error(`- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`);
		runtime.exit(1);
	}
}
async function agentsUnbindCommand(opts, runtime = defaultRuntime) {
	const resolved = await resolveConfigAndTargetAgentIdOrExit({
		runtime,
		agentInput: opts.agent
	});
	if (!resolved) return;
	const { cfg, agentId, baseHash } = resolved;
	if (opts.all && (opts.bind?.length ?? 0) > 0) {
		runtime.error("Use either --all or --bind, not both.");
		runtime.exit(1);
		return;
	}
	if (opts.all) {
		const existing = listRouteBindings(cfg);
		const removed = existing.filter((binding) => normalizeAgentId(binding.agentId) === agentId);
		const keptRoutes = existing.filter((binding) => normalizeAgentId(binding.agentId) !== agentId);
		const nonRoutes = (cfg.bindings ?? []).filter((binding) => !isRouteBinding(binding));
		if (removed.length === 0) {
			runtime.log(`No bindings to remove for agent "${agentId}".`);
			return;
		}
		await replaceConfigFile({
			nextConfig: {
				...cfg,
				bindings: [...keptRoutes, ...nonRoutes].length > 0 ? [...keptRoutes, ...nonRoutes] : void 0
			},
			...baseHash !== void 0 ? { baseHash } : {}
		});
		if (!opts.json) logConfigUpdated(runtime);
		const payload = {
			agentId,
			removed: removed.map(describeBinding),
			missing: [],
			conflicts: []
		};
		if (emitJsonPayload({
			runtime,
			json: opts.json,
			payload
		})) return;
		runtime.log(`Removed ${removed.length} binding(s) for "${agentId}".`);
		return;
	}
	const parsed = await resolveParsedBindingsOrExit({
		runtime,
		cfg,
		agentId,
		bindValues: opts.bind,
		emptyMessage: "Provide at least one --bind <channel[:accountId]> or use --all."
	});
	if (!parsed) return;
	const { removeAgentBindings } = await loadAgentBindingsModule();
	const result = removeAgentBindings(cfg, parsed.bindings);
	if (result.removed.length > 0) {
		await replaceConfigFile({
			nextConfig: result.config,
			...baseHash !== void 0 ? { baseHash } : {}
		});
		if (!opts.json) logConfigUpdated(runtime);
	}
	const payload = {
		agentId,
		removed: result.removed.map(describeBinding),
		missing: result.missing.map(describeBinding),
		conflicts: formatBindingConflicts(result.conflicts)
	};
	if (emitJsonPayload({
		runtime,
		json: opts.json,
		payload,
		conflictCount: result.conflicts.length
	})) return;
	if (result.removed.length > 0) {
		runtime.log("Removed bindings:");
		for (const binding of result.removed) runtime.log(`- ${describeBinding(binding)}`);
	} else runtime.log("No bindings removed.");
	if (result.missing.length > 0) {
		runtime.log("Not found:");
		for (const binding of result.missing) runtime.log(`- ${describeBinding(binding)}`);
	}
	if (result.conflicts.length > 0) {
		runtime.error("Bindings are owned by another agent:");
		for (const conflict of result.conflicts) runtime.error(`- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`);
		runtime.exit(1);
	}
}
//#endregion
export { agentsBindCommand, agentsBindingsCommand, agentsUnbindCommand };
