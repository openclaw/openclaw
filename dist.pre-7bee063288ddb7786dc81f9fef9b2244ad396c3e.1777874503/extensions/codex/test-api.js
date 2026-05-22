import { i as resolveCodexAppServerRuntimeOptions } from "../../config-llzRy3Cd.js";
import { i as buildTurnStartParams, n as buildThreadResumeParams, o as createCodexDynamicToolBridge, r as buildThreadStartParams, s as applyCodexDynamicToolProfile, t as buildDeveloperInstructions } from "../../thread-lifecycle-YhTCVe39.js";
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
