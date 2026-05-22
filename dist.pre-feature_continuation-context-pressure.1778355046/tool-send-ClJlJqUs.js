import { f as readStringValue } from "./string-coerce-Bje8XVt9.js";
//#region src/plugin-sdk/tool-send.ts
/** Extract the canonical send target fields from tool arguments when the action matches. */
function extractToolSend(args, expectedAction = "sendMessage") {
	if ((readStringValue(args.action)?.trim() ?? "") !== expectedAction) return null;
	const to = readStringValue(args.to);
	if (!to) return null;
	const accountId = readStringValue(args.accountId)?.trim();
	const threadIdRaw = typeof args.threadId === "number" ? String(args.threadId) : readStringValue(args.threadId)?.trim() ?? "";
	return {
		to,
		accountId,
		threadId: threadIdRaw.length > 0 ? threadIdRaw : void 0
	};
}
//#endregion
export { extractToolSend as t };
