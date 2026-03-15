import "./redact-CPjO5IzK.js";
import "./errors-CHvVoeNX.js";
import "./unhandled-rejections-BUxLQs1F.js";
import "./globals-I5DlBD2D.js";
import "./paths-1qR_mW4i.js";
import "./theme-UkqnBJaj.js";
import "./subsystem-EnljYYs1.js";
import "./ansi-YpD2Ho3J.js";
import "./boolean-B938tROv.js";
import "./env-Bdj-riuG.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-Do8MzKyM.js";
import "./links-Cx-Xmp-Y.js";
import { hf as createFeishuClient, pf as probeFeishu, xf as resolveFeishuAccount } from "./auth-profiles-DqxBs6Au.js";
import "./plugins-allowlist-CTOQWcBK.js";
import "./registry-DrRO3PZ7.js";
import "./fetch-DM2X1MUS.js";
import "./config-state-Dtu4rsXl.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-CA0yK887.js";
import "./method-scopes-DDb5C1xl.js";
import "./plugins-CygWjihb.js";
import "./brew-BBTHZkpM.js";
import "./agent-scope-tkfLX5MZ.js";
import "./logger-BwHrL168.js";
import "./exec-Fh3CK0qE.js";
import "./env-overrides-ArVaLl04.js";
import "./safe-text-ByhWP-8W.js";
import "./version-Dubp0iGu.js";
import "./config-VO8zzMSR.js";
import "./workspace-dirs-D1oDbsnN.js";
import "./search-manager-DIDe1qlM.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-CcKf_qr0.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-eb8njEg8.js";
import "./commands-BRfqrztE.js";
import "./ports-DeHp-MTZ.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-Cu8erp19.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-CfAp_q6e.js";
import "./paths-YN5WLIkL.js";
import "./session-cost-usage-DeAwWk6A.js";
import "./fetch-CzYOE42F.js";
import "./identity-file-Dh-pAEVE.js";
import "./dm-policy-shared-qfNerugD.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-BI0f8wZY.js";
import "./prompt-style-DqOsOwLH.js";
import "./secret-file-Bd-d3WTG.js";
import "./token-C5m9DX_R.js";
import "./restart-stale-pids-DzpGvXwg.js";
import "./accounts-B1y-wv7m.js";
import "./audit-CmcUcZU1.js";
import "./cli-utils-DRykF2zj.js";
import "./compat-Dz_94m24.js";
import "./inbound-envelope-CloZXXEC.js";
import "./device-pairing-BKsmUBWC.js";
import "./resolve-utils-Bz_rfQcP.js";
import { t as getFeishuRuntime } from "./runtime-B1xINGG1.js";
import { n as listFeishuDirectoryPeers, t as listFeishuDirectoryGroups } from "./directory.static-CNKEfeLv.js";
import { a as sendCardFeishu, c as sendStructuredCardFeishu, m as sendMediaFeishu, n as getMessageFeishu, o as sendMarkdownCardFeishu, s as sendMessageFeishu, t as editMessageFeishu } from "./send-DbWWJqAC.js";
import { Type } from "@sinclair/typebox";
import fs from "fs";
import path from "path";
//#region extensions/feishu/src/directory.ts
async function listFeishuDirectoryPeersLive(params) {
	const account = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) {return listFeishuDirectoryPeers(params);}
	try {
		const client = createFeishuClient(account);
		const peers = [];
		const limit = params.limit ?? 50;
		const response = await client.contact.user.list({ params: { page_size: Math.min(limit, 50) } });
		if (response.code !== 0) {throw new Error(response.msg || `code ${response.code}`);}
		for (const user of response.data?.items ?? []) {
			if (user.open_id) {
				const q = params.query?.trim().toLowerCase() || "";
				const name = user.name || "";
				if (!q || user.open_id.toLowerCase().includes(q) || name.toLowerCase().includes(q)) {peers.push({
					kind: "user",
					id: user.open_id,
					name: name || void 0
				});}
			}
			if (peers.length >= limit) {break;}
		}
		return peers;
	} catch (err) {
		if (params.fallbackToStatic === false) {throw err instanceof Error ? err : /* @__PURE__ */ new Error("Feishu live peer lookup failed");}
		return listFeishuDirectoryPeers(params);
	}
}
async function listFeishuDirectoryGroupsLive(params) {
	const account = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) {return listFeishuDirectoryGroups(params);}
	try {
		const client = createFeishuClient(account);
		const groups = [];
		const limit = params.limit ?? 50;
		const response = await client.im.chat.list({ params: { page_size: Math.min(limit, 100) } });
		if (response.code !== 0) {throw new Error(response.msg || `code ${response.code}`);}
		for (const chat of response.data?.items ?? []) {
			if (chat.chat_id) {
				const q = params.query?.trim().toLowerCase() || "";
				const name = chat.name || "";
				if (!q || chat.chat_id.toLowerCase().includes(q) || name.toLowerCase().includes(q)) {groups.push({
					kind: "group",
					id: chat.chat_id,
					name: name || void 0
				});}
			}
			if (groups.length >= limit) {break;}
		}
		return groups;
	} catch (err) {
		if (params.fallbackToStatic === false) {throw err instanceof Error ? err : /* @__PURE__ */ new Error("Feishu live group lookup failed");}
		return listFeishuDirectoryGroups(params);
	}
}
//#endregion
//#region extensions/feishu/src/outbound.ts
function normalizePossibleLocalImagePath(text) {
	const raw = text?.trim();
	if (!raw) {return null;}
	if (/\s/.test(raw)) {return null;}
	if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) {return null;}
	const ext = path.extname(raw).toLowerCase();
	if (![
		".jpg",
		".jpeg",
		".png",
		".gif",
		".webp",
		".bmp",
		".ico",
		".tiff"
	].includes(ext)) {return null;}
	if (!path.isAbsolute(raw)) {return null;}
	if (!fs.existsSync(raw)) {return null;}
	try {
		if (!fs.statSync(raw).isFile()) {return null;}
	} catch {
		return null;
	}
	return raw;
}
function shouldUseCard(text) {
	return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}
