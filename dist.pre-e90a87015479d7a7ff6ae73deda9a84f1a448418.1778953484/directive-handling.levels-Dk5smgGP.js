//#region src/auto-reply/reply/directive-handling.levels.ts
async function resolveCurrentDirectiveLevels(params) {
	return {
		currentThinkLevel: params.sessionEntry?.thinkingLevel ?? await params.resolveDefaultThinkingLevel() ?? params.agentCfg?.thinkingDefault,
		currentFastMode: typeof params.sessionEntry?.fastMode === "boolean" ? params.sessionEntry.fastMode : typeof params.agentEntry?.fastModeDefault === "boolean" ? params.agentEntry.fastModeDefault : void 0,
		currentVerboseLevel: params.sessionEntry?.verboseLevel ?? params.agentCfg?.verboseDefault,
		currentReasoningLevel: params.sessionEntry?.reasoningLevel ?? params.agentEntry?.reasoningDefault ?? params.agentCfg?.reasoningDefault ?? "off",
		currentElevatedLevel: params.sessionEntry?.elevatedLevel ?? params.agentCfg?.elevatedDefault
	};
}
//#endregion
export { resolveCurrentDirectiveLevels as t };
