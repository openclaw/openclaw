import { p as createModelCatalogPresetAppliers } from "./provider-onboard-MLXAQX8H.js";
import { a as STEPFUN_PLAN_PROVIDER_ID, c as STEPFUN_STANDARD_INTL_BASE_URL, i as STEPFUN_PLAN_INTL_BASE_URL, l as buildStepFunPlanProvider, n as STEPFUN_PLAN_CN_BASE_URL, o as STEPFUN_PROVIDER_ID, r as STEPFUN_PLAN_DEFAULT_MODEL_REF, s as STEPFUN_STANDARD_CN_BASE_URL, t as STEPFUN_DEFAULT_MODEL_REF, u as buildStepFunProvider } from "./provider-catalog-CkR6Ytwv.js";
//#region extensions/stepfun/onboard.ts
function createStepFunPresetAppliers(params) {
	return createModelCatalogPresetAppliers({
		primaryModelRef: params.primaryModelRef,
		resolveParams: (_cfg, baseUrl) => {
			const provider = params.buildProvider(baseUrl);
			const models = provider.models ?? [];
			return {
				providerId: params.providerId,
				api: provider.api ?? "openai-completions",
				baseUrl,
				catalogModels: models,
				aliases: [...models.map((model) => `${params.providerId}/${model.id}`), {
					modelRef: params.primaryModelRef,
					alias: params.alias
				}]
			};
		}
	});
}
const stepFunPresetAppliers = createStepFunPresetAppliers({
	providerId: STEPFUN_PROVIDER_ID,
	primaryModelRef: STEPFUN_DEFAULT_MODEL_REF,
	alias: "StepFun",
	buildProvider: buildStepFunProvider
});
const stepFunPlanPresetAppliers = createStepFunPresetAppliers({
	providerId: STEPFUN_PLAN_PROVIDER_ID,
	primaryModelRef: STEPFUN_PLAN_DEFAULT_MODEL_REF,
	alias: "StepFun Plan",
	buildProvider: buildStepFunPlanProvider
});
function applyStepFunStandardConfigCn(cfg) {
	return stepFunPresetAppliers.applyConfig(cfg, STEPFUN_STANDARD_CN_BASE_URL);
}
function applyStepFunStandardConfig(cfg) {
	return stepFunPresetAppliers.applyConfig(cfg, STEPFUN_STANDARD_INTL_BASE_URL);
}
function applyStepFunPlanConfigCn(cfg) {
	return stepFunPlanPresetAppliers.applyConfig(cfg, STEPFUN_PLAN_CN_BASE_URL);
}
function applyStepFunPlanConfig(cfg) {
	return stepFunPlanPresetAppliers.applyConfig(cfg, STEPFUN_PLAN_INTL_BASE_URL);
}
//#endregion
export { applyStepFunStandardConfigCn as i, applyStepFunPlanConfigCn as n, applyStepFunStandardConfig as r, applyStepFunPlanConfig as t };
