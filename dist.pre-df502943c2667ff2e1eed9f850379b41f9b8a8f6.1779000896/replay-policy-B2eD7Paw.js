import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import "./string-coerce-runtime-DBT298Ik.js";
//#region extensions/github-copilot/replay-policy.ts
function buildGithubCopilotReplayPolicy(modelId) {
	return normalizeLowercaseStringOrEmpty(modelId).includes("claude") ? { dropThinkingBlocks: true } : {};
}
//#endregion
export { buildGithubCopilotReplayPolicy as t };
