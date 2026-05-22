import { i as resolveCodexAppServerRuntimeOptions } from "./config-DFyAu0jI.js";
import { a as buildTurnStartParams, c as createCodexDynamicToolBridge, i as buildThreadStartParams, l as applyCodexDynamicToolProfile, n as buildDeveloperInstructions, r as buildThreadResumeParams } from "./thread-lifecycle-CGoDT9rI.js";
//#region extensions/codex/test-api.ts
function resolveCodexPromptSnapshotAppServerOptions(pluginConfig) {
	return resolveCodexAppServerRuntimeOptions({
		pluginConfig,
		env: {}
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
		tools: applyCodexDynamicToolProfile(params.tools, params.pluginConfig ?? {}),
		signal: new AbortController().signal
	}).specs;
}
//#endregion
export { buildCodexHarnessPromptSnapshot, createCodexDynamicToolSpecsForPromptSnapshot, resolveCodexPromptSnapshotAppServerOptions };
