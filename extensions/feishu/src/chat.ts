import type * as Lark from "@larksuiteoapi/node-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { type FeishuChatParams, FeishuChatSchema } from "./chat-schema.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";

function json(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

export async function getChatInfo(client: Lark.Client, chatId: string) {
	const res = await client.im.chat.get({ path: { chat_id: chatId } });
	if (res.code !== 0) {
		throw new Error(res.msg);
	}

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
		avatar: chat?.avatar,
	};
}

export async function getChatMembers(
	client: Lark.Client,
	chatId: string,
	pageSize?: number,
	pageToken?: string,
	memberIdType?: "open_id" | "user_id" | "union_id",
) {
	const page_size = pageSize ? Math.max(1, Math.min(100, pageSize)) : 50;
	const res = await client.im.chatMembers.get({
		path: { chat_id: chatId },
		params: {
			page_size,
			page_token: pageToken,
			member_id_type: memberIdType ?? "open_id",
		},
	});

	if (res.code !== 0) {
		throw new Error(res.msg);
	}

	return {
		chat_id: chatId,
		has_more: res.data?.has_more,
		page_token: res.data?.page_token,
		members:
			res.data?.items?.map((item) => ({
				member_id: item.member_id,
				name: item.name,
				tenant_key: item.tenant_key,
				member_id_type: item.member_id_type,
			})) ?? [],
	};
}

export async function getFeishuMemberInfo(
	client: Lark.Client,
	memberId: string,
	memberIdType: "open_id" | "user_id" | "union_id" = "open_id",
) {
	const res = await client.contact.user.get({
		path: { user_id: memberId },
		params: {
			user_id_type: memberIdType,
			department_id_type: "open_department_id",
		},
	});

	if (res.code !== 0) {
		throw new Error(res.msg);
	}

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
		geo: user?.geo,
	};
}

/**
 * Parse Feishu message body content into a plain-text string.
 * Feishu stores message body as a JSON string whose structure depends on msg_type.
 * For text messages, the JSON has a `text` field. For post (rich text), we extract
 * inline text from a single locale (zh_cn preferred). For other types we return a summary.
 */
function parseMessageContent(
	msgType: string | undefined,
	bodyContent: string | undefined,
): string {
	if (!bodyContent) {
		return "";
	}
	try {
		const parsed = JSON.parse(bodyContent);
		if (msgType === "text") {
			return typeof parsed.text === "string" ? parsed.text : bodyContent;
		}
		if (msgType === "post") {
			// Rich-text post: pick a single locale (zh_cn preferred, then first available).
			const locale = (parsed.zh_cn ??
				parsed.en_us ??
				Object.values(parsed)[0]) as
				| {
						title?: string;
						content?: Array<Array<{ tag: string; text?: string }>>;
				  }
				| undefined;
			if (!locale) {
				return bodyContent;
			}
			const lines: string[] = [];
			if (locale.title) {
				lines.push(locale.title);
			}
			if (Array.isArray(locale.content)) {
				for (const paragraph of locale.content) {
					if (!Array.isArray(paragraph)) {
						continue;
					}
					const texts = paragraph
						.filter(
							(el): el is { tag: string; text: string } =>
								el.tag === "text" && typeof el.text === "string",
						)
						.map((el) => el.text);
					if (texts.length > 0) {
						lines.push(texts.join(""));
					}
				}
			}
			return lines.join("\n") || bodyContent;
		}
		if (msgType === "image") {
			return "[image]";
		}
		if (msgType === "audio") {
			return "[audio]";
		}
		if (msgType === "video") {
			return "[video]";
		}
		if (msgType === "file") {
			return "[file]";
		}
		if (msgType === "sticker") {
			return "[sticker]";
		}
		if (msgType === "interactive") {
			return "[interactive card]";
		}
		if (msgType === "share_chat" || msgType === "share_user") {
			return `[${msgType}]`;
		}
		return bodyContent;
	} catch {
		return bodyContent;
	}
}

