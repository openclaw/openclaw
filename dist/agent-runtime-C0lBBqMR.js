import { n as findNormalizedProviderValue, r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import "./agent-scope-C1Fl7gAf.js";
import "./provider-auth-aliases-3NFJcokO.js";
import "./sandbox-paths-BOOkw4YG.js";
import "./model-auth-markers-UDEQVW7W.js";
import "./model-selection-VRXWv5rs.js";
import "./model-catalog-Bej-qOX2.js";
import "./auth-profiles-vKILPyQ8.js";
import "./model-auth-_bXIM30P.js";
import "./pi-embedded-utils-1bVAKyYK.js";
import "./common-V7-zd73S.js";
import "./typebox-B_Peztf1.js";
import "./identity-CRZts9Qd.js";
import "./tts-BO4bGOGk.js";
import "./web-shared-B-Y2uCeO.js";
import "./provider-auth-D5QGE8z6.js";
import "./identity-avatar-Dwaxzqx8.js";
import "./simple-completion-runtime-Cf-lVQPJ.js";
import "./web-guarded-fetch-hhVIx3eo.js";
import "./agent-command-BQgTSh4F.js";
//#region src/agents/model-catalog-scope.ts
function dedupeCatalogScopeRefs(values) {
	const refs = /* @__PURE__ */ new Set();
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) refs.add(trimmed);
	}
	return [...refs];
}
function providerFromModelRef(value) {
	const trimmed = value?.trim();
	if (!trimmed) return;
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return;
	return normalizeProviderId(trimmed.slice(0, slash)) || void 0;
}
function resolveModelCatalogScope(params) {
	const provider = params.provider.trim();
	const model = params.model.trim();
	return {
		providerRefs: dedupeCatalogScopeRefs([provider, findNormalizedProviderValue(params.cfg?.models?.providers, provider)?.api]),
		modelRefs: dedupeCatalogScopeRefs([provider && model ? `${provider}/${model}` : model, model])
	};
}
function resolveProviderDiscoveryProviderIdsForCatalogScope(params) {
	const providerIds = dedupeCatalogScopeRefs([...params.providerRefs ?? [], ...(params.modelRefs ?? []).map(providerFromModelRef)]);
	return providerIds.length > 0 ? providerIds : void 0;
}
//#endregion
//#region src/tools/availability.ts
function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function resolveConfigPath(config, path) {
	let current = config;
	for (const segment of path) {
		if (!isRecord(current)) return;
		current = current[segment];
	}
	return current;
}
function hasConfiguredValue(params) {
	const { value, signal } = params;
	if (value === void 0 || value === null) return false;
	if ((signal.check ?? "exists") === "available") return params.context.isConfigValueAvailable?.({
		value,
		path: signal.path,
		signal
	}) === true;
	if ((signal.check ?? "exists") === "exists") return true;
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value).length > 0;
	return true;
}
function hasAvailabilityExpressionShape(value) {
	return "kind" in value || "allOf" in value || "anyOf" in value;
}
function diagnostic(reason, signal, message) {
	return {
		reason,
		signal,
		message
	};
}
function evaluateSignal(signal, context) {
	switch (signal.kind) {
		case "always": return null;
		case "auth": return context.authProviderIds?.has(signal.providerId) ? null : diagnostic("auth-missing", signal, `Missing auth provider: ${signal.providerId}`);
		case "config": return hasConfiguredValue({
			value: resolveConfigPath(context.config, signal.path),
			signal,
			context
		}) ? null : diagnostic("config-missing", signal, `Missing config path: ${signal.path.join(".")}`);
		case "env": return context.env?.[signal.name]?.trim() ? null : diagnostic("env-missing", signal, `Missing environment value: ${signal.name}`);
		case "plugin-enabled": return context.enabledPluginIds?.has(signal.pluginId) ? null : diagnostic("plugin-disabled", signal, `Plugin is not enabled: ${signal.pluginId}`);
		case "context": {
			const value = context.values?.[signal.key];
			if (!("equals" in signal)) return value === void 0 ? diagnostic("context-mismatch", signal, `Missing context value: ${signal.key}`) : null;
			return value === signal.equals ? null : diagnostic("context-mismatch", signal, `Context value did not match: ${signal.key}`);
		}
		default: return diagnostic("unsupported-signal", signal, "Unsupported availability signal");
	}
}
function evaluateExpression(expression, context) {
	if ("kind" in expression) {
		const diagnostic = evaluateSignal(expression, context);
		return diagnostic ? [diagnostic] : [];
	}
	if ("allOf" in expression) {
		if (expression.allOf.length === 0) return [{
			reason: "unsupported-signal",
			message: "Empty availability allOf group"
		}];
		return expression.allOf.flatMap((entry) => evaluateExpression(entry, context));
	}
	if ("anyOf" in expression) {
		if (expression.anyOf.length === 0) return [{
			reason: "unsupported-signal",
			message: "Empty availability anyOf group"
		}];
		const diagnostics = expression.anyOf.map((entry) => evaluateExpression(entry, context));
		return diagnostics.some((entries) => entries.length === 0) ? [] : diagnostics.flat();
	}
	return [{
		reason: "unsupported-signal",
		message: "Unsupported availability expression"
	}];
}
function evaluateToolAvailability(params) {
	const context = params.context ?? {};
	const availability = params.descriptor.availability ?? { kind: "always" };
	if (!hasAvailabilityExpressionShape(availability)) return [{
		reason: "unsupported-signal",
		message: "Unsupported availability expression"
	}];
	return evaluateExpression(availability, context);
}
//#endregion
//#region src/tools/descriptors.ts
function defineToolDescriptor(descriptor) {
	return descriptor;
}
function defineToolDescriptors(descriptors) {
	return descriptors;
}
//#endregion
//#region src/tools/diagnostics.ts
var ToolPlanContractError = class extends Error {
	constructor(params) {
		super(params.message);
		this.name = "ToolPlanContractError";
		this.code = params.code;
		this.toolName = params.toolName;
	}
};
//#endregion
//#region src/tools/execution.ts
function formatToolExecutorRef(ref) {
	switch (ref.kind) {
		case "core": return `core:${ref.executorId}`;
		case "plugin": return `plugin:${ref.pluginId}:${ref.toolName}`;
		case "channel": return `channel:${ref.channelId}:${ref.actionId}`;
		case "mcp": return `mcp:${ref.serverId}:${ref.toolName}`;
		default: return ref;
	}
}
//#endregion
//#region src/tools/planner.ts
function compareDescriptors(left, right) {
	return (left.sortKey ?? left.name).localeCompare(right.sortKey ?? right.name) || left.name.localeCompare(right.name);
}
function assertUniqueNames(descriptors) {
	const seen = /* @__PURE__ */ new Set();
	for (const descriptor of descriptors) {
		if (seen.has(descriptor.name)) throw new ToolPlanContractError({
			code: "duplicate-tool-name",
			toolName: descriptor.name,
			message: `Duplicate tool descriptor name: ${descriptor.name}`
		});
		seen.add(descriptor.name);
	}
}
function buildToolPlan(options) {
	const descriptors = options.descriptors.toSorted(compareDescriptors);
	assertUniqueNames(descriptors);
	const visible = [];
	const hidden = [];
	for (const descriptor of descriptors) {
		const diagnostics = [...evaluateToolAvailability({
			descriptor,
			context: options.availability
		})];
		if (diagnostics.length > 0) {
			hidden.push({
				descriptor,
				diagnostics
			});
			continue;
		}
		if (!descriptor.executor) throw new ToolPlanContractError({
			code: "missing-executor",
			toolName: descriptor.name,
			message: `Visible tool descriptor has no executor ref: ${descriptor.name}`
		});
		visible.push({
			descriptor,
			executor: descriptor.executor
		});
	}
	return {
		visible,
		hidden
	};
}
//#endregion
//#region src/tools/protocol.ts
function toToolProtocolDescriptor(entry) {
	return {
		name: entry.descriptor.name,
		description: entry.descriptor.description,
		inputSchema: entry.descriptor.inputSchema
	};
}
function toToolProtocolDescriptors(entries) {
	return entries.map(toToolProtocolDescriptor);
}
//#endregion
export { ToolPlanContractError as a, evaluateToolAvailability as c, formatToolExecutorRef as i, resolveModelCatalogScope as l, toToolProtocolDescriptors as n, defineToolDescriptor as o, buildToolPlan as r, defineToolDescriptors as s, toToolProtocolDescriptor as t, resolveProviderDiscoveryProviderIdsForCatalogScope as u };
