import { l as resolveCodexAppServerRuntimeOptions } from "../../config-CRe1vCzw.js";
import { a as buildThreadResumeParams, i as buildDeveloperInstructions, o as buildThreadStartParams, s as buildTurnStartParams } from "../../thread-lifecycle-bB5uBFC7.js";
import { n as filterCodexDynamicTools, t as createCodexDynamicToolBridge } from "../../dynamic-tools-C3BBSXEr.js";
//#region extensions/codex/test-api.ts
function resolveCodexPromptSnapshotAppServerOptions(pluginConfig) {
	return resolveCodexAppServerRuntimeOptions({
		pluginConfig,
		env: {},
		requirementsToml: null
	});
}
function buildCodexHarnessPromptSnapshot(params) {
	const developerInstructions = joinPresentSections(buildDeveloperInstructions(params.attempt, { dynamicTools: params.dynamicTools }), params.developerInstructionAdditions);
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
			promptText: params.promptText,
			heartbeatCollaborationInstructions: params.heartbeatCollaborationInstructions
		})
	};
}
function joinPresentSections(...sections) {
	return sections.filter((section) => Boolean(section?.trim())).join("\n\n");
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
