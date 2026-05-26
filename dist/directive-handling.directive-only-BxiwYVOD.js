import { o as stripMentions, s as stripStructuralPrefixes } from "./mentions-DmNrCnsQ.js";
//#region src/auto-reply/reply/directive-handling.directive-only.ts
function isDirectiveOnly(params) {
	const { directives, cleanedBody, ctx, cfg, agentId, isGroup } = params;
	if (!directives.hasThinkDirective && !directives.hasVerboseDirective && !directives.hasTraceDirective && !directives.hasFastDirective && !directives.hasReasoningDirective && !directives.hasElevatedDirective && !directives.hasExecDirective && !directives.hasModelDirective && !directives.hasQueueDirective) return false;
	const stripped = stripStructuralPrefixes(cleanedBody ?? "");
	return (isGroup ? stripMentions(stripped, ctx, cfg, agentId) : stripped).length === 0;
}
//#endregion
export { isDirectiveOnly as t };