function resolveReplyToMessageId(params) {
	const replyToId = params.replyToId?.trim();
	if (replyToId) {return replyToId;}
	if (params.threadId == null) {return;}
	return String(params.threadId).trim() || void 0;
}
async function sendOutboundText(params) {
	const { cfg, to, text, accountId, replyToMessageId } = params;
	const renderMode = resolveFeishuAccount({
		cfg,
		accountId
	}).config?.renderMode ?? "auto";
	if (renderMode === "card" || renderMode === "auto" && shouldUseCard(text)) {return sendMarkdownCardFeishu({
		cfg,
		to,
		text,
		accountId,
		replyToMessageId
	});}
	return sendMessageFeishu({
		cfg,
		to,
		text,
		accountId,
		replyToMessageId
	});
}
const feishuOutbound = {
	deliveryMode: "direct",
	chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
	chunkerMode: "markdown",
	textChunkLimit: 4e3,
	sendText: async ({ cfg, to, text, accountId, replyToId, threadId, mediaLocalRoots, identity }) => {
		const replyToMessageId = resolveReplyToMessageId({
			replyToId,
			threadId
		});
		const localImagePath = normalizePossibleLocalImagePath(text);
		if (localImagePath) {try {
			return {
				channel: "feishu",
				...await sendMediaFeishu({
					cfg,
					to,
					mediaUrl: localImagePath,
					accountId: accountId ?? void 0,
					replyToMessageId,
					mediaLocalRoots
				})
			};
		} catch (err) {
			console.error(`[feishu] local image path auto-send failed:`, err);
		}}
		const renderMode = resolveFeishuAccount({
			cfg,
			accountId: accountId ?? void 0
		}).config?.renderMode ?? "auto";
		if (renderMode === "card" || renderMode === "auto" && shouldUseCard(text)) {
			const header = identity ? {
				title: identity.emoji ? `${identity.emoji} ${identity.name ?? ""}`.trim() : identity.name ?? "",
				template: "blue"
			} : void 0;
			return {
				channel: "feishu",
				...await sendStructuredCardFeishu({
					cfg,
					to,
					text,
					replyToMessageId,
					replyInThread: threadId != null && !replyToId,
					accountId: accountId ?? void 0,
					header: header?.title ? header : void 0
				})
			};
		}
		return {
			channel: "feishu",
			...await sendOutboundText({
				cfg,
				to,
				text,
				accountId: accountId ?? void 0,
				replyToMessageId
			})
		};
	},
	sendMedia: async ({ cfg, to, text, mediaUrl, accountId, mediaLocalRoots, replyToId, threadId }) => {
		const replyToMessageId = resolveReplyToMessageId({
			replyToId,
			threadId
		});
		if (text?.trim()) {await sendOutboundText({
			cfg,
			to,
			text,
			accountId: accountId ?? void 0,
			replyToMessageId
		});}
		if (mediaUrl) {try {
			return {
				channel: "feishu",
				...await sendMediaFeishu({
					cfg,
					to,
					mediaUrl,
					accountId: accountId ?? void 0,
					mediaLocalRoots,
					replyToMessageId
				})
			};
		} catch (err) {
			console.error(`[feishu] sendMediaFeishu failed:`, err);
			return {
				channel: "feishu",
				...await sendOutboundText({
					cfg,
					to,
					text: `📎 ${mediaUrl}`,
					accountId: accountId ?? void 0,
					replyToMessageId
				})
			};
		}}
		return {
			channel: "feishu",
			...await sendOutboundText({
				cfg,
				to,
				text: text ?? "",
				accountId: accountId ?? void 0,
				replyToMessageId
			})
		};
	}
};
//#endregion
//#region extensions/feishu/src/pins.ts
function assertFeishuPinApiSuccess(response, action) {
	if (response.code !== 0) {throw new Error(`Feishu ${action} failed: ${response.msg || `code ${response.code}`}`);}
}
function normalizePin(pin) {
	return {
		messageId: pin.message_id,
		chatId: pin.chat_id,
		operatorId: pin.operator_id,
		operatorIdType: pin.operator_id_type,
		createTime: pin.create_time
	};
}
async function createPinFeishu(params) {
	const account = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) {throw new Error(`Feishu account "${account.accountId}" not configured`);}
	const response = await createFeishuClient(account).im.pin.create({ data: { message_id: params.messageId } });
	assertFeishuPinApiSuccess(response, "pin create");
	return response.data?.pin ? normalizePin(response.data.pin) : null;
}
async function removePinFeishu(params) {
	const account = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) {throw new Error(`Feishu account "${account.accountId}" not configured`);}
	assertFeishuPinApiSuccess(await createFeishuClient(account).im.pin.delete({ path: { message_id: params.messageId } }), "pin delete");
}
async function listPinsFeishu(params) {
	const account = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) {throw new Error(`Feishu account "${account.accountId}" not configured`);}
	const response = await createFeishuClient(account).im.pin.list({ params: {
		chat_id: params.chatId,
		...params.startTime ? { start_time: params.startTime } : {},
		...params.endTime ? { end_time: params.endTime } : {},
		...typeof params.pageSize === "number" ? { page_size: Math.max(1, Math.min(100, Math.floor(params.pageSize))) } : {},
		...params.pageToken ? { page_token: params.pageToken } : {}
	} });
	assertFeishuPinApiSuccess(response, "pin list");
	return {
		chatId: params.chatId,
		pins: (response.data?.items ?? []).map(normalizePin),
		hasMore: response.data?.has_more === true,
		pageToken: response.data?.page_token
	};
}
//#endregion
//#region extensions/feishu/src/reactions.ts
function resolveConfiguredFeishuClient(params) {
	const account = resolveFeishuAccount(params);
	if (!account.configured) {throw new Error(`Feishu account "${account.accountId}" not configured`);}
	return createFeishuClient(account);
}
function assertFeishuReactionApiSuccess(response, action) {
	if (response.code !== 0) {throw new Error(`Feishu ${action} failed: ${response.msg || `code ${response.code}`}`);}
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
	if (!reactionId) {throw new Error("Feishu add reaction failed: no reaction_id returned");}
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
Type.Object({
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
async function getChatInfo(client, chatId) {
	const res = await client.im.chat.get({ path: { chat_id: chatId } });
	if (res.code !== 0) {throw new Error(res.msg);}
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
	if (res.code !== 0) {throw new Error(res.msg);}
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
	if (res.code !== 0) {throw new Error(res.msg);}
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
//#endregion
export { addReactionFeishu, createPinFeishu, editMessageFeishu, feishuOutbound, getChatInfo, getChatMembers, getFeishuMemberInfo, getMessageFeishu, listFeishuDirectoryGroupsLive, listFeishuDirectoryPeersLive, listPinsFeishu, listReactionsFeishu, probeFeishu, removePinFeishu, removeReactionFeishu, sendCardFeishu, sendMessageFeishu };
