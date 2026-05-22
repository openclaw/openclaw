import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { i as callGateway } from "./call-BolF1jqz.js";
import { r as stripToolMessages } from "./chat-history-text-Cea00_dh.js";
import { t as formatRunLabel } from "./subagents-utils-DsO99glz.js";
import { c as resolveSubagentEntryForToken, r as formatLogLines, u as stopWithText } from "./shared-hnUJB1n7.js";
//#region src/auto-reply/reply/commands-subagents/action-log.ts
async function handleSubagentsLogAction(ctx) {
	const { runs, restTokens } = ctx;
	const target = restTokens[0];
	if (!target) return stopWithText("📜 Usage: /subagents log <id|#> [limit]");
	const includeTools = restTokens.some((token) => normalizeLowercaseStringOrEmpty(token) === "tools");
	const limitToken = restTokens.find((token) => /^\d+$/.test(token));
	const limit = limitToken ? Math.min(200, Math.max(1, Number.parseInt(limitToken, 10))) : 20;
	const targetResolution = resolveSubagentEntryForToken(runs, target);
	if ("reply" in targetResolution) return targetResolution.reply;
	const history = await callGateway({
		method: "chat.history",
		params: {
			sessionKey: targetResolution.entry.childSessionKey,
			limit
		}
	});
	const rawMessages = Array.isArray(history?.messages) ? history.messages : [];
	const lines = formatLogLines(includeTools ? rawMessages : stripToolMessages(rawMessages));
	const header = `📜 Subagent log: ${formatRunLabel(targetResolution.entry)}`;
	if (lines.length === 0) return stopWithText(`${header}\n(no messages)`);
	return stopWithText([header, ...lines].join("\n"));
}
//#endregion
export { handleSubagentsLogAction };
