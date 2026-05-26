import { c as isRecord, p as resolveUserPath } from "./utils-sBTEdeml.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { n as defaultSlotIdForKey } from "./slots-DT22cOei.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { t as normalizeEmbeddedAgentRuntime } from "./runtime-fVbSwiLb.js";
import { t as resolveAgentHarnessPolicy } from "./policy-BwWh-R0D.js";
import { r as getRegisteredAgentHarness } from "./registry-BiKIFOzv.js";
import { a as resolveContextEngine, n as getContextEngineFactory } from "./registry-DxH_0Os-.js";
import { a as evaluateContextEngineHostSupport, i as buildGenericCliContextEngineHostSupport, n as PI_EMBEDDED_CONTEXT_ENGINE_HOST, t as CODEX_APP_SERVER_CONTEXT_ENGINE_HOST } from "./host-compat-DMtVtGSr.js";
import { t as ensureContextEnginesInitialized } from "./init-DB8akDi-.js";
import { t as resolveCliBackendConfig } from "./cli-backends-Cped1PNR.js";
import { t as ensurePluginRegistryLoaded } from "./runtime-registry-loader-CW8fFOJd.js";
//#region src/commands/doctor/shared/context-engine-host-compat.ts
function normalizeRuntimeId(value) {
	if (typeof value !== "string") return;
	return normalizeEmbeddedAgentRuntime(value.trim().toLowerCase()) || void 0;
}
function parseModelRef(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return;
	return {
		provider: normalizeProviderId(trimmed.slice(0, slash)),
		modelId: trimmed.slice(slash + 1).trim()
	};
}
function listModelRefs(value) {
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (!isRecord(value)) return [];
	const refs = [];
	if (typeof value.primary === "string" && value.primary.trim()) refs.push(value.primary.trim());
	if (Array.isArray(value.fallbacks)) {
		for (const fallback of value.fallbacks) if (typeof fallback === "string" && fallback.trim()) refs.push(fallback.trim());
	}
	return refs;
}
function collectExplicitRuntimeRefs(cfg) {
	const refs = [];
	const push = (runtime, path) => {
		const runtimeId = normalizeRuntimeId(runtime);
		if (runtimeId && runtimeId !== "default") refs.push({
			runtimeId,
			path
		});
	};
	for (const [providerId, providerConfig] of Object.entries(cfg.models?.providers ?? {})) {
		push(providerConfig?.agentRuntime?.id, `models.providers.${providerId}.agentRuntime.id`);
		providerConfig?.models?.forEach((modelConfig, index) => {
			push(modelConfig?.agentRuntime?.id, `models.providers.${providerId}.models[${index}].agentRuntime.id`);
		});
	}
	for (const [modelRef, modelConfig] of Object.entries(cfg.agents?.defaults?.models ?? {})) push(modelConfig?.agentRuntime?.id, `agents.defaults.models.${modelRef}.agentRuntime.id`);
	cfg.agents?.list?.forEach((agent, index) => {
		const agentId = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : `${index}`;
		for (const [modelRef, modelConfig] of Object.entries(agent.models ?? {})) push(modelConfig?.agentRuntime?.id, `agents.list.${agentId}.models.${modelRef}.agentRuntime.id`);
	});
	return refs;
}
function collectSelectedModelRefs(cfg) {
	const refs = [];
	const pushModel = (value, path, agentId) => {
		for (const modelRef of listModelRefs(value)) refs.push({
			modelRef,
			path,
			...agentId ? { agentId } : {}
		});
	};
	const pushModelMap = (models, path, agentId) => {
		if (!isRecord(models)) return;
		for (const modelRef of Object.keys(models)) refs.push({
			modelRef,
			path: `${path}.${modelRef}`,
			...agentId ? { agentId } : {}
		});
	};
	if (cfg.agents?.defaults?.model !== void 0) pushModel(cfg.agents.defaults.model, "agents.defaults.model");
	else refs.push({
		modelRef: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
		path: "agents.defaults.model (default)"
	});
	pushModelMap(cfg.agents?.defaults?.models, "agents.defaults.models");
	cfg.agents?.list?.forEach((agent, index) => {
		const agentId = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : void 0;
		const label = agentId ?? `${index}`;
		pushModel(agent.model ?? cfg.agents?.defaults?.model, `agents.list.${label}.model`, agentId);
		pushModelMap(agent.models, `agents.list.${label}.models`, agentId);
	});
	return refs;
}
function runtimeHostCandidate(params) {
	const runtimeId = normalizeRuntimeId(params.runtimeId) ?? params.runtimeId;
	if (runtimeId === "pi" || runtimeId === "auto") return {
		runtimeId,
		host: PI_EMBEDDED_CONTEXT_ENGINE_HOST,
		paths: params.paths
	};
	if (runtimeId === "codex") return {
		runtimeId,
		host: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
		paths: params.paths
	};
	const harness = getRegisteredAgentHarness(runtimeId)?.harness;
	if (harness) return {
		runtimeId,
		host: {
			id: `harness:${harness.id}`,
			label: `${harness.label} harness`,
			capabilities: harness.contextEngineHostCapabilities ?? []
		},
		paths: params.paths
	};
	const cliBackend = resolveCliBackendConfig(runtimeId, params.cfg);
	return {
		runtimeId,
		host: buildGenericCliContextEngineHostSupport({
			backendId: cliBackend?.id ?? runtimeId,
			capabilities: cliBackend?.contextEngineHostCapabilities
		}),
		paths: params.paths
	};
}
/** Collect effective agent-run host candidates from config and environment runtime policy. */
function collectConfiguredContextEngineAgentRunHosts(params) {
	const envRuntime = normalizeRuntimeId(params.env?.OPENCLAW_AGENT_RUNTIME);
	const runtimePaths = /* @__PURE__ */ new Map();
	const push = (runtimeId, path) => {
		if (!runtimeId) return;
		const normalized = normalizeRuntimeId(runtimeId) ?? runtimeId;
		const paths = runtimePaths.get(normalized) ?? [];
		paths.push(path);
		runtimePaths.set(normalized, paths);
	};
	if (envRuntime) {
		push(envRuntime, "OPENCLAW_AGENT_RUNTIME");
		return [...runtimePaths.entries()].map(([runtimeId, paths]) => runtimeHostCandidate({
			cfg: params.cfg,
			runtimeId,
			paths
		}));
	}
	for (const ref of collectExplicitRuntimeRefs(params.cfg)) push(ref.runtimeId, ref.path);
	for (const model of collectSelectedModelRefs(params.cfg)) {
		const parsed = parseModelRef(model.modelRef);
		if (!parsed) continue;
		push(resolveAgentHarnessPolicy({
			config: params.cfg,
			provider: parsed.provider,
			modelId: parsed.modelId,
			agentId: model.agentId
		}).runtime, model.path);
	}
	return [...runtimePaths.entries()].map(([runtimeId, paths]) => runtimeHostCandidate({
		cfg: params.cfg,
		runtimeId,
		paths
	}));
}
function selectedContextEngineSlotId(cfg) {
	const slotValue = cfg.plugins?.slots?.contextEngine;
	return typeof slotValue === "string" && slotValue.trim() ? slotValue.trim() : defaultSlotIdForKey("contextEngine");
}
async function resolveSelectedContextEngineInfo(params) {
	const engineId = selectedContextEngineSlotId(params.cfg);
	if (engineId === defaultSlotIdForKey("contextEngine") || engineId === "none") return {
		info: {
			id: engineId,
			name: engineId
		},
		warnings: []
	};
	ensureContextEnginesInitialized();
	if (!getContextEngineFactory(engineId)) {
		try {
			ensurePluginRegistryLoaded({
				scope: "all",
				config: params.cfg,
				env: params.env,
				onlyPluginIds: [engineId]
			});
		} catch (error) {
			if (!getContextEngineFactory(engineId)) return { warnings: [`- plugins.slots.contextEngine: could not inspect context engine "${engineId}" host requirements because its plugin failed to load: ${error instanceof Error ? error.message : String(error)}`] };
		}
		if (!getContextEngineFactory(engineId)) return { warnings: [`- plugins.slots.contextEngine: could not inspect context engine "${engineId}" host requirements because it is not registered.`] };
	}
	try {
		return {
			info: (await resolveContextEngine(params.cfg, {
				agentDir: resolveDefaultAgentDir(params.cfg, params.env),
				workspaceDir: params.cfg.agents?.defaults?.workspace ? resolveUserPath(params.cfg.agents.defaults.workspace, params.env) : void 0
			})).info,
			warnings: []
		};
	} catch (error) {
		return { warnings: [`- plugins.slots.contextEngine: could not inspect context engine "${engineId}" host requirements: ${error instanceof Error ? error.message : String(error)}`] };
	}
}
function collectHostCompatibilityIssues(params) {
	return params.hosts.flatMap((candidate) => {
		const evaluation = evaluateContextEngineHostSupport({
			contextEngineInfo: params.info,
			operation: "agent-run",
			host: candidate.host
		});
		if (evaluation.ok) return [];
		return [{
			candidate,
			missingCapabilities: evaluation.missingCapabilities,
			requiredCapabilities: evaluation.requirements.requiredCapabilities
		}];
	});
}
function formatPaths(paths) {
	const unique = [...new Set(paths)];
	if (unique.length <= 2) return unique.join(", ");
	return `${unique.slice(0, 2).join(", ")}, and ${unique.length - 2} more`;
}
function formatHostCapabilities(capabilities) {
	return capabilities.length > 0 ? capabilities.join(", ") : "(none)";
}
function formatCompatibilityWarnings(params) {
	if (params.issues.length === 0) return [];
	const lines = params.issues.map((issue) => {
		const paths = formatPaths(issue.candidate.paths);
		return `- plugins.slots.contextEngine: context engine "${params.info.id}" is incompatible with ${issue.candidate.host.label} (${paths}). Missing host capabilities: ${issue.missingCapabilities.join(", ")}. Required capabilities: ${issue.requiredCapabilities.join(", ")}. Host capabilities: ${formatHostCapabilities(issue.candidate.host.capabilities)}.`;
	});
	const incompatibleAllHosts = params.issues.length === params.hostCount;
	lines.push(incompatibleAllHosts ? `- Run "${params.doctorFixCommand}" to switch plugins.slots.contextEngine to "legacy", or configure a compatible runtime/harness for agent runs.` : `- Some configured runtimes support context engine "${params.info.id}" and others do not; doctor will not rewrite the global contextEngine slot automatically. Configure unsupported models to use a compatible runtime/harness or set plugins.slots.contextEngine to "legacy".`);
	return [lines.join("\n")];
}
/** Collect doctor warnings for context engines that cannot run under configured hosts. */
async function collectContextEngineHostCompatibilityWarnings(params) {
	const resolved = await resolveSelectedContextEngineInfo(params);
	if (!resolved.info) return resolved.warnings;
	const hosts = collectConfiguredContextEngineAgentRunHosts(params);
	const issues = collectHostCompatibilityIssues({
		info: resolved.info,
		hosts
	});
	return [...resolved.warnings, ...formatCompatibilityWarnings({
		info: resolved.info,
		issues,
		hostCount: hosts.length,
		doctorFixCommand: params.doctorFixCommand
	})];
}
/** Repair a globally incompatible context engine by falling back to legacy. */
async function maybeRepairContextEngineHostCompatibility(params) {
	const resolved = await resolveSelectedContextEngineInfo(params);
	if (!resolved.info) return {
		config: params.cfg,
		changes: [],
		warnings: resolved.warnings
	};
	const hosts = collectConfiguredContextEngineAgentRunHosts(params);
	const issues = collectHostCompatibilityIssues({
		info: resolved.info,
		hosts
	});
	if (issues.length === 0) return {
		config: params.cfg,
		changes: [],
		warnings: resolved.warnings
	};
	const warnings = formatCompatibilityWarnings({
		info: resolved.info,
		issues,
		hostCount: hosts.length,
		doctorFixCommand: params.doctorFixCommand
	});
	if (issues.length !== hosts.length) return {
		config: params.cfg,
		changes: [],
		warnings: [...resolved.warnings, ...warnings]
	};
	const next = structuredClone(params.cfg);
	next.plugins ??= {};
	next.plugins.slots ??= {};
	next.plugins.slots.contextEngine = defaultSlotIdForKey("contextEngine");
	return {
		config: next,
		changes: [`Set plugins.slots.contextEngine to "legacy" because context engine "${resolved.info.id}" is incompatible with every configured agent-run host.`],
		warnings: resolved.warnings
	};
}
//#endregion
export { collectContextEngineHostCompatibilityWarnings as n, maybeRepairContextEngineHostCompatibility as r, collectConfiguredContextEngineAgentRunHosts as t };
