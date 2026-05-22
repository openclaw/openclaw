import { s as resolveCodexAppServerRuntimeOptions } from "../../config-DzSGOJ2A.js";
import { a as buildThreadStartParams, h as filterCodexDynamicTools, i as buildThreadResumeParams, m as createCodexDynamicToolBridge, o as buildTurnStartParams, r as buildDeveloperInstructions } from "../../thread-lifecycle-DJA0z5zq.js";
//#region extensions/codex/test-api.ts
function resolveCodexPromptSnapshotAppServerOptions(pluginConfig) {
	return resolveCodexAppServerRuntimeOptions({
		pluginConfig,
		env: {},
		requirementsToml: null
	});
}
function buildCodexHarnessPromptSnapshot(params) {
	const developerInstructions = buildDeveloperInstructions(params.attempt);
	return {
		developerInstructions,
		threadStartParams: buildThreadStartParams(params.attempt, {
			cwd: params.cwd,
			dynamicTools: params.dynamicTools,
			appServer: params.appServer,
			developerInstructions,
			config: params.config
		}),
		threadResumeParams: buildThreadResumeParams(params.attempt, {
			threadId: params.threadId,
			appServer: params.appServer,
			developerInstructions,
			config: params.config
		}),
		turnStartParams: buildTurnStartParams(params.attempt, {
			threadId: params.threadId,
			cwd: params.cwd,
			appServer: params.appServer,
			promptText: params.promptText
		})
	};
}
function createCodexDynamicToolSpecsForPromptSnapshot(params) {
	return createCodexDynamicToolBridge({
		tools: filterCodexDynamicTools(params.tools, params.pluginConfig ?? {}),
		signal: new AbortController().signal,
		loading: params.pluginConfig?.codexDynamicToolsLoading ?? "searchable",
		directToolNames: params.directToolNames
	}).specs;
}
//#endregion
export { buildCodexHarnessPromptSnapshot, createCodexDynamicToolSpecsForPromptSnapshot, resolveCodexPromptSnapshotAppServerOptions };
