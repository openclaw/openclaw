import { T as buildQwenModelCatalogForBaseUrl } from "./models-Dc9dhXy1.js";
//#region extensions/qwen/provider-catalog.ts
function buildQwenProvider(params) {
	const baseUrl = params?.baseUrl ?? "https://coding-intl.dashscope.aliyuncs.com/v1";
	return {
		baseUrl,
		api: "openai-completions",
		models: buildQwenModelCatalogForBaseUrl(baseUrl).map((model) => Object.assign({}, model))
	};
}
const buildModelStudioProvider = buildQwenProvider;
//#endregion
export { buildQwenProvider as n, buildModelStudioProvider as t };
