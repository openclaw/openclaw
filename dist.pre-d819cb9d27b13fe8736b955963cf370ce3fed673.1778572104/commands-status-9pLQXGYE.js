import { r as logVerbose } from "./globals-2rjcRy6M.js";
import { t as buildStatusText } from "./status-text-BjzRHavn.js";
//#region src/auto-reply/reply/commands-status.ts
async function buildStatusReply(params) {
	const { command } = params;
	if (!command.isAuthorizedSender) {
		logVerbose(`Ignoring /status from unauthorized sender: ${command.senderId || "<unknown>"}`);
		return;
	}
	return { text: await buildStatusText({
		...params,
		statusChannel: command.channel
	}) };
}
//#endregion
export { buildStatusReply as t };