async function getChatHistory(
	client: Lark.Client,
	chatId: string,
	options?: {
		startTime?: string;
		endTime?: string;
		sortType?: "ByCreateTimeAsc" | "ByCreateTimeDesc";
		pageSize?: number;
		pageToken?: string;
	},
) {
	const pageSize = options?.pageSize
		? Math.max(1, Math.min(50, options.pageSize))
		: 20;
	const res = await client.im.message.list({
		params: {
			container_id_type: "chat",
			container_id: chatId,
			start_time: options?.startTime,
			end_time: options?.endTime,
			sort_type: options?.sortType ?? "ByCreateTimeDesc",
			page_size: pageSize,
			page_token: options?.pageToken,
		},
	});

	if (res.code !== 0) {
		throw new Error(res.msg ?? `Feishu API error (code ${res.code})`);
	}

	const messages =
		res.data?.items?.map((item) => ({
			message_id: item.message_id,
			msg_type: item.msg_type,
			create_time: item.create_time,
			sender: item.sender
				? {
						id: item.sender.id,
						id_type: item.sender.id_type,
						sender_type: item.sender.sender_type,
					}
				: undefined,
			content: parseMessageContent(item.msg_type, item.body?.content),
			deleted: item.deleted,
			updated: item.updated,
		})) ?? [];

	return {
		chat_id: chatId,
		has_more: res.data?.has_more,
		page_token: res.data?.page_token,
		messages,
	};
}

export function registerFeishuChatTools(api: OpenClawPluginApi) {
	if (!api.config) {
		api.logger.debug?.("feishu_chat: No config available, skipping chat tools");
		return;
	}

	const accounts = listEnabledFeishuAccounts(api.config);
	if (accounts.length === 0) {
		api.logger.debug?.(
			"feishu_chat: No Feishu accounts configured, skipping chat tools",
		);
		return;
	}

	const firstAccount = accounts[0];
	const toolsCfg = resolveToolsConfig(firstAccount.config.tools);
	if (!toolsCfg.chat) {
		api.logger.debug?.("feishu_chat: chat tool disabled in config");
		return;
	}

	const getClient = () => createFeishuClient(firstAccount);

	api.registerTool(
		{
			name: "feishu_chat",
			label: "Feishu Chat",
			description:
				"Feishu chat operations. Actions: members, info, member_info, history",
			parameters: FeishuChatSchema,
			async execute(_toolCallId, params) {
				const p = params as FeishuChatParams;
				try {
					const client = getClient();
					switch (p.action) {
						case "members":
							if (!p.chat_id) {
								return json({
									error: "chat_id is required for action members",
								});
							}
							return json(
								await getChatMembers(
									client,
									p.chat_id,
									p.page_size,
									p.page_token,
									p.member_id_type,
								),
							);
						case "info":
							if (!p.chat_id) {
								return json({ error: "chat_id is required for action info" });
							}
							return json(await getChatInfo(client, p.chat_id));
						case "member_info":
							if (!p.member_id) {
								return json({
									error: "member_id is required for action member_info",
								});
							}
							return json(
								await getFeishuMemberInfo(
									client,
									p.member_id,
									p.member_id_type ?? "open_id",
								),
							);
						case "history":
							if (!p.chat_id) {
								return json({
									error: "chat_id is required for action history",
								});
							}
							return json(
								await getChatHistory(client, p.chat_id, {
									startTime: p.start_time,
									endTime: p.end_time,
									sortType: p.sort_type,
									pageSize: p.page_size,
									pageToken: p.page_token,
								}),
							);
						default:
							return json({ error: `Unknown action: ${String(p.action)}` });
					}
				} catch (err) {
					return json({ error: formatErrorMessage(err) });
				}
			},
		},
		{ name: "feishu_chat" },
	);

	api.logger.debug?.("feishu_chat: Registered feishu_chat tool");
}
