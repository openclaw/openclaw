import { n as buildSubagentsHelp, u as stopWithText } from "./shared-TJHpIUsW.js";
//#region src/auto-reply/reply/commands-subagents/action-help.ts
function handleSubagentsHelpAction() {
	return stopWithText(buildSubagentsHelp());
}
//#endregion
export { handleSubagentsHelpAction };
