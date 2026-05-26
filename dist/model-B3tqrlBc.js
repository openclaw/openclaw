import { S as setAgentEffectiveModelPrimary, a as resolveAgentEffectiveModelPrimary } from "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import "./agent-runtime-Lc7H-PlR.js";
import { c as readString } from "./helpers-B_eVYvP7.js";
import { a as HERMES_REASON_DEFAULT_MODEL_CONFIGURED, d as hermesItemConflict, f as hermesItemError, i as HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE, m as readHermesModelDetails, p as hermesItemSkipped, t as HERMES_REASON_ALREADY_CONFIGURED } from "./items-CPsScumM.js";
//#region extensions/migrate-hermes/model.ts
function resolveHermesModelRef(config) {
	const model = config.model;
	if (typeof model === "string" && model.trim()) {
		const rawModel = model.trim();
		const provider = readString(config.provider);
		if (provider && !rawModel.includes("/")) return `${provider}/${rawModel}`;
		return rawModel;
	}
	if (model && typeof model === "object" && !Array.isArray(model)) {
		const modelRecord = model;
		const rawModel = readString(modelRecord.default) ?? readString(modelRecord.model);
		const provider = readString(modelRecord.provider);
		if (rawModel && provider && !rawModel.includes("/")) return `${provider}/${rawModel}`;
		return rawModel;
	}
	const rootModel = readString(config.default_model) ?? readString(config.model_name);
	const rootProvider = readString(config.provider);
	if (rootModel && rootProvider && !rootModel.includes("/")) return `${rootProvider}/${rootModel}`;
	return rootModel;
}
function resolveDefaultAgentModelState(config) {
	const agentId = resolveDefaultAgentId(config);
	return {
		agentId,
		effectivePrimary: resolveAgentEffectiveModelPrimary(config, agentId)
	};
}
function resolveCurrentModelRef(ctx) {
	return resolveDefaultAgentModelState(ctx.config).effectivePrimary;
}
var ModelApplyAbortError = class extends Error {
	constructor(status, reason) {
		super(reason);
		this.status = status;
		this.reason = reason;
		this.name = "ModelApplyAbortError";
	}
};
async function applyModelItem(ctx, item) {
	const details = readHermesModelDetails(item);
	if (!details || item.status !== "planned") return item;
	try {
		const configApi = ctx.runtime?.config;
		if (!configApi?.current || !configApi.mutateConfigFile) return hermesItemError(item, HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE);
		const currentState = resolveDefaultAgentModelState(configApi.current());
		if (currentState.effectivePrimary === details.model) return hermesItemSkipped(item, HERMES_REASON_ALREADY_CONFIGURED);
		if (currentState.effectivePrimary && !ctx.overwrite) return hermesItemConflict(item, HERMES_REASON_DEFAULT_MODEL_CONFIGURED);
		await configApi.mutateConfigFile({
			base: "runtime",
			afterWrite: { mode: "auto" },
			mutate(draft) {
				const mutationState = resolveDefaultAgentModelState(draft);
				if (mutationState.effectivePrimary === details.model) throw new ModelApplyAbortError("skipped", HERMES_REASON_ALREADY_CONFIGURED);
				if (mutationState.effectivePrimary && !ctx.overwrite) throw new ModelApplyAbortError("conflict", HERMES_REASON_DEFAULT_MODEL_CONFIGURED);
				setAgentEffectiveModelPrimary(draft, mutationState.agentId, details.model);
			}
		});
		return {
			...item,
			status: "migrated"
		};
	} catch (err) {
		if (err instanceof ModelApplyAbortError) return err.status === "conflict" ? hermesItemConflict(item, err.reason) : hermesItemSkipped(item, err.reason);
		return hermesItemError(item, err instanceof Error ? err.message : String(err));
	}
}
//#endregion
export { resolveCurrentModelRef as n, resolveHermesModelRef as r, applyModelItem as t };
