import { t as createLazyImportLoader } from "./lazy-promise-AiZRy56y.js";
//#region src/auto-reply/reply/session-fork.ts
/**
* Default max parent token count beyond which thread/session parent forking is skipped.
* This prevents new thread sessions from inheriting near-full parent context.
* See #26905.
*/
const DEFAULT_PARENT_FORK_MAX_TOKENS = 1e5;
const sessionForkRuntimeLoader = createLazyImportLoader(() => import("./session-fork.runtime.js"));
function loadSessionForkRuntime() {
	return sessionForkRuntimeLoader.load();
}
function formatParentForkTooLargeMessage(params) {
	return `Parent context is too large to fork (${params.parentTokens}/${params.maxTokens} tokens); starting with isolated context instead.`;
}
async function resolveParentForkDecision(params) {
	const maxTokens = DEFAULT_PARENT_FORK_MAX_TOKENS;
	const parentTokens = await resolveParentForkTokenCount({
		parentEntry: params.parentEntry,
		storePath: params.storePath
	});
	if (typeof parentTokens === "number" && parentTokens > maxTokens) return {
		status: "skip",
		reason: "parent-too-large",
		maxTokens,
		parentTokens,
		message: formatParentForkTooLargeMessage({
			parentTokens,
			maxTokens
		})
	};
	return {
		status: "fork",
		maxTokens,
		...typeof parentTokens === "number" ? { parentTokens } : {}
	};
}
async function forkSessionFromParent(params) {
	return (await loadSessionForkRuntime()).forkSessionFromParentRuntime(params);
}
async function resolveParentForkTokenCount(params) {
	return (await loadSessionForkRuntime()).resolveParentForkTokenCountRuntime(params);
}
//#endregion
export { resolveParentForkDecision as n, forkSessionFromParent as t };
