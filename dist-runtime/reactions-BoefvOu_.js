import { Bo as resolveFeishuAccount, Lo as listEnabledFeishuAccounts, Po as createFeishuClient } from "./auth-profiles-B70DPAVa.js";
import { Type } from "@sinclair/typebox";
//#region extensions/feishu/src/tools-config.ts
/**
* Default tool configuration.
* - doc, chat, wiki, drive, scopes: enabled by default
* - perm: disabled by default (sensitive operation)
*/
const DEFAULT_TOOLS_CONFIG = {
	doc: true,
	chat: true,
	wiki: true,
	drive: true,
	perm: false,
	scopes: true
};
/**
* Resolve tools config with defaults.
*/
function resolveToolsConfig(cfg) {
	return {
		...DEFAULT_TOOLS_CONFIG,
		...cfg
	};
}
//#endregion
//#region extensions/feishu/src/chat-schema.ts
const CHAT_ACTION_VALUES = [
	"members",
	"info",
	"member_info"
];
const MEMBER_ID_TYPE_VALUES = [
	"open_id",
	"user_id",
	"union_id"
];
const FeishuChatSchema = Type.Object({
	action: Type.Unsafe({
		type: "string",
		enum: [...CHAT_ACTION_VALUES],
		description: "Action to run: members | info | member_info"
	}),
	chat_id: Type.Optional(Type.String({ description: "Chat ID (from URL or event payload)" })),
	member_id: Type.Optional(Type.String({ description: "Member ID for member_info lookups" })),
	page_size: Type.Optional(Type.Number({ description: "Page size (1-100, default 50)" })),
	page_token: Type.Optional(Type.String({ description: "Pagination token" })),
	member_id_type: Type.Optional(Type.Unsafe({
		type: "string",
		enum: [...MEMBER_ID_TYPE_VALUES],
		description: "Member ID type (default: open_id)"
	}))
});
//#endregion
//#region extensions/feishu/src/chat.ts
function json(data) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(data, null, 2)
		}],
		details: data
	};
}
async function getChatInfo(client, chatId) {
	const res = await client.im.chat.get({ path: { chat_id: chatId } });
	if (res.code !== 0) throw new Error(res.msg);
	const chat = res.data;
	return {
		chat_id: chatId,
		name: chat?.name,
		description: chat?.description,
		owner_id: chat?.owner_id,
		tenant_key: chat?.tenant_key,
		user_count: chat?.user_count,
		chat_mode: chat?.chat_mode,
		chat_type: chat?.chat_type,
		join_message_visibility: chat?.join_message_visibility,
		leave_message_visibility: chat?.leave_message_visibility,
		membership_approval: chat?.membership_approval,
		moderation_permission: chat?.moderation_permission,
		avatar: chat?.avatar
	};
}
async function getChatMembers(client, chatId, pageSize, pageToken, memberIdType) {
	const page_size = pageSize ? Math.max(1, Math.min(100, pageSize)) : 50;
	const res = await client.im.chatMembers.get({
		path: { chat_id: chatId },
		params: {
			page_size,
			page_token: pageToken,
			member_id_type: memberIdType ?? "open_id"
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		chat_id: chatId,
		has_more: res.data?.has_more,
		page_token: res.data?.page_token,
		members: res.data?.items?.map((item) => ({
			member_id: item.member_id,
			name: item.name,
			tenant_key: item.tenant_key,
			member_id_type: item.member_id_type
		})) ?? []
	};
}
async function getFeishuMemberInfo(client, memberId, memberIdType = "open_id") {
	const res = await client.contact.user.get({
		path: { user_id: memberId },
		params: {
			user_id_type: memberIdType,
			department_id_type: "open_department_id"
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	const user = res.data?.user;
	return {
		member_id: memberId,
		member_id_type: memberIdType,
		open_id: user?.open_id,
		user_id: user?.user_id,
		union_id: user?.union_id,
		name: user?.name,
		en_name: user?.en_name,
		nickname: user?.nickname,
		email: user?.email,
		enterprise_email: user?.enterprise_email,
		mobile: user?.mobile,
		mobile_visible: user?.mobile_visible,
		status: user?.status,
		avatar: user?.avatar,
		department_ids: user?.department_ids,
		department_path: user?.department_path,
		leader_user_id: user?.leader_user_id,
		city: user?.city,
		country: user?.country,
		work_station: user?.work_station,
		join_time: user?.join_time,
		is_tenant_manager: user?.is_tenant_manager,
		employee_no: user?.employee_no,
		employee_type: user?.employee_type,
		description: user?.description,
		job_title: user?.job_title,
		geo: user?.geo
	};
}
function registerFeishuChatTools(api) {
	if (!api.config) {
		api.logger.debug?.("feishu_chat: No config available, skipping chat tools");
		return;
	}
	const accounts = listEnabledFeishuAccounts(api.config);
	if (accounts.length === 0) {
		api.logger.debug?.("feishu_chat: No Feishu accounts configured, skipping chat tools");
		return;
	}
	const firstAccount = accounts[0];
	if (!resolveToolsConfig(firstAccount.config.tools).chat) {
		api.logger.debug?.("feishu_chat: chat tool disabled in config");
		return;
	}
	const getClient = () => createFeishuClient(firstAccount);
	api.registerTool({
		name: "feishu_chat",
		label: "Feishu Chat",
		description: "Feishu chat operations. Actions: members, info, member_info",
		parameters: FeishuChatSchema,
		async execute(_toolCallId, params) {
			const p = params;
			try {
				const client = getClient();
				switch (p.action) {
					case "members":
						if (!p.chat_id) return json({ error: "chat_id is required for action members" });
						return json(await getChatMembers(client, p.chat_id, p.page_size, p.page_token, p.member_id_type));
					case "info":
						if (!p.chat_id) return json({ error: "chat_id is required for action info" });
						return json(await getChatInfo(client, p.chat_id));
					case "member_info":
						if (!p.member_id) return json({ error: "member_id is required for action member_info" });
						return json(await getFeishuMemberInfo(client, p.member_id, p.member_id_type ?? "open_id"));
					default: return json({ error: `Unknown action: ${String(p.action)}` });
				}
			} catch (err) {
				return json({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	}, { name: "feishu_chat" });
	api.logger.info?.("feishu_chat: Registered feishu_chat tool");
}
//#endregion
//#region extensions/feishu/src/reactions.ts
function resolveConfiguredFeishuClient(params) {
	const account = resolveFeishuAccount(params);
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	return createFeishuClient(account);
}
function assertFeishuReactionApiSuccess(response, action) {
	if (response.code !== 0) throw new Error(`Feishu ${action} failed: ${response.msg || `code ${response.code}`}`);
}
/**
* Add a reaction (emoji) to a message.
* @param emojiType - Feishu emoji type, e.g., "SMILE", "THUMBSUP", "HEART"
* @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
*/
async function addReactionFeishu(params) {
	const { cfg, messageId, emojiType, accountId } = params;
	const response = await resolveConfiguredFeishuClient({
		cfg,
		accountId
	}).im.messageReaction.create({
		path: { message_id: messageId },
		data: { reaction_type: { emoji_type: emojiType } }
	});
	assertFeishuReactionApiSuccess(response, "add reaction");
	const reactionId = response.data?.reaction_id;
	if (!reactionId) throw new Error("Feishu add reaction failed: no reaction_id returned");
	return { reactionId };
}
/**
* Remove a reaction from a message.
*/
async function removeReactionFeishu(params) {
	const { cfg, messageId, reactionId, accountId } = params;
	assertFeishuReactionApiSuccess(await resolveConfiguredFeishuClient({
		cfg,
		accountId
	}).im.messageReaction.delete({ path: {
		message_id: messageId,
		reaction_id: reactionId
	} }), "remove reaction");
}
/**
* List all reactions for a message.
*/
async function listReactionsFeishu(params) {
	const { cfg, messageId, emojiType, accountId } = params;
	const response = await resolveConfiguredFeishuClient({
		cfg,
		accountId
	}).im.messageReaction.list({
		path: { message_id: messageId },
		params: emojiType ? { reaction_type: emojiType } : void 0
	});
	assertFeishuReactionApiSuccess(response, "list reactions");
	return (response.data?.items ?? []).map((item) => ({
		reactionId: item.reaction_id ?? "",
		emojiType: item.reaction_type?.emoji_type ?? "",
		operatorType: item.operator_type === "app" ? "app" : "user",
		operatorId: item.operator_id?.open_id ?? item.operator_id?.user_id ?? item.operator_id?.union_id ?? ""
	}));
}
/**
* Common Feishu emoji types for convenience.
* @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
*/
const FeishuEmoji = {
	THUMBSUP: "THUMBSUP",
	THUMBSDOWN: "THUMBSDOWN",
	HEART: "HEART",
	SMILE: "SMILE",
	GRINNING: "GRINNING",
	LAUGHING: "LAUGHING",
	CRY: "CRY",
	ANGRY: "ANGRY",
	SURPRISED: "SURPRISED",
	THINKING: "THINKING",
	CLAP: "CLAP",
	OK: "OK",
	FIST: "FIST",
	PRAY: "PRAY",
	FIRE: "FIRE",
	PARTY: "PARTY",
	CHECK: "CHECK",
	CROSS: "CROSS",
	QUESTION: "QUESTION",
	EXCLAMATION: "EXCLAMATION"
};
//#endregion
export { getChatInfo as a, registerFeishuChatTools as c, removeReactionFeishu as i, resolveToolsConfig as l, addReactionFeishu as n, getChatMembers as o, listReactionsFeishu as r, getFeishuMemberInfo as s, FeishuEmoji as t };
