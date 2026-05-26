import { i as getRuntimeConfigSnapshot } from "../../runtime-snapshot-DgdkBEdP.js";
import { c as jsonResult, g as readStringParam } from "../../common-E9YpX7pB.js";
import { p as readProviderJsonObjectResponse } from "../../provider-http-errors-C90BH-le.js";
import { u as postTrustedWebToolsJson } from "../../web-search-provider-common-Dg4Eh9ob.js";
import "../../runtime-config-snapshot-BBsNBtE3.js";
import "../../provider-http-CYBE-CBM.js";
import "../../provider-web-search-DNIStESL.js";
import { r as resolveXaiToolApiKeyWithAuth, t as isXaiToolEnabled } from "../../tool-auth-shared-1307P-Z2.js";
import { n as resolveNormalizedXaiToolModel, r as resolvePositiveIntegerToolConfig } from "../../tool-config-shared-Dk_VjbjJ.js";
import { i as requireXaiResponseTextAndCitations, n as buildXaiResponsesToolBody, t as XAI_RESPONSES_ENDPOINT } from "../../responses-tool-shared-Czzu3i8c.js";
import { Type } from "typebox";
//#region extensions/xai/src/code-execution-shared.ts
const XAI_CODE_EXECUTION_ENDPOINT = XAI_RESPONSES_ENDPOINT;
const XAI_DEFAULT_CODE_EXECUTION_MODEL = "grok-4-1-fast";
function resolveXaiCodeExecutionModel(config) {
	return resolveNormalizedXaiToolModel({
		config,
		defaultModel: XAI_DEFAULT_CODE_EXECUTION_MODEL
	});
}
function resolveXaiCodeExecutionMaxTurns(config) {
	return resolvePositiveIntegerToolConfig(config, "maxTurns");
}
function buildXaiCodeExecutionPayload(params) {
	return {
		task: params.task,
		provider: "xai",
		model: params.model,
		tookMs: params.tookMs,
		content: params.content,
		citations: params.citations,
		usedCodeExecution: params.usedCodeExecution,
		outputTypes: params.outputTypes
	};
}
async function requestXaiCodeExecution(params) {
	return await postTrustedWebToolsJson({
		url: XAI_CODE_EXECUTION_ENDPOINT,
		timeoutSeconds: params.timeoutSeconds,
		apiKey: params.apiKey,
		body: buildXaiResponsesToolBody({
			model: params.model,
			inputText: params.task,
			tools: [{ type: "code_interpreter" }],
			maxTurns: params.maxTurns
		}),
		errorLabel: "xAI"
	}, async (response) => {
		const data = await readProviderJsonObjectResponse(response, "xAI code execution failed");
		const { content, citations } = requireXaiResponseTextAndCitations(data, "xAI code execution failed");
		const outputTypes = Array.isArray(data.output) ? [...new Set(data.output.map((entry) => entry?.type).filter((value) => Boolean(value)))] : [];
		return {
			content,
			citations,
			usedCodeExecution: outputTypes.includes("code_interpreter_call"),
			outputTypes
		};
	});
}
//#endregion
//#region extensions/xai/code-execution.ts
function readCodeExecutionConfigRecord(config) {
	return config && typeof config === "object" ? config : void 0;
}
function readPluginCodeExecutionConfig(cfg) {
	if (!cfg || typeof cfg !== "object") return;
	const entries = cfg.plugins;
	const pluginEntries = entries && typeof entries === "object" ? entries.entries : void 0;
	if (!pluginEntries) return;
	const xaiEntry = pluginEntries.xai;
	if (!xaiEntry || typeof xaiEntry !== "object") return;
	const config = xaiEntry.config;
	if (!config || typeof config !== "object") return;
	const codeExecution = config.codeExecution;
	if (!codeExecution || typeof codeExecution !== "object") return;
	return codeExecution;
}
function resolveCodeExecutionEnabled(params) {
	return isXaiToolEnabled({
		enabled: readCodeExecutionConfigRecord(params.config)?.enabled,
		runtimeConfig: params.runtimeConfig,
		sourceConfig: params.sourceConfig,
		auth: params.auth
	});
}
function createCodeExecutionTool(options) {
	const runtimeConfig = options?.runtimeConfig ?? getRuntimeConfigSnapshot();
	const codeExecutionConfig = readPluginCodeExecutionConfig(runtimeConfig ?? void 0) ?? readPluginCodeExecutionConfig(options?.config);
	if (!resolveCodeExecutionEnabled({
		sourceConfig: options?.config,
		runtimeConfig: runtimeConfig ?? void 0,
		config: codeExecutionConfig,
		auth: options?.auth
	})) return null;
	return {
		label: "Code Execution",
		name: "code_execution",
		description: "Run sandboxed Python analysis with xAI. Use for calculations, tabulation, summaries, and chart-style analysis without local machine access.",
		parameters: Type.Object({ task: Type.String({ description: "The full analysis task for xAI's remote Python sandbox. Include any data to analyze directly in the task." }) }),
		execute: async (_toolCallId, args) => {
			const apiKey = await resolveXaiToolApiKeyWithAuth({
				runtimeConfig: runtimeConfig ?? void 0,
				sourceConfig: options?.config,
				auth: options?.auth
			});
			if (!apiKey) return jsonResult({
				error: "missing_xai_api_key",
				message: "code_execution needs xAI credentials. Run `openclaw onboard --auth-choice xai-oauth` to sign in with Grok, run `openclaw onboard --auth-choice xai-api-key`, set `XAI_API_KEY` in the Gateway environment, or configure `plugins.entries.xai.config.webSearch.apiKey`.",
				docs: "https://docs.openclaw.ai/tools/code-execution"
			});
			const task = readStringParam(args, "task", { required: true });
			const codeExecutionConfigRecord = readCodeExecutionConfigRecord(codeExecutionConfig);
			const model = resolveXaiCodeExecutionModel(codeExecutionConfigRecord);
			const maxTurns = resolveXaiCodeExecutionMaxTurns(codeExecutionConfigRecord);
			const timeoutSeconds = typeof codeExecutionConfigRecord?.timeoutSeconds === "number" && Number.isFinite(codeExecutionConfigRecord.timeoutSeconds) ? codeExecutionConfigRecord.timeoutSeconds : 30;
			const startedAt = Date.now();
			const result = await requestXaiCodeExecution({
				apiKey,
				model,
				timeoutSeconds,
				maxTurns,
				task
			});
			return jsonResult(buildXaiCodeExecutionPayload({
				task,
				model,
				tookMs: Date.now() - startedAt,
				content: result.content,
				citations: result.citations,
				usedCodeExecution: result.usedCodeExecution,
				outputTypes: result.outputTypes
			}));
		}
	};
}
//#endregion
export { createCodeExecutionTool };
