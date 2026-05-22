import * as grammy from "grammy";
const DEFAULT_TELEGRAM_UPDATE_TYPES = grammy.API_CONSTANTS?.DEFAULT_UPDATE_TYPES ?? [
	"message",
	"edited_message",
	"channel_post",
	"edited_channel_post",
	"business_connection",
	"business_message",
	"edited_business_message",
	"deleted_business_messages",
	"message_reaction",
	"message_reaction_count",
	"inline_query",
	"chosen_inline_result",
	"callback_query",
	"shipping_query",
	"pre_checkout_query",
	"poll",
	"poll_answer",
	"my_chat_member",
	"chat_member",
	"chat_join_request"
];
function resolveTelegramAllowedUpdates() {
	const updates = [...DEFAULT_TELEGRAM_UPDATE_TYPES];
	if (!updates.includes("message_reaction")) updates.push("message_reaction");
	if (!updates.includes("channel_post")) updates.push("channel_post");
	return updates;
}
//#endregion
export { resolveTelegramAllowedUpdates as t };
