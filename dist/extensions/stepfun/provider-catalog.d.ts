import { f as ModelProviderDeclarationConfig } from "../../types.models-tqxsISRc.js";
//#region extensions/stepfun/provider-catalog.d.ts
declare const STEPFUN_PROVIDER_ID = "stepfun";
declare const STEPFUN_PLAN_PROVIDER_ID = "stepfun-plan";
declare const STEPFUN_STANDARD_CN_BASE_URL = "https://api.stepfun.com/v1";
declare const STEPFUN_STANDARD_INTL_BASE_URL = "https://api.stepfun.ai/v1";
declare const STEPFUN_PLAN_CN_BASE_URL = "https://api.stepfun.com/step_plan/v1";
declare const STEPFUN_PLAN_INTL_BASE_URL = "https://api.stepfun.ai/step_plan/v1";
declare const STEPFUN_DEFAULT_MODEL_REF = "stepfun/step-3.5-flash";
declare const STEPFUN_PLAN_DEFAULT_MODEL_REF = "stepfun-plan/step-3.5-flash";
declare function buildStepFunProvider(baseUrl?: string): ModelProviderDeclarationConfig;
declare function buildStepFunPlanProvider(baseUrl?: string): ModelProviderDeclarationConfig;
//#endregion
export { STEPFUN_DEFAULT_MODEL_REF, STEPFUN_PLAN_CN_BASE_URL, STEPFUN_PLAN_DEFAULT_MODEL_REF, STEPFUN_PLAN_INTL_BASE_URL, STEPFUN_PLAN_PROVIDER_ID, STEPFUN_PROVIDER_ID, STEPFUN_STANDARD_CN_BASE_URL, STEPFUN_STANDARD_INTL_BASE_URL, buildStepFunPlanProvider, buildStepFunProvider };