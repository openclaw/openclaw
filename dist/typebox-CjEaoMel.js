import "./channel-target-Nug_hTy8.js";
import { Type } from "typebox";
//#region src/agents/schema/string-enum.ts
function stringEnum(values, options = {}) {
	const enumValues = Array.isArray(values) ? values : values && typeof values === "object" ? Object.values(values).filter((value) => typeof value === "string") : [];
	return Type.Unsafe({
		type: "string",
		...enumValues.length > 0 ? { enum: [...enumValues] } : {},
		...options
	});
}
function optionalStringEnum(values, options = {}) {
	return Type.Optional(stringEnum(values, options));
}
//#endregion
//#region src/agents/schema/typebox.ts
function channelTargetSchema(options) {
	return Type.String({ description: options?.description ?? "Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id" });
}
function channelTargetsSchema(options) {
	return Type.Array(channelTargetSchema({ description: options?.description ?? "Recipient/channel targets (same format as --target); accepts ids or names when the directory is available." }));
}
//#endregion
export { stringEnum as i, channelTargetsSchema as n, optionalStringEnum as r, channelTargetSchema as t };
