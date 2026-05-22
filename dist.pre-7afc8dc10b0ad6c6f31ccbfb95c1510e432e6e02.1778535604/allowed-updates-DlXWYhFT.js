import { API_CONSTANTS } from "grammy";
//#region extensions/telegram/src/allowed-updates.ts
const DEFAULT_TELEGRAM_UPDATE_TYPES = API_CONSTANTS.DEFAULT_UPDATE_TYPES;
function resolveTelegramAllowedUpdates() {
	const updates = [...DEFAULT_TELEGRAM_UPDATE_TYPES];
	if (!updates.includes("message_reaction")) updates.push("message_reaction");
	if (!updates.includes("channel_post")) updates.push("channel_post");
	return updates;
}
//#endregion
export { resolveTelegramAllowedUpdates as t };
