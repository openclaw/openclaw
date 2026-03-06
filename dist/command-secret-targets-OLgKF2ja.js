import { Ft as resolveSecretRefValues, It as describeUnknownError } from "./model-selection-COYmqEoi.js";
import { L as resolveSecretInputRef } from "./registry-DBb6KIXY.js";
import { h as GATEWAY_CLIENT_NAMES, m as GATEWAY_CLIENT_MODES } from "./message-channel-BTTrmWeS.js";
import { st as validateSecretsResolveResult } from "./client-e8ddTB8a.js";
import { n as callGateway } from "./call-D_7yp3J2.js";
import { C as setPathExistingStrict, a as createResolverContext, c as collectCommandSecretAssignmentsFromSnapshot, d as discoverConfigSecretTargetsByIds, h as listSecretTargetRegistryEntries, i as applyResolvedAssignments, t as collectConfigAssignments } from "./runtime-config-collectors-B1e_OiHD.js";

//#region src/cli/command-secret-gateway.ts
function dedupeDiagnostics(entries) {
	const seen = /* @__PURE__ */ new Set();
	const ordered = [];
	for (const entry of entries) {
		const trimmed = entry.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		ordered.push(trimmed);
	}
	return ordered;
}
function collectConfiguredTargetRefPaths(params) {
	const defaults = params.config.secrets?.defaults;
	const configuredTargetRefPaths = /* @__PURE__ */ new Set();
	for (const target of discoverConfigSecretTargetsByIds(params.config, params.targetIds)) {
		const { ref } = resolveSecretInputRef({
			value: target.value,
			refValue: target.refValue,
			defaults
		});
		if (ref) configuredTargetRefPaths.add(target.path);
	}
	return configuredTargetRefPaths;
}
function classifyConfiguredTargetRefs(params) {
	if (params.configuredTargetRefPaths.size === 0) return {
		hasActiveConfiguredRef: false,
		hasUnknownConfiguredRef: false,
		diagnostics: []
	};
	const context = createResolverContext({
		sourceConfig: params.config,
		env: process.env
	});
	collectConfigAssignments({
		config: structuredClone(params.config),
		context
	});
	const activePaths = new Set(context.assignments.map((assignment) => assignment.path));
	const inactiveWarningsByPath = /* @__PURE__ */ new Map();
	for (const warning of context.warnings) {
		if (warning.code !== "SECRETS_REF_IGNORED_INACTIVE_SURFACE") continue;
		inactiveWarningsByPath.set(warning.path, warning.message);
	}
	const diagnostics = /* @__PURE__ */ new Set();
	let hasActiveConfiguredRef = false;
	let hasUnknownConfiguredRef = false;
	for (const path of params.configuredTargetRefPaths) {
		if (activePaths.has(path)) {
			hasActiveConfiguredRef = true;
			continue;
		}
		const inactiveWarning = inactiveWarningsByPath.get(path);
		if (inactiveWarning) {
			diagnostics.add(inactiveWarning);
			continue;
		}
		hasUnknownConfiguredRef = true;
	}
	return {
		hasActiveConfiguredRef,
		hasUnknownConfiguredRef,
		diagnostics: [...diagnostics]
	};
}
function parseGatewaySecretsResolveResult(payload) {
	if (!validateSecretsResolveResult(payload)) throw new Error("gateway returned invalid secrets.resolve payload.");
	const parsed = payload;
	return {
		assignments: parsed.assignments ?? [],
		diagnostics: (parsed.diagnostics ?? []).filter((entry) => entry.trim().length > 0),
		inactiveRefPaths: (parsed.inactiveRefPaths ?? []).filter((entry) => entry.trim().length > 0)
	};
}
function collectInactiveSurfacePathsFromDiagnostics(diagnostics) {
	const paths = /* @__PURE__ */ new Set();
	for (const entry of diagnostics) {
		const markerIndex = entry.indexOf(": secret ref is configured on an inactive surface;");
		if (markerIndex <= 0) continue;
		const path = entry.slice(0, markerIndex).trim();
		if (path.length > 0) paths.add(path);
	}
	return paths;
}
function isUnsupportedSecretsResolveError(err) {
	const message = describeUnknownError(err).toLowerCase();
	if (!message.includes("secrets.resolve")) return false;
	return message.includes("does not support required method") || message.includes("unknown method") || message.includes("method not found") || message.includes("invalid request");
}
async function resolveCommandSecretRefsLocally(params) {
	const sourceConfig = params.config;
	const resolvedConfig = structuredClone(params.config);
	const context = createResolverContext({
		sourceConfig,
		env: process.env
	});
	collectConfigAssignments({
		config: resolvedConfig,
		context
	});
	if (context.assignments.length > 0) {
		const resolved = await resolveSecretRefValues(context.assignments.map((assignment) => assignment.ref), {
			config: sourceConfig,
			env: context.env,
			cache: context.cache
		});
		applyResolvedAssignments({
			assignments: context.assignments,
			resolved
		});
	}
	const inactiveRefPaths = new Set(context.warnings.filter((warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE").map((warning) => warning.path));
	const commandAssignments = collectCommandSecretAssignmentsFromSnapshot({
		sourceConfig,
		resolvedConfig,
		commandName: params.commandName,
		targetIds: params.targetIds,
		inactiveRefPaths
	});
	return {
		resolvedConfig,
		diagnostics: dedupeDiagnostics([...params.preflightDiagnostics, ...commandAssignments.diagnostics])
	};
}
async function resolveCommandSecretRefsViaGateway(params) {
	const configuredTargetRefPaths = collectConfiguredTargetRefPaths({
		config: params.config,
		targetIds: params.targetIds
	});
	if (configuredTargetRefPaths.size === 0) return {
		resolvedConfig: params.config,
		diagnostics: []
	};
	const preflight = classifyConfiguredTargetRefs({
		config: params.config,
		configuredTargetRefPaths
	});
	if (!preflight.hasActiveConfiguredRef && !preflight.hasUnknownConfiguredRef) return {
		resolvedConfig: params.config,
		diagnostics: preflight.diagnostics
	};
	let payload;
	try {
		payload = await callGateway({
			method: "secrets.resolve",
			requiredMethods: ["secrets.resolve"],
			params: {
				commandName: params.commandName,
				targetIds: [...params.targetIds]
			},
			timeoutMs: 3e4,
			clientName: GATEWAY_CLIENT_NAMES.CLI,
			mode: GATEWAY_CLIENT_MODES.CLI
		});
	} catch (err) {
		try {
			const fallback = await resolveCommandSecretRefsLocally({
				config: params.config,
				commandName: params.commandName,
				targetIds: params.targetIds,
				preflightDiagnostics: preflight.diagnostics
			});
			return {
				resolvedConfig: fallback.resolvedConfig,
				diagnostics: dedupeDiagnostics([...fallback.diagnostics, `${params.commandName}: gateway secrets.resolve unavailable (${describeUnknownError(err)}); resolved command secrets locally.`])
			};
		} catch {}
		if (isUnsupportedSecretsResolveError(err)) throw new Error(`${params.commandName}: active gateway does not support secrets.resolve (${describeUnknownError(err)}). Update the gateway or run without SecretRefs.`, { cause: err });
		throw new Error(`${params.commandName}: failed to resolve secrets from the active gateway snapshot (${describeUnknownError(err)}). Start the gateway and retry.`, { cause: err });
	}
	const parsed = parseGatewaySecretsResolveResult(payload);
	const resolvedConfig = structuredClone(params.config);
	for (const assignment of parsed.assignments) {
		const pathSegments = assignment.pathSegments.filter((segment) => segment.length > 0);
		if (pathSegments.length === 0) continue;
		try {
			setPathExistingStrict(resolvedConfig, pathSegments, assignment.value);
		} catch (err) {
			const path = pathSegments.join(".");
			throw new Error(`${params.commandName}: failed to apply resolved secret assignment at ${path} (${describeUnknownError(err)}).`, { cause: err });
		}
	}
	const inactiveRefPaths = parsed.inactiveRefPaths.length > 0 ? new Set(parsed.inactiveRefPaths) : collectInactiveSurfacePathsFromDiagnostics(parsed.diagnostics);
	collectCommandSecretAssignmentsFromSnapshot({
		sourceConfig: params.config,
		resolvedConfig,
		commandName: params.commandName,
		targetIds: params.targetIds,
		inactiveRefPaths
	});
	return {
		resolvedConfig,
		diagnostics: dedupeDiagnostics(parsed.diagnostics)
	};
}

//#endregion
//#region src/cli/command-secret-targets.ts
function idsByPrefix(prefixes) {
	return listSecretTargetRegistryEntries().map((entry) => entry.id).filter((id) => prefixes.some((prefix) => id.startsWith(prefix))).toSorted();
}
const COMMAND_SECRET_TARGETS = {
	memory: ["agents.defaults.memorySearch.remote.apiKey", "agents.list[].memorySearch.remote.apiKey"],
	qrRemote: ["gateway.remote.token", "gateway.remote.password"],
	channels: idsByPrefix(["channels."]),
	models: idsByPrefix(["models.providers."]),
	agentRuntime: idsByPrefix([
		"channels.",
		"models.providers.",
		"agents.defaults.memorySearch.remote.",
		"agents.list[].memorySearch.remote.",
		"skills.entries.",
		"messages.tts.",
		"tools.web.search"
	]),
	status: idsByPrefix([
		"channels.",
		"agents.defaults.memorySearch.remote.",
		"agents.list[].memorySearch.remote."
	])
};
function toTargetIdSet(values) {
	return new Set(values);
}
function getMemoryCommandSecretTargetIds() {
	return toTargetIdSet(COMMAND_SECRET_TARGETS.memory);
}
function getQrRemoteCommandSecretTargetIds() {
	return toTargetIdSet(COMMAND_SECRET_TARGETS.qrRemote);
}
function getChannelsCommandSecretTargetIds() {
	return toTargetIdSet(COMMAND_SECRET_TARGETS.channels);
}
function getModelsCommandSecretTargetIds() {
	return toTargetIdSet(COMMAND_SECRET_TARGETS.models);
}
function getAgentRuntimeCommandSecretTargetIds() {
	return toTargetIdSet(COMMAND_SECRET_TARGETS.agentRuntime);
}
function getStatusCommandSecretTargetIds() {
	return toTargetIdSet(COMMAND_SECRET_TARGETS.status);
}

//#endregion
export { getQrRemoteCommandSecretTargetIds as a, getModelsCommandSecretTargetIds as i, getChannelsCommandSecretTargetIds as n, getStatusCommandSecretTargetIds as o, getMemoryCommandSecretTargetIds as r, resolveCommandSecretRefsViaGateway as s, getAgentRuntimeCommandSecretTargetIds as t };