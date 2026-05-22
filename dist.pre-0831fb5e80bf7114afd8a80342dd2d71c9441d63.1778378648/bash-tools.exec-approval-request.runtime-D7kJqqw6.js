import { t as explainShellCommand } from "./extract-CvLSCxDz.js";
//#region src/infra/command-explainer/format.ts
function spanToCommandSpan(span) {
	if (!Number.isSafeInteger(span.startIndex) || !Number.isSafeInteger(span.endIndex)) return null;
	if (span.startIndex < 0 || span.endIndex <= span.startIndex) return null;
	return {
		startIndex: span.startIndex,
		endIndex: span.endIndex
	};
}
function formatCommandSpans(explanation) {
	const commandSpans = [];
	for (const command of [...explanation.topLevelCommands, ...explanation.nestedCommands]) {
		const commandSpan = spanToCommandSpan(command.executableSpan);
		if (commandSpan) commandSpans.push(commandSpan);
	}
	return commandSpans;
}
//#endregion
//#region src/agents/bash-tools.exec-approval-request.runtime.ts
async function resolveExecApprovalCommandSpans(command) {
	const commandSpans = formatCommandSpans(await explainShellCommand(command));
	return commandSpans.length > 0 ? commandSpans : void 0;
}
//#endregion
export { resolveExecApprovalCommandSpans };
