import { i as killControlledSubagentRun, r as killAllControlledSubagentRuns } from "./subagent-control-lL9C38ND.js";
import { c as resolveSubagentEntryForToken, i as resolveCommandSubagentController, u as stopWithText } from "./shared-DJehim_x.js";
import "./commands-subagents-control.runtime-ChNGWh5_.js";
//#region src/auto-reply/reply/commands-subagents/action-kill.ts
async function handleSubagentsKillAction(ctx) {
	const { params, handledPrefix, requesterKey, runs, restTokens } = ctx;
	const target = restTokens[0];
	if (!target) return stopWithText(handledPrefix === "/subagents" ? "Usage: /subagents kill <id|#|all>" : "Usage: /kill <id|#|all>");
	if (target === "all" || target === "*") {
		const controller = resolveCommandSubagentController(params, requesterKey);
		const result = await killAllControlledSubagentRuns({
			cfg: params.cfg,
			controller,
			runs
		});
		if (result.status === "forbidden") return stopWithText(`⚠️ ${result.error}`);
		if (result.killed > 0) return { shouldContinue: false };
		return { shouldContinue: false };
	}
	const targetResolution = resolveSubagentEntryForToken(runs, target);
	if ("reply" in targetResolution) return targetResolution.reply;
	const controller = resolveCommandSubagentController(params, requesterKey);
	const result = await killControlledSubagentRun({
		cfg: params.cfg,
		controller,
		entry: targetResolution.entry
	});
	if (result.status === "forbidden") return stopWithText(`⚠️ ${result.error}`);
	if (result.status === "done") return stopWithText(result.text);
	return { shouldContinue: false };
}
//#endregion
export { handleSubagentsKillAction };
