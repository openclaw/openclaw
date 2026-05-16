import { t as __exportAll } from "./rolldown-runtime-C3SqQTfK.js";
import { et as createThread, ot as getChannelMessage, rt as editChannel, t as discord_exports } from "./discord-eZlimVfW.js";
import { a as resolveDiscordChannelParentSafe, i as resolveDiscordChannelParentIdSafe, r as resolveDiscordChannelNameSafe, t as resolveDiscordChannelIdSafe } from "./channel-access-ewDxhd9q.js";
import { s as withAbortTimeout } from "./timeouts-C7jeTtGs.js";
import { c as resolveDiscordChannelInfo, l as resolveDiscordMessageChannelId, n as resolveDiscordForwardedMessagesTextFromSnapshots, t as resolveDiscordEmbedText } from "./message-utils-Dmgu-7fC.js";
import { normalizeOptionalString, normalizeOptionalStringifiedId, truncateUtf16Safe } from "openclaw/plugin-sdk/text-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveChannelModelOverride } from "openclaw/plugin-sdk/model-session-runtime";
import { completeWithPreparedSimpleCompletionModel, extractAssistantText, prepareSimpleCompletionModelForAgent } from "openclaw/plugin-sdk/simple-completion-runtime";
import { createReplyReferencePlanner } from "openclaw/plugin-sdk/reply-reference";
//#region extensions/discord/src/monitor/thread-title.ts
const DEFAULT_THREAD_TITLE_TIMEOUT_MS = 1e4;
const MAX_THREAD_TITLE_SOURCE_CHARS = 600;
const MAX_THREAD_TITLE_CHANNEL_NAME_CHARS = 120;
const MAX_THREAD_TITLE_CHANNEL_DESCRIPTION_CHARS = 320;
const DISCORD_THREAD_TITLE_MAX_TOKENS = 512;
const DISCORD_THREAD_TITLE_SYSTEM_PROMPT = "Generate a concise Discord thread title (3-6 words). Return only the title. Use channel context when provided and avoid redundant channel-name words unless needed for clarity.";
async function generateThreadTitle(params) {
	const sourceText = params.messageText.trim();
	if (!sourceText) return null;
	const prepared = await prepareSimpleCompletionModelForAgent({
		cfg: params.cfg,
		agentId: params.agentId,
		...params.modelRef ? { modelRef: params.modelRef } : {},
		allowMissingApiKeyModes: ["aws-sdk"]
	});
	if ("error" in prepared) {
		const modelLabel = prepared.selection ? `${prepared.selection.provider}/${prepared.selection.modelId}` : "unknown";
		logVerbose(`thread-title: ${prepared.error} (agent=${params.agentId}, model=${modelLabel})`);
		return null;
	}
	try {
		const userMessage = buildThreadTitleUserMessage({
			sourceText: truncateThreadTitleSourceText(sourceText),
			channelName: params.channelName,
			channelDescription: params.channelDescription
		});
		const timeoutMs = resolveThreadTitleTimeoutMs(params.timeoutMs);
		return normalizeGeneratedThreadTitle(extractAssistantText(await completeThreadTitle({
			model: prepared.model,
			auth: prepared.auth,
			userMessage,
			timeoutMs
		}))) || null;
	} catch (err) {
		logVerbose(`thread-title: title generation failed for agent ${params.agentId}: ${String(err)}`);
		return null;
	}
}
async function completeThreadTitle(params) {
	return await withAbortTimeout({
		timeoutMs: params.timeoutMs,
		createTimeoutError: () => /* @__PURE__ */ new Error(`thread-title timed out after ${params.timeoutMs}ms`),
		run: async (signal) => await completeWithPreparedSimpleCompletionModel({
			model: params.model,
			auth: params.auth,
			context: {
				systemPrompt: DISCORD_THREAD_TITLE_SYSTEM_PROMPT,
				messages: [{
					role: "user",
					content: params.userMessage,
					timestamp: Date.now()
				}]
			},
			options: {
				maxTokens: DISCORD_THREAD_TITLE_MAX_TOKENS,
				signal
			}
		})
	});
}
function buildThreadTitleUserMessage(params) {
	const channelName = normalizeTitleContextField(params.channelName, MAX_THREAD_TITLE_CHANNEL_NAME_CHARS);
	const channelDescription = normalizeTitleContextField(params.channelDescription, MAX_THREAD_TITLE_CHANNEL_DESCRIPTION_CHARS);
	const messageLines = [];
	if (channelName) messageLines.push(`Channel: ${channelName}`);
	if (channelDescription) messageLines.push(`Channel description: ${channelDescription}`);
	messageLines.push(`Message:\n${params.sourceText}`);
	return messageLines.join("\n\n");
}
function truncateThreadTitleSourceText(sourceText) {
	if (sourceText.length <= MAX_THREAD_TITLE_SOURCE_CHARS) return sourceText;
	return `${sourceText.slice(0, MAX_THREAD_TITLE_SOURCE_CHARS)}...`;
}
function resolveThreadTitleTimeoutMs(timeoutMs) {
	return Math.max(100, Math.floor(timeoutMs ?? DEFAULT_THREAD_TITLE_TIMEOUT_MS));
}
function normalizeGeneratedThreadTitle(raw) {
	const lines = raw.replace(/\r/g, "").split("\n");
	let firstLine = "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (!firstLine && trimmed.startsWith("```")) continue;
		firstLine = trimmed;
		break;
	}
	return stripThreadTitleWrappers(firstLine);
}
function stripThreadTitleWrappers(raw) {
	let current = raw.trim();
	let previous = "";
	while (current && current !== previous) {
		previous = current;
		current = current.replace(/^["'`]+|["'`]+$/g, "").trim();
		current = current.replace(/^\*\*(.+)\*\*$/u, "$1").trim();
		current = current.replace(/^__(.+)__$/u, "$1").trim();
		current = current.replace(/^\*(.+)\*$/u, "$1").trim();
		current = current.replace(/^_(.+)_$/u, "$1").trim();
		current = current.replace(/^~~(.+)~~$/u, "$1").trim();
	}
	return current;
}
function normalizeTitleContextField(raw, maxChars) {
	const value = raw?.trim();
	if (!value) return;
	const singleLine = value.replace(/\s+/g, " ");
	if (singleLine.length <= maxChars) return singleLine;
	return `${singleLine.slice(0, maxChars)}...`;
}
//#endregion
//#region extensions/discord/src/monitor/threading.cache.ts
const DISCORD_THREAD_STARTER_CACHE_TTL_MS = 300 * 1e3;
const DISCORD_THREAD_STARTER_CACHE_MAX = 500;
const DISCORD_THREAD_STARTER_CACHE = /* @__PURE__ */ new Map();
function __resetDiscordThreadStarterCacheForTest() {
	DISCORD_THREAD_STARTER_CACHE.clear();
}
function getCachedThreadStarter(key, now) {
	const entry = DISCORD_THREAD_STARTER_CACHE.get(key);
	if (!entry) return;
	if (now - entry.updatedAt > DISCORD_THREAD_STARTER_CACHE_TTL_MS) {
		DISCORD_THREAD_STARTER_CACHE.delete(key);
		return;
	}
	DISCORD_THREAD_STARTER_CACHE.delete(key);
	DISCORD_THREAD_STARTER_CACHE.set(key, {
		...entry,
		updatedAt: now
	});
	return entry.value;
}
function setCachedThreadStarter(key, value, now) {
	DISCORD_THREAD_STARTER_CACHE.delete(key);
	DISCORD_THREAD_STARTER_CACHE.set(key, {
		value,
		updatedAt: now
	});
	while (DISCORD_THREAD_STARTER_CACHE.size > DISCORD_THREAD_STARTER_CACHE_MAX) {
		const iter = DISCORD_THREAD_STARTER_CACHE.keys().next();
		if (iter.done) break;
		DISCORD_THREAD_STARTER_CACHE.delete(iter.value);
	}
}
//#endregion
//#region extensions/discord/src/monitor/threading.starter.ts
function isDiscordThreadType(type) {
	return type === discord_exports.ChannelType.PublicThread || type === discord_exports.ChannelType.PrivateThread || type === discord_exports.ChannelType.AnnouncementThread;
}
function isDiscordForumParentType(parentType) {
	return parentType === discord_exports.ChannelType.GuildForum || parentType === discord_exports.ChannelType.GuildMedia;
}
function resolveDiscordThreadChannel(params) {
	if (!params.isGuildMessage) return null;
	const { message, channelInfo } = params;
	const channel = "channel" in message ? message.channel : void 0;
	if (channel && typeof channel === "object" && "isThread" in channel && typeof channel.isThread === "function" && channel.isThread()) return channel;
	if (!isDiscordThreadType(channelInfo?.type)) return null;
	const messageChannelId = params.messageChannelId || resolveDiscordMessageChannelId({ message });
	if (!messageChannelId) return null;
	return {
		id: messageChannelId,
		name: channelInfo?.name ?? void 0,
		parentId: channelInfo?.parentId ?? void 0,
		parent: void 0,
		ownerId: channelInfo?.ownerId ?? void 0
	};
}
async function resolveDiscordThreadParentInfo(params) {
	const { threadChannel, channelInfo, client } = params;
	const parent = resolveDiscordChannelParentSafe(threadChannel);
	let parentId = resolveDiscordChannelParentIdSafe(threadChannel) ?? resolveDiscordChannelIdSafe(parent) ?? channelInfo?.parentId ?? void 0;
	if (!parentId && threadChannel.id) parentId = (await resolveDiscordChannelInfo(client, threadChannel.id))?.parentId ?? void 0;
	if (!parentId) return {};
	let parentName = resolveDiscordChannelNameSafe(parent);
	const parentInfo = await resolveDiscordChannelInfo(client, parentId);
	parentName = parentName ?? parentInfo?.name;
	const parentType = parentInfo?.type;
	return {
		id: parentId,
		name: parentName,
		type: parentType
	};
}
async function resolveDiscordThreadStarter(params) {
	const cacheKey = params.channel.id;
	const cached = getCachedThreadStarter(cacheKey, Date.now());
	if (cached) return cached;
	try {
		const messageChannelId = resolveDiscordThreadStarterMessageChannelId(params);
		if (!messageChannelId) return null;
		const starter = await fetchDiscordThreadStarterMessage({
			client: params.client,
			messageChannelId,
			threadId: params.channel.id
		});
		if (!starter) return null;
		const payload = buildDiscordThreadStarterPayload({
			starter,
			resolveTimestampMs: params.resolveTimestampMs
		});
		if (!payload) return null;
		setCachedThreadStarter(cacheKey, payload, Date.now());
		return payload;
	} catch {
		return null;
	}
}
function resolveDiscordThreadStarterMessageChannelId(params) {
	return isDiscordForumParentType(params.parentType) ? params.channel.id : params.parentId;
}
async function fetchDiscordThreadStarterMessage(params) {
	const starter = await getChannelMessage(params.client.rest, params.messageChannelId, params.threadId);
	return starter ? starter : null;
}
function buildDiscordThreadStarterPayload(params) {
	const text = resolveDiscordThreadStarterText(params.starter);
	if (!text) return null;
	return {
		text,
		...resolveDiscordThreadStarterIdentity(params.starter),
		timestamp: params.resolveTimestampMs(params.starter.timestamp) ?? void 0
	};
}
function resolveDiscordThreadStarterText(starter) {
	const content = normalizeOptionalString(starter.content) ?? "";
	const embedText = resolveDiscordEmbedText(starter.embeds?.[0]);
	const forwardedText = resolveDiscordForwardedMessagesTextFromSnapshots(starter.message_snapshots);
	return content || embedText || forwardedText;
}
function resolveDiscordThreadStarterIdentity(starter) {
	return {
		author: resolveDiscordThreadStarterAuthor(starter),
		authorId: starter.author?.id ?? void 0,
		authorName: starter.author?.username ?? void 0,
		authorTag: resolveDiscordThreadStarterAuthorTag(starter.author),
		memberRoleIds: resolveDiscordThreadStarterRoleIds(starter.member)
	};
}
function resolveDiscordThreadStarterAuthor(starter) {
	return starter.member?.nick ?? starter.member?.displayName ?? resolveDiscordThreadStarterAuthorTag(starter.author) ?? starter.author?.username ?? starter.author?.id ?? "Unknown";
}
function resolveDiscordThreadStarterAuthorTag(author) {
	if (!author?.username || !author.discriminator) return;
	if (author.discriminator !== "0") return `${author.username}#${author.discriminator}`;
	return author.username;
}
function resolveDiscordThreadStarterRoleIds(member) {
	return Array.isArray(member?.roles) ? member.roles : void 0;
}
function resolveDiscordReplyTarget(opts) {
	if (opts.replyToMode === "off") return;
	const replyToId = normalizeOptionalString(opts.replyToId);
	if (!replyToId) return;
	if (opts.replyToMode === "all") return replyToId;
	return opts.hasReplied ? void 0 : replyToId;
}
function sanitizeDiscordThreadName(rawName, fallbackId) {
	return truncateUtf16Safe(truncateUtf16Safe(rawName.replace(/<@!?\d+>/g, "").replace(/<@&\d+>/g, "").replace(/<#\d+>/g, "").replace(/\s+/g, " ").trim() || `Thread ${fallbackId}`, 80), 100) || `Thread ${fallbackId}`;
}
function resolveDiscordReplyDeliveryPlan(params) {
	const originalReplyTarget = params.replyTarget;
	let deliverTarget = originalReplyTarget;
	let replyTarget = originalReplyTarget;
	if (params.createdThreadId) {
		deliverTarget = `channel:${params.createdThreadId}`;
		replyTarget = deliverTarget;
	}
	const allowReference = deliverTarget === originalReplyTarget;
	const replyReference = createReplyReferencePlanner({
		replyToMode: allowReference ? params.replyToMode : "off",
		existingId: params.threadChannel ? params.messageId : void 0,
		startId: params.messageId,
		allowReference
	});
	return {
		deliverTarget,
		replyTarget,
		replyReference
	};
}
//#endregion
//#region extensions/discord/src/monitor/threading.auto-thread.ts
function resolveTrimmedDiscordMessageChannelId(params) {
	return (params.messageChannelId || resolveDiscordMessageChannelId({ message: params.message })).trim();
}
function resolveDiscordAutoThreadContext(params) {
	const createdThreadId = normalizeOptionalStringifiedId(params.createdThreadId) ?? "";
	if (!createdThreadId) return null;
	const messageChannelId = normalizeOptionalString(params.messageChannelId) ?? "";
	if (!messageChannelId) return null;
	const threadSessionKey = buildAgentSessionKey({
		agentId: params.agentId,
		channel: params.channel,
		peer: {
			kind: "channel",
			id: createdThreadId
		}
	});
	const parentSessionKey = buildAgentSessionKey({
		agentId: params.agentId,
		channel: params.channel,
		peer: {
			kind: "channel",
			id: messageChannelId
		}
	});
	return {
		createdThreadId,
		From: `${params.channel}:channel:${createdThreadId}`,
		To: `channel:${createdThreadId}`,
		OriginatingTo: `channel:${createdThreadId}`,
		SessionKey: threadSessionKey,
		ModelParentSessionKey: parentSessionKey,
		...params.parentInheritanceEnabled === true ? { ParentSessionKey: parentSessionKey } : {}
	};
}
async function resolveDiscordAutoThreadReplyPlan(params) {
	const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
	const originalReplyTarget = `channel:${params.threadChannel?.id ?? (messageChannelId || "unknown")}`;
	const createdThreadId = await maybeCreateDiscordAutoThread({
		client: params.client,
		message: params.message,
		messageChannelId: messageChannelId || void 0,
		channel: params.channel,
		isGuildMessage: params.isGuildMessage,
		channelConfig: params.channelConfig,
		threadChannel: params.threadChannel,
		channelType: params.channelType,
		channelName: params.channelName,
		channelDescription: params.channelDescription,
		baseText: params.baseText,
		combinedBody: params.combinedBody,
		cfg: params.cfg,
		agentId: params.agentId
	});
	const deliveryPlan = resolveDiscordReplyDeliveryPlan({
		replyTarget: originalReplyTarget,
		replyToMode: params.replyToMode,
		messageId: params.message.id,
		threadChannel: params.threadChannel,
		createdThreadId
	});
	const autoThreadContext = params.isGuildMessage ? resolveDiscordAutoThreadContext({
		agentId: params.agentId,
		channel: params.channel,
		messageChannelId,
		createdThreadId,
		parentInheritanceEnabled: params.threadParentInheritanceEnabled
	}) : null;
	return {
		...deliveryPlan,
		createdThreadId,
		autoThreadContext
	};
}
async function maybeCreateDiscordAutoThread(params) {
	if (!params.isGuildMessage) return;
	if (!params.channelConfig?.autoThread) return;
	if (params.threadChannel) return;
	if (params.channelType === discord_exports.ChannelType.GuildForum || params.channelType === discord_exports.ChannelType.GuildMedia || params.channelType === discord_exports.ChannelType.GuildVoice || params.channelType === discord_exports.ChannelType.GuildStageVoice) return;
	const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
	if (!messageChannelId) return;
	try {
		const rawThreadSource = params.baseText || params.combinedBody || "Thread";
		const threadName = sanitizeDiscordThreadName(rawThreadSource, params.message.id);
		const archiveDuration = params.channelConfig?.autoArchiveDuration ? Number(params.channelConfig.autoArchiveDuration) : 60;
		const createdId = (await createThread(params.client.rest, messageChannelId, { body: {
			name: threadName,
			auto_archive_duration: archiveDuration
		} }, params.message.id))?.id || "";
		if (createdId && params.channelConfig?.autoThreadName === "generated" && params.cfg && params.agentId) {
			const modelRef = resolveDiscordThreadTitleModelRef({
				cfg: params.cfg,
				channel: params.channel,
				agentId: params.agentId,
				threadId: createdId,
				messageChannelId,
				channelName: params.channelName
			});
			maybeRenameDiscordAutoThread({
				client: params.client,
				threadId: createdId,
				currentName: threadName,
				fallbackId: params.message.id,
				sourceText: rawThreadSource,
				modelRef,
				channelName: params.channelName,
				channelDescription: params.channelDescription,
				cfg: params.cfg,
				agentId: params.agentId
			});
		}
		return createdId || void 0;
	} catch (err) {
		logVerbose(`discord: autoThread creation failed for ${messageChannelId}/${params.message.id}: ${String(err)}`);
		try {
			const existingThreadId = (await getChannelMessage(params.client.rest, messageChannelId, params.message.id))?.thread?.id || "";
			if (existingThreadId) {
				logVerbose(`discord: autoThread reusing existing thread ${existingThreadId} on ${messageChannelId}/${params.message.id}`);
				return existingThreadId;
			}
		} catch {}
		return;
	}
}
function resolveDiscordThreadTitleModelRef(params) {
	const channel = params.channel?.trim();
	if (!channel) return;
	const parentSessionKey = buildAgentSessionKey({
		agentId: params.agentId,
		channel,
		peer: {
			kind: "channel",
			id: params.messageChannelId
		}
	});
	const channelLabel = params.channelName?.trim();
	const groupChannel = channelLabel ? `#${channelLabel}` : void 0;
	return resolveChannelModelOverride({
		cfg: params.cfg,
		channel,
		groupId: params.threadId,
		groupChatType: "channel",
		groupChannel,
		groupSubject: groupChannel,
		parentSessionKey
	})?.model;
}
async function maybeRenameDiscordAutoThread(params) {
	try {
		const fallbackName = sanitizeDiscordThreadName("", params.fallbackId);
		const generated = await generateThreadTitle({
			cfg: params.cfg,
			agentId: params.agentId,
			messageText: params.sourceText,
			modelRef: params.modelRef,
			channelName: params.channelName,
			channelDescription: params.channelDescription
		});
		if (!generated) return;
		const nextName = sanitizeDiscordThreadName(generated, params.fallbackId);
		if (!nextName || nextName === params.currentName || nextName === fallbackName) return;
		await editChannel(params.client.rest, params.threadId, { body: { name: nextName } });
	} catch (err) {
		logVerbose(`discord: autoThread rename failed for ${params.threadId}: ${String(err)}`);
	}
}
//#endregion
//#region extensions/discord/src/monitor/threading.ts
var threading_exports = /* @__PURE__ */ __exportAll({
	__resetDiscordThreadStarterCacheForTest: () => __resetDiscordThreadStarterCacheForTest,
	maybeCreateDiscordAutoThread: () => maybeCreateDiscordAutoThread,
	resolveDiscordAutoThreadContext: () => resolveDiscordAutoThreadContext,
	resolveDiscordAutoThreadReplyPlan: () => resolveDiscordAutoThreadReplyPlan,
	resolveDiscordReplyDeliveryPlan: () => resolveDiscordReplyDeliveryPlan,
	resolveDiscordReplyTarget: () => resolveDiscordReplyTarget,
	resolveDiscordThreadChannel: () => resolveDiscordThreadChannel,
	resolveDiscordThreadParentInfo: () => resolveDiscordThreadParentInfo,
	resolveDiscordThreadStarter: () => resolveDiscordThreadStarter,
	sanitizeDiscordThreadName: () => sanitizeDiscordThreadName
});
//#endregion
export { resolveDiscordThreadStarter as a, resolveDiscordThreadParentInfo as i, resolveDiscordAutoThreadReplyPlan as n, sanitizeDiscordThreadName as o, resolveDiscordReplyTarget as r, threading_exports as t };
