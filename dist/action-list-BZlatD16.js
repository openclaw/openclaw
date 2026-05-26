import { n as buildSubagentList } from "./subagent-list-GHsV668o.js";
import { u as stopWithText } from "./shared-DJehim_x.js";
//#region src/auto-reply/reply/commands-subagents/action-list.ts
function handleSubagentsListAction(ctx) {
	const { params, runs } = ctx;
	const list = buildSubagentList({
		cfg: params.cfg,
		runs,
		recentMinutes: 30,
		taskMaxChars: 110
	});
	const lines = ["active subagents:", "-----"];
	if (list.active.length === 0) lines.push("(none)");
	else lines.push(list.active.map((entry) => entry.line).join("\n"));
	lines.push("", `recent subagents (last 30m):`, "-----");
	if (list.recent.length === 0) lines.push("(none)");
	else lines.push(list.recent.map((entry) => entry.line).join("\n"));
	return stopWithText(lines.join("\n"));
}
//#endregion
export { handleSubagentsListAction };
