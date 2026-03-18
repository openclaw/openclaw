import "./provider-env-vars-BfZUtZAn.js";
import "./resolve-route-CQsiaDZO.js";
import "./logger-BOdgfoqz.js";
import "./tmp-openclaw-dir-DgEKZnX6.js";
import "./paths-CbmqEZIn.js";
import "./subsystem-CsPxmH8p.js";
import "./utils-CMc9mmF8.js";
import "./fetch-BgkAjqxB.js";
import "./retry-CgLvWye-.js";
import "./agent-scope-CM8plEdu.js";
import "./exec-CWMR162-.js";
import "./logger-C833gw0R.js";
import "./paths-DAoqckDF.js";
import { Bo as resolveFeishuAccount, Mo as probeFeishu, Po as createFeishuClient } from "./auth-profiles-B70DPAVa.js";
import "./profiles-BC4VpDll.js";
import "./fetch-BX2RRCzB.js";
import "./external-content-CxoN_TKD.js";
import "./kilocode-shared-Ci8SRxXc.js";
import "./models-config.providers.static-DRBnLpDj.js";
import "./models-config.providers.discovery-gVOHvGnm.js";
import "./pairing-token-Do-E3rL5.js";
import "./query-expansion-Do6vyPvH.js";
import "./redact-BZcL_gJG.js";
import "./mime-33LCeGh-.js";
import "./resolve-utils-D6VN4BvH.js";
import "./typebox-B4kR5eyM.js";
import "./web-search-plugin-factory-CeUlA68v.js";
import "./compat-CwB8x8Tr.js";
import "./inbound-envelope-DsYY1Vpm.js";
import "./run-command-B9zmAfEF.js";
import "./device-pairing-CsJif6Rb.js";
import "./line-DvbTO_h3.js";
import "./upsert-with-lock-BkGBN4WL.js";
import "./self-hosted-provider-setup-Bgv4n1Xv.js";
import "./ollama-setup-CXkNt6CA.js";
import { a as getChatInfo, i as removeReactionFeishu, n as addReactionFeishu, o as getChatMembers, r as listReactionsFeishu, s as getFeishuMemberInfo } from "./reactions-BoefvOu_.js";
import { t as getFeishuRuntime } from "./runtime-XB3y4bUE.js";
import { n as listFeishuDirectoryPeers, t as listFeishuDirectoryGroups } from "./directory.static-CI0691ej.js";
import { C as sendMediaFeishu, a as sendCardFeishu, c as sendStructuredCardFeishu, n as getMessageFeishu, o as sendMarkdownCardFeishu, s as sendMessageFeishu, t as editMessageFeishu } from "./send-tCWWXKu4.js";
import fs from "fs";
import path from "path";
//#region extensions/feishu/src/directory.ts
async function listFeishuDirectoryPeersLive(params) {
	const account = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) return listFeishuDirectoryPeers(params);
	try {
		const client = createFeishuClient(account);
		const peers = [];
		const limit = params.limit ?? 50;
		const response = await client.contact.user.list({ params: { page_size: Math.min(limit, 50) } });
		if (response.code !== 0) throw new Error(response.msg || `code ${response.code}`);
		for (const user of response.data?.items ?? []) {
			if (user.open_id) {
				const q = params.query?.trim().toLowerCase() || "";
				const name = user.name || "";
				if (!q || user.open_id.toLowerCase().includes(q) || name.toLowerCase().includes(q)) peers.push({
					kind: "user",
					id: user.open_id,
					name: name || void 0
				});
			}
			if (peers.length >= limit) break;
		}
		return peers;
	} catch (err) {
		if (params.fallbackToStatic === false) throw err instanceof Error ? err : /* @__PURE__ */ new Error("Feishu live peer lookup failed");
		return listFeishuDirectoryPeers(params);
	}
}
async function listFeishuDirectoryGroupsLive(params) {
	const account = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) return listFeishuDirectoryGroups(params);
	try {
		const client = createFeishuClient(account);
		const groups = [];
		const limit = params.limit ?? 50;
		const response = await client.im.chat.list({ params: { page_size: Math.min(limit, 100) } });
		if (response.code !== 0) throw new Error(response.msg || `code ${response.code}`);
		for (const chat of response.data?.items ?? []) {
			if (chat.chat_id) {
				const q = params.query?.trim().toLowerCase() || "";
				const name = chat.name || "";
				if (!q || chat.chat_id.toLowerCase().includes(q) || name.toLowerCase().includes(q)) groups.push({
					kind: "group",
					id: chat.chat_id,
					name: name || void 0
				});
			}
			if (groups.length >= limit) break;
		}
		return groups;
	} catch (err) {
		if (params.fallbackToStatic === false) throw err instanceof Error ? err : /* @__PURE__ */ new Error("Feishu live group lookup failed");
		return listFeishuDirectoryGroups(params);
	}
}
//#endregion
//#region extensions/feishu/src/outbound.ts
function normalizePossibleLocalImagePath(text) {
	const raw = text?.trim();
	if (!raw) return null;
	if (/\s/.test(raw)) return null;
	if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) return null;
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
	].includes(ext)) return null;
	if (!path.isAbsolute(raw)) return null;
	if (!fs.existsSync(raw)) return null;
	try {
		if (!fs.statSync(raw).isFile()) return null;
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
	if (replyToId) return replyToId;
	if (params.threadId == null) return;
	return String(params.threadId).trim() || void 0;
}
async function sendOutboundText(params) {
	const { cfg, to, text, accountId, replyToMessageId } = params;
	const renderMode = resolveFeishuAccount({
		cfg,
		accountId
	}).config?.renderMode ?? "auto";
	if (renderMode === "card" || renderMode === "auto" && shouldUseCard(text)) return sendMarkdownCardFeishu({
		cfg,
		to,
		text,
		accountId,
		replyToMessageId
	});
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
		if (localImagePath) try {
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
		}
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
		if (text?.trim()) await sendOutboundText({
			cfg,
			to,
			text,
			accountId: accountId ?? void 0,
			replyToMessageId
		});
		if (mediaUrl) try {
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
		}
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
	if (response.code !== 0) throw new Error(`Feishu ${action} failed: ${response.msg || `code ${response.code}`}`);
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
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	const response = await createFeishuClient(account).im.pin.create({ data: { message_id: params.messageId } });
	assertFeishuPinApiSuccess(response, "pin create");
	return response.data?.pin ? normalizePin(response.data.pin) : null;
}
async function removePinFeishu(params) {
	const account = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	assertFeishuPinApiSuccess(await createFeishuClient(account).im.pin.delete({ path: { message_id: params.messageId } }), "pin delete");
}
async function listPinsFeishu(params) {
	const account = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
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
export { addReactionFeishu, createPinFeishu, editMessageFeishu, feishuOutbound, getChatInfo, getChatMembers, getFeishuMemberInfo, getMessageFeishu, listFeishuDirectoryGroupsLive, listFeishuDirectoryPeersLive, listPinsFeishu, listReactionsFeishu, probeFeishu, removePinFeishu, removeReactionFeishu, sendCardFeishu, sendMessageFeishu };
