import { _ as init_account_id, d as resolveAgentIdFromSessionKey, f as resolveThreadSessionKeys, s as init_session_key, v as normalizeAccountId } from "./session-key-BwICpQs5.js";
import { A as parsePluginBindingApprovalCustomId, Bt as warnMissingProviderGroupPolicyFallbackOnce, Ct as formatDiscordUserTag, D as init_conversation_binding, Et as resolveTimestampMs, Lt as resolveDefaultGroupPolicy, N as getSessionBindingService, Nt as GROUP_POLICY_BLOCKED_LABEL, O as isPluginOwnedSessionBindingRecord, P as init_session_binding_service, Pt as init_runtime_group_policy, Qt as init_accounts, Rt as resolveOpenProviderRuntimeGroupPolicy, St as formatDiscordReactionEmoji, Tt as resolveDiscordSystemLocation, _ as executePluginCommand, _t as resolveDiscordOwnerAccess, an as resolveDiscordMaxLinesPerMessage, bn as resolveAccountEntry, bt as resolveGroupDmAllow, ct as listDiscordDirectoryPeersLive, d as init_interactive, dt as normalizeDiscordAllowList, ft as normalizeDiscordSlug, gt as resolveDiscordMemberAccessState, ht as resolveDiscordGuildEntry, j as resolvePluginConversationBindingApproval, lt as init_allow_list, mt as resolveDiscordChannelConfigWithFallback, on as init_token, ot as init_directory_live, pt as resolveDiscordAllowListMatch, rn as resolveDiscordAccount, sn as normalizeDiscordToken, st as listDiscordDirectoryGroupsLive, u as dispatchPluginInteractiveHandler, ut as isDiscordGroupAllowedByPolicy, v as getPluginCommandSpecs, vt as resolveDiscordOwnerAllowFrom, w as buildPluginBindingResolvedText, wt as init_format, x as matchPluginCommand, xt as shouldEmitDiscordReactionNotification, y as init_commands, yn as init_account_lookup, yt as resolveDiscordShouldRequireMention } from "./runtime-CDMAx_h4.js";
import { $o as listNativeCommandSpecsForConfig, $s as createNoopThreadBindingManager, Ac as sendDiscordComponentMessage, Al as createDiscordRetryRunner, Ao as writeJsonFileAtomically, Bc as sendMessageDiscord, Bu as resolveChunkMode, Cc as auditDiscordChannelPermissions, Dn as listSkillCommandsForAgents, Do as buildPairingReply, Ec as reactMessageDiscord, El as stripUndefinedFields, Eo as issuePairingChallenge, Fc as parseDiscordModalCustomId, Fu as getAgentScopedMediaLocalRoots, Gc as formatMention, Gs as setPresence, Gt as readStoreAllowFromForDmPolicy, Hd as saveMediaBuffer, Ht as shouldDebounceTextInbound, Ic as parseDiscordModalCustomIdForCarbon, Il as inspectDiscordAccount, Io as createTypingCallbacks, Is as updateSessionStore, Jc as createThreadDiscord, Jn as EmbeddedBlockChunker, Jo as matchesMentionWithExplicit, Js as unregisterGateway, Kc as convertMarkdownTables, Ko as recordPendingHistoryEntryIfEnabled, Lf as normalizeMessageChannel, Lo as logAckFailure, Lu as fetchRemoteMedia, Mc as formatDiscordComponentEventText, Mr as formatDurationSeconds, Ms as readSessionUpdatedAt, Mu as loadWebMedia, Nc as parseDiscordComponentCustomId, Nr as enqueueSystemEvent, Oa as upsertChannelPairingRequest, Oc as removeReactionDiscord, Pc as parseDiscordComponentCustomIdForCarbon, Po as resolveAgentAvatar, Rc as resolveDiscordComponentEntry, Ro as logInboundDrop, Ru as resolveMarkdownTableMode, Sf as finalizeInboundContext, Tl as sendDiscordText, Uc as sendVoiceMessageDiscord, Uo as clearHistoryEntriesIfEnabled, Ut as withTimeout, Vc as sendPollDiscord, Vo as buildPendingHistoryContextFromMap, Vt as createChannelInboundDebouncer, Vu as resolveTextChunkLimit, Wc as sendWebhookMessageDiscord, Xc as editMessageDiscord, Xo as findCommandByNativeName, Yc as deleteMessageDiscord, Yo as buildCommandTextFromArgs, Yt as resolveDmGroupAccessWithLists, Zo as listChatCommands, Zs as reconcileAcpThreadBindingsOnStartup, Zt as resolvePinnedMainDmOwnerFromAllowlist, _c as normalizeDiscordInboundWorkerTimeoutMs, _n as dispatchInboundMessage, ac as resolveThreadBindingMaxAgeMs, as as shouldHandleTextCommands, b as resolveProfilesUnavailableReason, cc as resolveThreadBindingsEnabled, cn as resolveControlCommandGate, cs as resolveNativeSkillsEnabled, dn as dispatchReplyWithDispatcher, ec as createThreadBindingManager, el as pinMessageDiscord, en as resolveMentionGatingWithBypass, fc as resolveDiscordUserAllowlist, ff as formatErrorMessage, fi as getExecApprovalApproverDmNoticeText, gn as resolveEnvelopeFormatOptions, ip as normalizeProviderId, is as serializeCommandArgs, jc as createDiscordFormModal, jl as chunkDiscordTextWithMode, js as loadSessionStore, kc as sendTypingDiscord, kl as createDiscordClient, ko as readJsonFileWithFallback, lc as formatThreadBindingDurationLabel, mn as formatInboundEnvelope, nc as isRecentlyUnboundThreadWebhookMessage, ns as resolveCommandArgChoices, on as recordInboundSession, os as isNativeCommandsExplicitlyDisabled, pc as resolveDiscordChannelAllowlist, ps as getAcpSessionManager, qc as recordChannelActivity, qo as buildMentionRegexes, qs as registerGateway, rc as resolveThreadBindingIdleTimeoutMs, rl as unpinMessageDiscord, rs as resolveCommandArgMenu, rt as createConnectedChannelStatusPatch, sn as resolveCommandAuthorizedFromAuthorizers, ss as resolveNativeCommandsEnabled, tc as isThreadArchived, ts as parseCommandArgs, un as dispatchReplyWithBufferedBlockDispatcher, v as clearExpiredCooldowns, vc as normalizeDiscordListenerTimeoutMs, vt as resolveStoredModelOverride, wf as loadConfig, wn as buildModelsProviderData, x as ensureAuthProfileStore, xl as editChannelDiscord, xn as hasControlCommand, y as isProfileInCooldown, yc as runDiscordTaskWithTimeout, yf as stripReasoningTagsFromText, yn as createReplyDispatcherWithTyping, zc as resolveDiscordModalEntry, zo as logTypingFailure } from "./setup-wizard-helpers-BPw-E_P4.js";
import { d as isAcpRuntimeError } from "./provider-env-vars-CWXfFyDU.js";
import { A as init_home_dir, N as resolveRequiredHomeDir, O as resolveStateDir, S as init_paths, t as getChildLogger } from "./logger-D1gzveLR.js";
import "./tmp-openclaw-dir-DgWJsVV_.js";
import { C as warn, _ as isVerbose, g as init_globals, l as init_runtime, m as danger, n as init_subsystem, s as createNonExitingRuntime, t as createSubsystemLogger, v as logVerbose, x as shouldLogVerbose } from "./subsystem-0lZt3jI5.js";
import { C as truncateUtf16Safe, c as init_utils } from "./utils-DknlDzAi.js";
import { a as fetchWithTimeout, n as resolveFetch, o as init_fetch_timeout, r as wrapFetchWithAbortSignal, t as init_fetch } from "./fetch-CysqlwhH.js";
import { n as resolveRetryConfig, r as retryAsync, t as init_retry } from "./retry-CyJj_oar.js";
import { t as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-0CmwkA_V.js";
import { A as withFileLock } from "./paths-BDsrA18Z.js";
import { KeyedAsyncQueue } from "./keyed-async-queue.js";
import { R as resolveDiscordPreviewStreamMode } from "./signal-FT4PyBH3.js";
import "./config-helpers-BQX8LEv1.js";
import "./fetch-CKhAJuFk.js";
import "./exec-DEBhRlDf.js";
import { j as normalizeStringEntries } from "./agent-scope-CgozsAuQ.js";
import { i as resolveAckReaction, n as createReplyPrefixOptions, s as resolveHumanDelayConfig } from "./reply-prefix-Dcd4HlHm.js";
import { n as logError, t as logDebug } from "./logger-CXkOEiRn.js";
import "./fetch-guard-DryYzke6.js";
import { i as resolveAgentRoute, n as deriveLastRoutePolicy, t as buildAgentSessionKey } from "./resolve-route-CPxNiUBg.js";
import "./pairing-token-ukgXF6GK.js";
import { R as resolveStorePath } from "./query-expansion-t4qzEE5Z.js";
import { a as compileSafeRegex, o as testRegexWithBoundedInput } from "./redact-DkskT6Xp.js";
import { n as formatAllowlistMatchMeta } from "./allowlist-match-CTtlT8WI.js";
import "./channel-plugin-common-Cs4waNSc.js";
import "./secret-file-CCHXecQt.js";
import { n as shouldAckReaction } from "./ack-reactions-CF0ySZQ8.js";
import { t as buildMediaPayload } from "./media-payload-DXZ_hive.js";
import { a as patchAllowlistUsersInConfigEntries, n as buildAllowlistResolutionSummary, o as summarizeMapping, r as canonicalizeAllowlistWithResolvedIds, s as summarizeStringEntries, t as addAllowlistUserEntriesFromConfigEntry } from "./resolve-utils-D2Wj38Wj.js";
import { t as createReplyReferencePlanner } from "./reply-reference-aEyI1fb_.js";
import { a as createFinalizableDraftLifecycle, c as createStatusReactionController, i as resolveConfiguredAcpRoute, n as createOperatorApprovalsGatewayClient, r as ensureConfiguredAcpRouteReady, s as DEFAULT_TIMING, t as resolveExecApprovalCommandDisplay } from "./exec-approval-command-display-BBC7bhl_.js";
import { t as resolveNativeCommandSessionTargets } from "./native-command-session-targets-B2n7HauU.js";
import { n as buildUntrustedChannelMetadata, t as chunkItems } from "./chunk-items-YMKgeOwz.js";
import path from "node:path";
import os from "node:os";
import { inspect } from "node:util";
import { ProxyAgent, fetch as fetch$1 } from "undici";
import WebSocket$1 from "ws";
import { ApplicationCommandOptionType, ButtonStyle, ChannelType, Routes, StickerFormatType } from "discord-api-types/v10";
import { Button, ChannelSelectMenu, ChannelType as ChannelType$1, Client, Command, CommandWithSubcommands, Container, MentionableSelectMenu, MessageCreateListener, MessageReactionAddListener, MessageReactionRemoveListener, MessageType, Modal, PresenceUpdateListener, RateLimitError, ReadyListener, RoleSelectMenu, Row, Separator, StringSelectMenu, TextDisplay, ThreadUpdateListener, UserSelectMenu, serializePayload } from "@buape/carbon";
import { HttpsProxyAgent } from "https-proxy-agent";
import { GatewayCloseCodes, GatewayIntents, GatewayPlugin } from "@buape/carbon/gateway";
import { VoicePlugin } from "@buape/carbon/voice";
//#region extensions/discord/src/monitor/message-utils.ts
init_directory_live();
init_allow_list();
init_format();
init_accounts();
init_token();
init_account_lookup();
init_subsystem();
init_runtime();
init_session_key();
init_account_id();
init_globals();
const DISCORD_MEDIA_SSRF_POLICY = {
	hostnameAllowlist: [
		"cdn.discordapp.com",
		"media.discordapp.net",
		"*.discordapp.com",
		"*.discordapp.net"
	],
	allowRfc2544BenchmarkRange: true
};
function mergeHostnameList(...lists) {
	const merged = lists.flatMap((list) => list ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
	if (merged.length === 0) return;
	return Array.from(new Set(merged));
}
function resolveDiscordMediaSsrFPolicy(policy) {
	if (!policy) return DISCORD_MEDIA_SSRF_POLICY;
	const hostnameAllowlist = mergeHostnameList(DISCORD_MEDIA_SSRF_POLICY.hostnameAllowlist, policy.hostnameAllowlist);
	const allowedHostnames = mergeHostnameList(DISCORD_MEDIA_SSRF_POLICY.allowedHostnames, policy.allowedHostnames);
	return {
		...DISCORD_MEDIA_SSRF_POLICY,
		...policy,
		...allowedHostnames ? { allowedHostnames } : {},
		...hostnameAllowlist ? { hostnameAllowlist } : {},
		allowRfc2544BenchmarkRange: Boolean(DISCORD_MEDIA_SSRF_POLICY.allowRfc2544BenchmarkRange) || Boolean(policy.allowRfc2544BenchmarkRange)
	};
}
const DISCORD_CHANNEL_INFO_CACHE_TTL_MS = 300 * 1e3;
const DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS = 30 * 1e3;
const DISCORD_CHANNEL_INFO_CACHE = /* @__PURE__ */ new Map();
const DISCORD_STICKER_ASSET_BASE_URL = "https://media.discordapp.net/stickers";
function normalizeDiscordChannelId(value) {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "bigint") return String(value).trim();
	return "";
}
function resolveDiscordMessageChannelId(params) {
	const message = params.message;
	return normalizeDiscordChannelId(message.channelId) || normalizeDiscordChannelId(message.channel_id) || normalizeDiscordChannelId(message.rawData?.channel_id) || normalizeDiscordChannelId(params.eventChannelId);
}
async function resolveDiscordChannelInfo(client, channelId) {
	const cached = DISCORD_CHANNEL_INFO_CACHE.get(channelId);
	if (cached) {
		if (cached.expiresAt > Date.now()) return cached.value;
		DISCORD_CHANNEL_INFO_CACHE.delete(channelId);
	}
	try {
		const channel = await client.fetchChannel(channelId);
		if (!channel) {
			DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
				value: null,
				expiresAt: Date.now() + DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS
			});
			return null;
		}
		const name = "name" in channel ? channel.name ?? void 0 : void 0;
		const topic = "topic" in channel ? channel.topic ?? void 0 : void 0;
		const parentId = "parentId" in channel ? channel.parentId ?? void 0 : void 0;
		const ownerId = "ownerId" in channel ? channel.ownerId ?? void 0 : void 0;
		const payload = {
			type: channel.type,
			name,
			topic,
			parentId,
			ownerId
		};
		DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
			value: payload,
			expiresAt: Date.now() + DISCORD_CHANNEL_INFO_CACHE_TTL_MS
		});
		return payload;
	} catch (err) {
		logVerbose(`discord: failed to fetch channel ${channelId}: ${String(err)}`);
		DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
			value: null,
			expiresAt: Date.now() + DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS
		});
		return null;
	}
}
function normalizeStickerItems(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => Boolean(entry) && typeof entry === "object" && typeof entry.id === "string" && typeof entry.name === "string");
}
function resolveDiscordMessageStickers(message) {
	const stickers = message.stickers;
	const normalized = normalizeStickerItems(stickers);
	if (normalized.length > 0) return normalized;
	const rawData = message.rawData;
	return normalizeStickerItems(rawData?.sticker_items ?? rawData?.stickers);
}
function resolveDiscordSnapshotStickers(snapshot) {
	return normalizeStickerItems(snapshot.stickers ?? snapshot.sticker_items);
}
function hasDiscordMessageStickers(message) {
	return resolveDiscordMessageStickers(message).length > 0;
}
async function resolveMediaList(message, maxBytes, fetchImpl, ssrfPolicy) {
	const out = [];
	const resolvedSsrFPolicy = resolveDiscordMediaSsrFPolicy(ssrfPolicy);
	await appendResolvedMediaFromAttachments({
		attachments: message.attachments ?? [],
		maxBytes,
		out,
		errorPrefix: "discord: failed to download attachment",
		fetchImpl,
		ssrfPolicy: resolvedSsrFPolicy
	});
	await appendResolvedMediaFromStickers({
		stickers: resolveDiscordMessageStickers(message),
		maxBytes,
		out,
		errorPrefix: "discord: failed to download sticker",
		fetchImpl,
		ssrfPolicy: resolvedSsrFPolicy
	});
	return out;
}
async function resolveForwardedMediaList(message, maxBytes, fetchImpl, ssrfPolicy) {
	const snapshots = resolveDiscordMessageSnapshots(message);
	if (snapshots.length === 0) return [];
	const out = [];
	const resolvedSsrFPolicy = resolveDiscordMediaSsrFPolicy(ssrfPolicy);
	for (const snapshot of snapshots) {
		await appendResolvedMediaFromAttachments({
			attachments: snapshot.message?.attachments,
			maxBytes,
			out,
			errorPrefix: "discord: failed to download forwarded attachment",
			fetchImpl,
			ssrfPolicy: resolvedSsrFPolicy
		});
		await appendResolvedMediaFromStickers({
			stickers: snapshot.message ? resolveDiscordSnapshotStickers(snapshot.message) : [],
			maxBytes,
			out,
			errorPrefix: "discord: failed to download forwarded sticker",
			fetchImpl,
			ssrfPolicy: resolvedSsrFPolicy
		});
	}
	return out;
}
async function appendResolvedMediaFromAttachments(params) {
	const attachments = params.attachments;
	if (!attachments || attachments.length === 0) return;
	for (const attachment of attachments) try {
		const fetched = await fetchRemoteMedia({
			url: attachment.url,
			filePathHint: attachment.filename ?? attachment.url,
			maxBytes: params.maxBytes,
			fetchImpl: params.fetchImpl,
			ssrfPolicy: params.ssrfPolicy
		});
		const saved = await saveMediaBuffer(fetched.buffer, fetched.contentType ?? attachment.content_type, "inbound", params.maxBytes);
		params.out.push({
			path: saved.path,
			contentType: saved.contentType,
			placeholder: inferPlaceholder(attachment)
		});
	} catch (err) {
		const id = attachment.id ?? attachment.url;
		logVerbose(`${params.errorPrefix} ${id}: ${String(err)}`);
		params.out.push({
			path: attachment.url,
			contentType: attachment.content_type,
			placeholder: inferPlaceholder(attachment)
		});
	}
}
function resolveStickerAssetCandidates(sticker) {
	const baseName = sticker.name?.trim() || `sticker-${sticker.id}`;
	switch (sticker.format_type) {
		case StickerFormatType.GIF: return [{
			url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.gif`,
			fileName: `${baseName}.gif`
		}];
		case StickerFormatType.Lottie: return [{
			url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.png?size=160`,
			fileName: `${baseName}.png`
		}, {
			url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.json`,
			fileName: `${baseName}.json`
		}];
		case StickerFormatType.APNG:
		case StickerFormatType.PNG:
		default: return [{
			url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.png`,
			fileName: `${baseName}.png`
		}];
	}
}
function formatStickerError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	try {
		return JSON.stringify(err) ?? "unknown error";
	} catch {
		return "unknown error";
	}
}
function inferStickerContentType(sticker) {
	switch (sticker.format_type) {
		case StickerFormatType.GIF: return "image/gif";
		case StickerFormatType.APNG:
		case StickerFormatType.Lottie:
		case StickerFormatType.PNG: return "image/png";
		default: return;
	}
}
async function appendResolvedMediaFromStickers(params) {
	const stickers = params.stickers;
	if (!stickers || stickers.length === 0) return;
	for (const sticker of stickers) {
		const candidates = resolveStickerAssetCandidates(sticker);
		let lastError;
		for (const candidate of candidates) try {
			const fetched = await fetchRemoteMedia({
				url: candidate.url,
				filePathHint: candidate.fileName,
				maxBytes: params.maxBytes,
				fetchImpl: params.fetchImpl,
				ssrfPolicy: params.ssrfPolicy
			});
			const saved = await saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", params.maxBytes);
			params.out.push({
				path: saved.path,
				contentType: saved.contentType,
				placeholder: "<media:sticker>"
			});
			lastError = null;
			break;
		} catch (err) {
			lastError = err;
		}
		if (lastError) {
			logVerbose(`${params.errorPrefix} ${sticker.id}: ${formatStickerError(lastError)}`);
			const fallback = candidates[0];
			if (fallback) params.out.push({
				path: fallback.url,
				contentType: inferStickerContentType(sticker),
				placeholder: "<media:sticker>"
			});
		}
	}
}
function inferPlaceholder(attachment) {
	const mime = attachment.content_type ?? "";
	if (mime.startsWith("image/")) return "<media:image>";
	if (mime.startsWith("video/")) return "<media:video>";
	if (mime.startsWith("audio/")) return "<media:audio>";
	return "<media:document>";
}
function isImageAttachment(attachment) {
	if ((attachment.content_type ?? "").startsWith("image/")) return true;
	const name = attachment.filename?.toLowerCase() ?? "";
	if (!name) return false;
	return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/.test(name);
}
function buildDiscordAttachmentPlaceholder(attachments) {
	if (!attachments || attachments.length === 0) return "";
	const count = attachments.length;
	const allImages = attachments.every(isImageAttachment);
	const label = allImages ? "image" : "file";
	const suffix = count === 1 ? label : `${label}s`;
	return `${allImages ? "<media:image>" : "<media:document>"} (${count} ${suffix})`;
}
function buildDiscordStickerPlaceholder(stickers) {
	if (!stickers || stickers.length === 0) return "";
	const count = stickers.length;
	return `<media:sticker> (${count} ${count === 1 ? "sticker" : "stickers"})`;
}
function buildDiscordMediaPlaceholder(params) {
	const attachmentText = buildDiscordAttachmentPlaceholder(params.attachments);
	const stickerText = buildDiscordStickerPlaceholder(params.stickers);
	if (attachmentText && stickerText) return `${attachmentText}\n${stickerText}`;
	return attachmentText || stickerText || "";
}
function resolveDiscordEmbedText(embed) {
	const title = embed?.title?.trim() || "";
	const description = embed?.description?.trim() || "";
	if (title && description) return `${title}\n${description}`;
	return title || description || "";
}
function resolveDiscordMessageText(message, options) {
	const embedText = resolveDiscordEmbedText(message.embeds?.[0] ?? null);
	const baseText = resolveDiscordMentions(message.content?.trim() || buildDiscordMediaPlaceholder({
		attachments: message.attachments ?? void 0,
		stickers: resolveDiscordMessageStickers(message)
	}) || embedText || options?.fallbackText?.trim() || "", message);
	if (!options?.includeForwarded) return baseText;
	const forwardedText = resolveDiscordForwardedMessagesText(message);
	if (!forwardedText) return baseText;
	if (!baseText) return forwardedText;
	return `${baseText}\n${forwardedText}`;
}
function resolveDiscordMentions(text, message) {
	if (!text.includes("<")) return text;
	const mentions = message.mentionedUsers ?? [];
	if (!Array.isArray(mentions) || mentions.length === 0) return text;
	let out = text;
	for (const user of mentions) {
		const label = user.globalName || user.username;
		out = out.replace(new RegExp(`<@!?${user.id}>`, "g"), `@${label}`);
	}
	return out;
}
function resolveDiscordForwardedMessagesText(message) {
	const snapshots = resolveDiscordMessageSnapshots(message);
	if (snapshots.length === 0) return "";
	const forwardedBlocks = snapshots.map((snapshot) => {
		const snapshotMessage = snapshot.message;
		if (!snapshotMessage) return null;
		const text = resolveDiscordSnapshotMessageText(snapshotMessage);
		if (!text) return null;
		const authorLabel = formatDiscordSnapshotAuthor(snapshotMessage.author);
		return `${authorLabel ? `[Forwarded message from ${authorLabel}]` : "[Forwarded message]"}\n${text}`;
	}).filter((entry) => Boolean(entry));
	if (forwardedBlocks.length === 0) return "";
	return forwardedBlocks.join("\n\n");
}
function resolveDiscordMessageSnapshots(message) {
	const snapshots = message.rawData?.message_snapshots ?? message.message_snapshots ?? message.messageSnapshots;
	if (!Array.isArray(snapshots)) return [];
	return snapshots.filter((entry) => Boolean(entry) && typeof entry === "object");
}
function resolveDiscordSnapshotMessageText(snapshot) {
	const content = snapshot.content?.trim() ?? "";
	const attachmentText = buildDiscordMediaPlaceholder({
		attachments: snapshot.attachments ?? void 0,
		stickers: resolveDiscordSnapshotStickers(snapshot)
	});
	const embedText = resolveDiscordEmbedText(snapshot.embeds?.[0]);
	return content || attachmentText || embedText || "";
}
function formatDiscordSnapshotAuthor(author) {
	if (!author) return;
	const globalName = author.global_name ?? void 0;
	const username = author.username ?? void 0;
	const name = author.name ?? void 0;
	const discriminator = author.discriminator ?? void 0;
	const base = globalName || username || name;
	if (username && discriminator && discriminator !== "0") return `@${username}#${discriminator}`;
	if (base) return `@${base}`;
	if (author.id) return `@${author.id}`;
}
function buildDiscordMediaPayload(mediaList) {
	return buildMediaPayload(mediaList);
}
//#endregion
//#region extensions/discord/src/monitor/thread-session-close.ts
/**
* Marks every session entry in the store whose key contains {@link threadId}
* as "reset" by setting `updatedAt` to 0.
*
* This mirrors how the daily / idle session reset works: zeroing `updatedAt`
* makes `evaluateSessionFreshness` treat the session as stale on the next
* inbound message, so the bot starts a fresh conversation without deleting
* any on-disk transcript history.
*/
async function closeDiscordThreadSessions(params) {
	const { cfg, accountId, threadId } = params;
	const normalizedThreadId = threadId.trim().toLowerCase();
	if (!normalizedThreadId) return 0;
	const segmentRe = new RegExp(`:${normalizedThreadId}(?::|$)`, "i");
	function sessionKeyContainsThreadId(key) {
		return segmentRe.test(key);
	}
	const storePath = resolveStorePath(cfg.session?.store, { agentId: accountId });
	let resetCount = 0;
	await updateSessionStore(storePath, (store) => {
		for (const [key, entry] of Object.entries(store)) {
			if (!entry || !sessionKeyContainsThreadId(key)) continue;
			if (entry.updatedAt === 0) continue;
			entry.updatedAt = 0;
			resetCount += 1;
		}
		return resetCount;
	});
	return resetCount;
}
//#endregion
//#region extensions/discord/src/monitor/listeners.ts
init_globals();
const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 3e4;
const discordEventQueueLog = createSubsystemLogger("discord/event-queue");
function formatListenerContextValue(value) {
	if (value === void 0 || value === null) return null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	return null;
}
function formatListenerContextSuffix(context) {
	if (!context) return "";
	const entries = Object.entries(context).flatMap(([key, value]) => {
		const formatted = formatListenerContextValue(value);
		return formatted ? [`${key}=${formatted}`] : [];
	});
	if (entries.length === 0) return "";
	return ` (${entries.join(" ")})`;
}
function logSlowDiscordListener(params) {
	if (params.durationMs < DISCORD_SLOW_LISTENER_THRESHOLD_MS) return;
	const duration = formatDurationSeconds(params.durationMs, {
		decimals: 1,
		unit: "seconds"
	});
	const message = `Slow listener detected: ${params.listener} took ${duration} for event ${params.event}`;
	(params.logger ?? discordEventQueueLog).warn("Slow listener detected", {
		listener: params.listener,
		event: params.event,
		durationMs: params.durationMs,
		duration,
		...params.context,
		consoleMessage: `${message}${formatListenerContextSuffix(params.context)}`
	});
}
async function runDiscordListenerWithSlowLog(params) {
	const startedAt = Date.now();
	const timeoutMs = normalizeDiscordListenerTimeoutMs(params.timeoutMs);
	const logger = params.logger ?? discordEventQueueLog;
	let timedOut = false;
	try {
		timedOut = await runDiscordTaskWithTimeout({
			run: params.run,
			timeoutMs,
			onTimeout: (resolvedTimeoutMs) => {
				logger.error(danger(`discord handler timed out after ${formatDurationSeconds(resolvedTimeoutMs, {
					decimals: 1,
					unit: "seconds"
				})}${formatListenerContextSuffix(params.context)}`));
			},
			onAbortAfterTimeout: () => {
				logger.warn(`discord handler canceled after timeout${formatListenerContextSuffix(params.context)}`);
			},
			onErrorAfterTimeout: (err) => {
				logger.error(danger(`discord handler failed after timeout: ${String(err)}${formatListenerContextSuffix(params.context)}`));
			}
		});
		if (timedOut) return;
	} catch (err) {
		if (params.onError) {
			params.onError(err);
			return;
		}
		throw err;
	} finally {
		if (!timedOut) logSlowDiscordListener({
			logger: params.logger,
			listener: params.listener,
			event: params.event,
			durationMs: Date.now() - startedAt,
			context: params.context
		});
	}
}
function registerDiscordListener(listeners, listener) {
	if (listeners.some((existing) => existing.constructor === listener.constructor)) return false;
	listeners.push(listener);
	return true;
}
var DiscordMessageListener = class extends MessageCreateListener {
	constructor(handler, logger, onEvent, _options) {
		super();
		this.handler = handler;
		this.logger = logger;
		this.onEvent = onEvent;
	}
	async handle(data, client) {
		this.onEvent?.();
		Promise.resolve().then(() => this.handler(data, client)).catch((err) => {
			(this.logger ?? discordEventQueueLog).error(danger(`discord handler failed: ${String(err)}`));
		});
	}
};
var DiscordReactionListener = class extends MessageReactionAddListener {
	constructor(params) {
		super();
		this.params = params;
	}
	async handle(data, client) {
		this.params.onEvent?.();
		await runDiscordReactionHandler({
			data,
			client,
			action: "added",
			handlerParams: this.params,
			listener: this.constructor.name,
			event: this.type
		});
	}
};
var DiscordReactionRemoveListener = class extends MessageReactionRemoveListener {
	constructor(params) {
		super();
		this.params = params;
	}
	async handle(data, client) {
		this.params.onEvent?.();
		await runDiscordReactionHandler({
			data,
			client,
			action: "removed",
			handlerParams: this.params,
			listener: this.constructor.name,
			event: this.type
		});
	}
};
async function runDiscordReactionHandler(params) {
	await runDiscordListenerWithSlowLog({
		logger: params.handlerParams.logger,
		listener: params.listener,
		event: params.event,
		run: async () => handleDiscordReactionEvent({
			data: params.data,
			client: params.client,
			action: params.action,
			cfg: params.handlerParams.cfg,
			accountId: params.handlerParams.accountId,
			botUserId: params.handlerParams.botUserId,
			dmEnabled: params.handlerParams.dmEnabled,
			groupDmEnabled: params.handlerParams.groupDmEnabled,
			groupDmChannels: params.handlerParams.groupDmChannels,
			dmPolicy: params.handlerParams.dmPolicy,
			allowFrom: params.handlerParams.allowFrom,
			groupPolicy: params.handlerParams.groupPolicy,
			allowNameMatching: params.handlerParams.allowNameMatching,
			guildEntries: params.handlerParams.guildEntries,
			logger: params.handlerParams.logger
		})
	});
}
async function authorizeDiscordReactionIngress(params) {
	if (params.isDirectMessage && !params.dmEnabled) return {
		allowed: false,
		reason: "dm-disabled"
	};
	if (params.isGroupDm && !params.groupDmEnabled) return {
		allowed: false,
		reason: "group-dm-disabled"
	};
	if (params.isDirectMessage) {
		const storeAllowFrom = await readStoreAllowFromForDmPolicy({
			provider: "discord",
			accountId: params.accountId,
			dmPolicy: params.dmPolicy
		});
		const access = resolveDmGroupAccessWithLists({
			isGroup: false,
			dmPolicy: params.dmPolicy,
			groupPolicy: params.groupPolicy,
			allowFrom: params.allowFrom,
			groupAllowFrom: [],
			storeAllowFrom,
			isSenderAllowed: (allowEntries) => {
				const allowList = normalizeDiscordAllowList(allowEntries, [
					"discord:",
					"user:",
					"pk:"
				]);
				return (allowList ? resolveDiscordAllowListMatch({
					allowList,
					candidate: {
						id: params.user.id,
						name: params.user.username,
						tag: formatDiscordUserTag(params.user)
					},
					allowNameMatching: params.allowNameMatching
				}) : { allowed: false }).allowed;
			}
		});
		if (access.decision !== "allow") return {
			allowed: false,
			reason: access.reason
		};
	}
	if (params.isGroupDm && !resolveGroupDmAllow({
		channels: params.groupDmChannels,
		channelId: params.channelId,
		channelName: params.channelName,
		channelSlug: params.channelSlug
	})) return {
		allowed: false,
		reason: "group-dm-not-allowlisted"
	};
	if (!params.isGuildMessage) return { allowed: true };
	const channelAllowlistConfigured = Boolean(params.guildInfo?.channels) && Object.keys(params.guildInfo?.channels ?? {}).length > 0;
	const channelAllowed = params.channelConfig?.allowed !== false;
	if (!isDiscordGroupAllowedByPolicy({
		groupPolicy: params.groupPolicy,
		guildAllowlisted: Boolean(params.guildInfo),
		channelAllowlistConfigured,
		channelAllowed
	})) return {
		allowed: false,
		reason: "guild-policy"
	};
	if (params.channelConfig?.allowed === false) return {
		allowed: false,
		reason: "guild-channel-denied"
	};
	const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
		channelConfig: params.channelConfig,
		guildInfo: params.guildInfo,
		memberRoleIds: params.memberRoleIds,
		sender: {
			id: params.user.id,
			name: params.user.username,
			tag: formatDiscordUserTag(params.user)
		},
		allowNameMatching: params.allowNameMatching
	});
	if (hasAccessRestrictions && !memberAllowed) return {
		allowed: false,
		reason: "guild-member-denied"
	};
	return { allowed: true };
}
async function handleDiscordReactionEvent(params) {
	try {
		const { data, client, action, botUserId, guildEntries } = params;
		if (!("user" in data)) return;
		const user = data.user;
		if (!user || user.bot) return;
		if (botUserId && user.id === botUserId) return;
		const isGuildMessage = Boolean(data.guild_id);
		const guildInfo = isGuildMessage ? resolveDiscordGuildEntry({
			guild: data.guild ?? void 0,
			guildId: data.guild_id ?? void 0,
			guildEntries
		}) : null;
		if (isGuildMessage && guildEntries && Object.keys(guildEntries).length > 0 && !guildInfo) return;
		const channel = await client.fetchChannel(data.channel_id);
		if (!channel) return;
		const channelName = "name" in channel ? channel.name ?? void 0 : void 0;
		const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
		const channelType = "type" in channel ? channel.type : void 0;
		const isDirectMessage = channelType === ChannelType$1.DM;
		const isGroupDm = channelType === ChannelType$1.GroupDM;
		const isThreadChannel = channelType === ChannelType$1.PublicThread || channelType === ChannelType$1.PrivateThread || channelType === ChannelType$1.AnnouncementThread;
		const memberRoleIds = Array.isArray(data.rawMember?.roles) ? data.rawMember.roles.map((roleId) => String(roleId)) : [];
		const reactionIngressBase = {
			accountId: params.accountId,
			user,
			memberRoleIds,
			isDirectMessage,
			isGroupDm,
			isGuildMessage,
			channelId: data.channel_id,
			channelName,
			channelSlug,
			dmEnabled: params.dmEnabled,
			groupDmEnabled: params.groupDmEnabled,
			groupDmChannels: params.groupDmChannels,
			dmPolicy: params.dmPolicy,
			allowFrom: params.allowFrom,
			groupPolicy: params.groupPolicy,
			allowNameMatching: params.allowNameMatching,
			guildInfo
		};
		if (!isGuildMessage) {
			const ingressAccess = await authorizeDiscordReactionIngress(reactionIngressBase);
			if (!ingressAccess.allowed) {
				logVerbose(`discord reaction blocked sender=${user.id} (reason=${ingressAccess.reason})`);
				return;
			}
		}
		let parentId = "parentId" in channel ? channel.parentId ?? void 0 : void 0;
		let parentName;
		let parentSlug = "";
		let reactionBase = null;
		const resolveReactionBase = () => {
			if (reactionBase) return reactionBase;
			const emojiLabel = formatDiscordReactionEmoji(data.emoji);
			reactionBase = {
				baseText: `Discord reaction ${action}: ${emojiLabel} by ${formatDiscordUserTag(user)} on ${guildInfo?.slug || (data.guild?.name ? normalizeDiscordSlug(data.guild.name) : data.guild_id ?? (isGroupDm ? "group-dm" : "dm"))} ${channelSlug ? `#${channelSlug}` : channelName ? `#${normalizeDiscordSlug(channelName)}` : `#${data.channel_id}`} msg ${data.message_id}`,
				contextKey: `discord:reaction:${action}:${data.message_id}:${user.id}:${emojiLabel}`
			};
			return reactionBase;
		};
		const emitReaction = (text, parentPeerId) => {
			const { contextKey } = resolveReactionBase();
			enqueueSystemEvent(text, {
				sessionKey: resolveAgentRoute({
					cfg: params.cfg,
					channel: "discord",
					accountId: params.accountId,
					guildId: data.guild_id ?? void 0,
					memberRoleIds,
					peer: {
						kind: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
						id: isDirectMessage ? user.id : data.channel_id
					},
					parentPeer: parentPeerId ? {
						kind: "channel",
						id: parentPeerId
					} : void 0
				}).sessionKey,
				contextKey
			});
		};
		const shouldNotifyReaction = (options) => shouldEmitDiscordReactionNotification({
			mode: options.mode,
			botId: botUserId,
			messageAuthorId: options.messageAuthorId,
			userId: user.id,
			userName: user.username,
			userTag: formatDiscordUserTag(user),
			channelConfig: options.channelConfig,
			guildInfo,
			memberRoleIds,
			allowNameMatching: params.allowNameMatching
		});
		const emitReactionWithAuthor = (message) => {
			const { baseText } = resolveReactionBase();
			const authorLabel = message?.author ? formatDiscordUserTag(message.author) : void 0;
			emitReaction(authorLabel ? `${baseText} from ${authorLabel}` : baseText, parentId);
		};
		const loadThreadParentInfo = async () => {
			if (!parentId) return;
			parentName = (await resolveDiscordChannelInfo(client, parentId))?.name;
			parentSlug = parentName ? normalizeDiscordSlug(parentName) : "";
		};
		const resolveThreadChannelConfig = () => resolveDiscordChannelConfigWithFallback({
			guildInfo,
			channelId: data.channel_id,
			channelName,
			channelSlug,
			parentId,
			parentName,
			parentSlug,
			scope: "thread"
		});
		const authorizeReactionIngressForChannel = async (channelConfig) => await authorizeDiscordReactionIngress({
			...reactionIngressBase,
			channelConfig
		});
		const resolveThreadChannelAccess = async (channelInfo) => {
			parentId = channelInfo?.parentId;
			await loadThreadParentInfo();
			const channelConfig = resolveThreadChannelConfig();
			return {
				access: await authorizeReactionIngressForChannel(channelConfig),
				channelConfig
			};
		};
		if (isThreadChannel) {
			const reactionMode = guildInfo?.reactionNotifications ?? "own";
			if (reactionMode === "off") return;
			const channelInfoPromise = parentId ? Promise.resolve({ parentId }) : resolveDiscordChannelInfo(client, data.channel_id);
			if (reactionMode === "all" || reactionMode === "allowlist") {
				const { access: threadAccess, channelConfig: threadChannelConfig } = await resolveThreadChannelAccess(await channelInfoPromise);
				if (!threadAccess.allowed) return;
				if (!shouldNotifyReaction({
					mode: reactionMode,
					channelConfig: threadChannelConfig
				})) return;
				const { baseText } = resolveReactionBase();
				emitReaction(baseText, parentId);
				return;
			}
			const messagePromise = data.message.fetch().catch(() => null);
			const [channelInfo, message] = await Promise.all([channelInfoPromise, messagePromise]);
			const { access: threadAccess, channelConfig: threadChannelConfig } = await resolveThreadChannelAccess(channelInfo);
			if (!threadAccess.allowed) return;
			if (!shouldNotifyReaction({
				mode: reactionMode,
				messageAuthorId: message?.author?.id ?? void 0,
				channelConfig: threadChannelConfig
			})) return;
			emitReactionWithAuthor(message);
			return;
		}
		const channelConfig = resolveDiscordChannelConfigWithFallback({
			guildInfo,
			channelId: data.channel_id,
			channelName,
			channelSlug,
			parentId,
			parentName,
			parentSlug,
			scope: "channel"
		});
		if (isGuildMessage) {
			if (!(await authorizeReactionIngressForChannel(channelConfig)).allowed) return;
		}
		const reactionMode = guildInfo?.reactionNotifications ?? "own";
		if (reactionMode === "off") return;
		if (reactionMode === "all" || reactionMode === "allowlist") {
			if (!shouldNotifyReaction({
				mode: reactionMode,
				channelConfig
			})) return;
			const { baseText } = resolveReactionBase();
			emitReaction(baseText, parentId);
			return;
		}
		const message = await data.message.fetch().catch(() => null);
		if (!shouldNotifyReaction({
			mode: reactionMode,
			messageAuthorId: message?.author?.id ?? void 0,
			channelConfig
		})) return;
		emitReactionWithAuthor(message);
	} catch (err) {
		params.logger.error(danger(`discord reaction handler failed: ${String(err)}`));
	}
}
var DiscordPresenceListener = class extends PresenceUpdateListener {
	constructor(params) {
		super();
		this.logger = params.logger;
		this.accountId = params.accountId;
	}
	async handle(data) {
		try {
			const userId = "user" in data && data.user && typeof data.user === "object" && "id" in data.user ? String(data.user.id) : void 0;
			if (!userId) return;
			setPresence(this.accountId, userId, data);
		} catch (err) {
			(this.logger ?? discordEventQueueLog).error(danger(`discord presence handler failed: ${String(err)}`));
		}
	}
};
var DiscordThreadUpdateListener = class extends ThreadUpdateListener {
	constructor(cfg, accountId, logger) {
		super();
		this.cfg = cfg;
		this.accountId = accountId;
		this.logger = logger;
	}
	async handle(data) {
		await runDiscordListenerWithSlowLog({
			logger: this.logger,
			listener: this.constructor.name,
			event: this.type,
			run: async () => {
				if (!isThreadArchived(data)) return;
				const threadId = "id" in data && typeof data.id === "string" ? data.id : void 0;
				if (!threadId) return;
				const logger = this.logger ?? discordEventQueueLog;
				const count = await closeDiscordThreadSessions({
					cfg: this.cfg,
					accountId: this.accountId,
					threadId
				});
				if (count > 0) logger.info("Discord thread archived — reset sessions", {
					threadId,
					count
				});
			},
			onError: (err) => {
				(this.logger ?? discordEventQueueLog).error(danger(`discord thread-update handler failed: ${String(err)}`));
			}
		});
	}
};
//#endregion
//#region extensions/discord/src/monitor/inbound-job.ts
init_runtime_group_policy();
function resolveDiscordInboundJobQueueKey(ctx) {
	const sessionKey = ctx.route.sessionKey?.trim();
	if (sessionKey) return sessionKey;
	const baseSessionKey = ctx.baseSessionKey?.trim();
	if (baseSessionKey) return baseSessionKey;
	return ctx.messageChannelId;
}
function buildDiscordInboundJob(ctx) {
	const { runtime, abortSignal, guildHistories, client, threadBindings, discordRestFetch, message, data, threadChannel, ...payload } = ctx;
	const sanitizedMessage = sanitizeDiscordInboundMessage(message);
	return {
		queueKey: resolveDiscordInboundJobQueueKey(ctx),
		payload: {
			...payload,
			message: sanitizedMessage,
			data: {
				...data,
				message: sanitizedMessage
			},
			threadChannel: normalizeDiscordThreadChannel(threadChannel)
		},
		runtime: {
			runtime,
			abortSignal,
			guildHistories,
			client,
			threadBindings,
			discordRestFetch
		}
	};
}
function materializeDiscordInboundJob(job, abortSignal) {
	return {
		...job.payload,
		...job.runtime,
		abortSignal: abortSignal ?? job.runtime.abortSignal
	};
}
function sanitizeDiscordInboundMessage(message) {
	const descriptors = Object.getOwnPropertyDescriptors(message);
	delete descriptors.channel;
	return Object.create(Object.getPrototypeOf(message), descriptors);
}
function normalizeDiscordThreadChannel(threadChannel) {
	if (!threadChannel) return null;
	return {
		id: threadChannel.id,
		name: threadChannel.name,
		parentId: threadChannel.parentId,
		parent: threadChannel.parent ? {
			id: threadChannel.parent.id,
			name: threadChannel.parent.name
		} : void 0,
		ownerId: threadChannel.ownerId
	};
}
//#endregion
//#region src/channels/run-state-machine.ts
const DEFAULT_RUN_ACTIVITY_HEARTBEAT_MS = 6e4;
function createRunStateMachine(params) {
	const heartbeatMs = params.heartbeatMs ?? DEFAULT_RUN_ACTIVITY_HEARTBEAT_MS;
	const now = params.now ?? Date.now;
	let activeRuns = 0;
	let runActivityHeartbeat = null;
	let lifecycleActive = !params.abortSignal?.aborted;
	const publish = () => {
		if (!lifecycleActive) return;
		params.setStatus?.({
			activeRuns,
			busy: activeRuns > 0,
			lastRunActivityAt: now()
		});
	};
	const clearHeartbeat = () => {
		if (!runActivityHeartbeat) return;
		clearInterval(runActivityHeartbeat);
		runActivityHeartbeat = null;
	};
	const ensureHeartbeat = () => {
		if (runActivityHeartbeat || activeRuns <= 0 || !lifecycleActive) return;
		runActivityHeartbeat = setInterval(() => {
			if (!lifecycleActive || activeRuns <= 0) {
				clearHeartbeat();
				return;
			}
			publish();
		}, heartbeatMs);
		runActivityHeartbeat.unref?.();
	};
	const deactivate = () => {
		lifecycleActive = false;
		clearHeartbeat();
	};
	const onAbort = () => {
		deactivate();
	};
	if (params.abortSignal?.aborted) onAbort();
	else params.abortSignal?.addEventListener("abort", onAbort, { once: true });
	if (lifecycleActive) params.setStatus?.({
		activeRuns: 0,
		busy: false
	});
	return {
		isActive() {
			return lifecycleActive;
		},
		onRunStart() {
			activeRuns += 1;
			publish();
			ensureHeartbeat();
		},
		onRunEnd() {
			activeRuns = Math.max(0, activeRuns - 1);
			if (activeRuns <= 0) clearHeartbeat();
			publish();
		},
		deactivate
	};
}
//#endregion
//#region extensions/discord/src/outbound-adapter.ts
init_utils();
init_paths();
init_home_dir();
const DISCORD_TEXT_CHUNK_LIMIT = 2e3;
//#endregion
//#region extensions/discord/src/draft-chunking.ts
const DEFAULT_DISCORD_DRAFT_STREAM_MIN = 200;
const DEFAULT_DISCORD_DRAFT_STREAM_MAX = 800;
function resolveDiscordDraftStreamingChunking(cfg, accountId) {
	const textLimit = resolveTextChunkLimit(cfg, "discord", accountId, { fallbackLimit: DISCORD_TEXT_CHUNK_LIMIT });
	const normalizedAccountId = normalizeAccountId(accountId);
	const draftCfg = resolveAccountEntry(cfg?.channels?.discord?.accounts, normalizedAccountId)?.draftChunk ?? cfg?.channels?.discord?.draftChunk;
	const maxRequested = Math.max(1, Math.floor(draftCfg?.maxChars ?? DEFAULT_DISCORD_DRAFT_STREAM_MAX));
	const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
	const minRequested = Math.max(1, Math.floor(draftCfg?.minChars ?? DEFAULT_DISCORD_DRAFT_STREAM_MIN));
	return {
		minChars: Math.min(minRequested, maxChars),
		maxChars,
		breakPreference: draftCfg?.breakPreference === "newline" || draftCfg?.breakPreference === "sentence" ? draftCfg.breakPreference : "paragraph"
	};
}
//#endregion
//#region extensions/discord/src/draft-stream.ts
/** Discord messages cap at 2000 characters. */
const DISCORD_STREAM_MAX_CHARS = 2e3;
const DEFAULT_THROTTLE_MS = 1200;
function createDiscordDraftStream(params) {
	const maxChars = Math.min(params.maxChars ?? DISCORD_STREAM_MAX_CHARS, DISCORD_STREAM_MAX_CHARS);
	const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
	const minInitialChars = params.minInitialChars;
	const channelId = params.channelId;
	const rest = params.rest;
	const resolveReplyToMessageId = () => typeof params.replyToMessageId === "function" ? params.replyToMessageId() : params.replyToMessageId;
	const streamState = {
		stopped: false,
		final: false
	};
	let streamMessageId;
	let lastSentText = "";
	const sendOrEditStreamMessage = async (text) => {
		if (streamState.stopped && !streamState.final) return false;
		const trimmed = text.trimEnd();
		if (!trimmed) return false;
		if (trimmed.length > maxChars) {
			streamState.stopped = true;
			params.warn?.(`discord stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
			return false;
		}
		if (trimmed === lastSentText) return true;
		if (streamMessageId === void 0 && minInitialChars != null && !streamState.final) {
			if (trimmed.length < minInitialChars) return false;
		}
		lastSentText = trimmed;
		try {
			if (streamMessageId !== void 0) {
				await rest.patch(Routes.channelMessage(channelId, streamMessageId), { body: { content: trimmed } });
				return true;
			}
			const replyToMessageId = resolveReplyToMessageId()?.trim();
			const messageReference = replyToMessageId ? {
				message_id: replyToMessageId,
				fail_if_not_exists: false
			} : void 0;
			const sentMessageId = (await rest.post(Routes.channelMessages(channelId), { body: {
				content: trimmed,
				...messageReference ? { message_reference: messageReference } : {}
			} }))?.id;
			if (typeof sentMessageId !== "string" || !sentMessageId) {
				streamState.stopped = true;
				params.warn?.("discord stream preview stopped (missing message id from send)");
				return false;
			}
			streamMessageId = sentMessageId;
			return true;
		} catch (err) {
			streamState.stopped = true;
			params.warn?.(`discord stream preview failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	};
	const readMessageId = () => streamMessageId;
	const clearMessageId = () => {
		streamMessageId = void 0;
	};
	const isValidStreamMessageId = (value) => typeof value === "string";
	const deleteStreamMessage = async (messageId) => {
		await rest.delete(Routes.channelMessage(channelId, messageId));
	};
	const { loop, update, stop, clear } = createFinalizableDraftLifecycle({
		throttleMs,
		state: streamState,
		sendOrEditStreamMessage,
		readMessageId,
		clearMessageId,
		isValidMessageId: isValidStreamMessageId,
		deleteMessage: deleteStreamMessage,
		warn: params.warn,
		warnPrefix: "discord stream preview cleanup failed"
	});
	const forceNewMessage = () => {
		streamMessageId = void 0;
		lastSentText = "";
		loop.resetPending();
	};
	params.log?.(`discord stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);
	return {
		update,
		flush: loop.flush,
		messageId: () => streamMessageId,
		clear,
		stop,
		forceNewMessage
	};
}
//#endregion
//#region extensions/discord/src/monitor/inbound-context.ts
init_allow_list();
function buildDiscordGroupSystemPrompt(channelConfig) {
	const systemPromptParts = [channelConfig?.systemPrompt?.trim() || null].filter((entry) => Boolean(entry));
	return systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : void 0;
}
function buildDiscordUntrustedContext(params) {
	if (!params.isGuild) return;
	const untrustedChannelMetadata = buildUntrustedChannelMetadata({
		source: "discord",
		label: "Discord channel topic",
		entries: [params.channelTopic]
	});
	return untrustedChannelMetadata ? [untrustedChannelMetadata] : void 0;
}
function buildDiscordInboundAccessContext(params) {
	return {
		groupSystemPrompt: params.isGuild ? buildDiscordGroupSystemPrompt(params.channelConfig) : void 0,
		untrustedContext: buildDiscordUntrustedContext({
			isGuild: params.isGuild,
			channelTopic: params.channelTopic
		}),
		ownerAllowFrom: resolveDiscordOwnerAllowFrom({
			channelConfig: params.channelConfig,
			guildInfo: params.guildInfo,
			sender: params.sender,
			allowNameMatching: params.allowNameMatching
		})
	};
}
//#endregion
//#region extensions/discord/src/monitor/sender-identity.ts
init_format();
function resolveDiscordWebhookId(message) {
	const candidate = message.webhookId ?? message.webhook_id;
	return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}
function resolveDiscordSenderIdentity(params) {
	const pkInfo = params.pluralkitInfo ?? null;
	const pkMember = pkInfo?.member ?? void 0;
	const pkSystem = pkInfo?.system ?? void 0;
	const memberId = pkMember?.id?.trim();
	const memberName = (pkMember?.display_name ?? pkMember?.name ?? "")?.trim();
	if (memberId && memberName) {
		const systemName = pkSystem?.name?.trim();
		const label = systemName ? `${memberName} (PK:${systemName})` : `${memberName} (PK)`;
		return {
			id: memberId,
			name: memberName,
			tag: pkMember?.name?.trim() || void 0,
			label,
			isPluralKit: true,
			pluralkit: {
				memberId,
				memberName,
				systemId: pkSystem?.id?.trim() || void 0,
				systemName
			}
		};
	}
	const senderTag = formatDiscordUserTag(params.author);
	const senderDisplay = params.member?.nickname ?? params.author.globalName ?? params.author.username;
	const senderLabel = senderDisplay && senderTag && senderDisplay !== senderTag ? `${senderDisplay} (${senderTag})` : senderDisplay ?? senderTag ?? params.author.id;
	return {
		id: params.author.id,
		name: params.author.username ?? void 0,
		tag: senderTag,
		label: senderLabel,
		isPluralKit: false
	};
}
//#endregion
//#region extensions/discord/src/monitor/reply-context.ts
init_format();
function resolveReplyContext(message, resolveDiscordMessageText) {
	const referenced = message.referencedMessage;
	if (!referenced?.author) return null;
	const referencedText = resolveDiscordMessageText(referenced, { includeForwarded: true });
	if (!referencedText) return null;
	const sender = resolveDiscordSenderIdentity({
		author: referenced.author,
		pluralkitInfo: null
	});
	return {
		id: referenced.id,
		channelId: referenced.channelId,
		sender: sender.tag ?? sender.label ?? "unknown",
		body: referencedText,
		timestamp: resolveTimestampMs(referenced.timestamp)
	};
}
function buildDirectLabel(author, tagOverride) {
	return `${(tagOverride?.trim() || resolveDiscordSenderIdentity({
		author,
		pluralkitInfo: null
	}).tag) ?? "unknown"} user id:${author.id}`;
}
function buildGuildLabel(params) {
	const { guild, channelName, channelId } = params;
	return `${guild?.name ?? "Guild"} #${channelName} channel id:${channelId}`;
}
//#endregion
//#region extensions/discord/src/monitor/reply-delivery.ts
init_retry();
const DISCORD_DELIVERY_RETRY_DEFAULTS = {
	attempts: 3,
	minDelayMs: 1e3,
	maxDelayMs: 3e4,
	jitter: 0
};
function isRetryableDiscordError(err) {
	const status = err.status ?? err.statusCode;
	return status === 429 || status !== void 0 && status >= 500;
}
function getDiscordRetryAfterMs(err) {
	if (!err || typeof err !== "object") return;
	if ("retryAfter" in err && typeof err.retryAfter === "number" && Number.isFinite(err.retryAfter)) return err.retryAfter * 1e3;
	const retryAfterRaw = err.headers?.["retry-after"];
	if (!retryAfterRaw) return;
	const retryAfterMs = Number(retryAfterRaw) * 1e3;
	return Number.isFinite(retryAfterMs) ? retryAfterMs : void 0;
}
function resolveDeliveryRetryConfig(retry) {
	return resolveRetryConfig(DISCORD_DELIVERY_RETRY_DEFAULTS, retry);
}
async function sendWithRetry(fn, retryConfig) {
	await retryAsync(fn, {
		...retryConfig,
		shouldRetry: (err) => isRetryableDiscordError(err),
		retryAfterMs: getDiscordRetryAfterMs
	});
}
function resolveTargetChannelId(target) {
	if (!target.startsWith("channel:")) return;
	return target.slice(8).trim() || void 0;
}
function resolveBoundThreadBinding(params) {
	const sessionKey = params.sessionKey?.trim();
	if (!params.threadBindings || !sessionKey) return;
	const bindings = params.threadBindings.listBySessionKey(sessionKey);
	if (bindings.length === 0) return;
	const targetChannelId = resolveTargetChannelId(params.target);
	if (!targetChannelId) return;
	return bindings.find((entry) => entry.threadId === targetChannelId);
}
function resolveBindingPersona(cfg, binding) {
	if (!binding) return {};
	const username = (`🤖 ${binding.label?.trim() || binding.agentId}`.trim() || "🤖 agent").slice(0, 80);
	let avatarUrl;
	try {
		const avatar = resolveAgentAvatar(cfg, binding.agentId);
		if (avatar.kind === "remote") avatarUrl = avatar.url;
	} catch {
		avatarUrl = void 0;
	}
	return {
		username,
		avatarUrl
	};
}
async function sendDiscordChunkWithFallback(params) {
	if (!params.text.trim()) return;
	const text = params.text;
	const binding = params.binding;
	if (binding?.webhookId && binding?.webhookToken) try {
		await sendWebhookMessageDiscord(text, {
			cfg: params.cfg,
			webhookId: binding.webhookId,
			webhookToken: binding.webhookToken,
			accountId: binding.accountId,
			threadId: binding.threadId,
			replyTo: params.replyTo,
			username: params.username,
			avatarUrl: params.avatarUrl
		});
		return;
	} catch {}
	if (params.channelId && params.request && params.rest) {
		const { channelId, request, rest } = params;
		await sendWithRetry(() => sendDiscordText(rest, channelId, text, params.replyTo, request, params.maxLinesPerMessage, void 0, void 0, params.chunkMode), params.retryConfig);
		return;
	}
	await sendWithRetry(() => sendMessageDiscord(params.target, text, {
		cfg: params.cfg,
		token: params.token,
		rest: params.rest,
		accountId: params.accountId,
		replyTo: params.replyTo
	}), params.retryConfig);
}
async function sendAdditionalDiscordMedia(params) {
	for (const mediaUrl of params.mediaUrls) {
		const replyTo = params.resolveReplyTo();
		await sendWithRetry(() => sendMessageDiscord(params.target, "", {
			cfg: params.cfg,
			token: params.token,
			rest: params.rest,
			mediaUrl,
			accountId: params.accountId,
			mediaLocalRoots: params.mediaLocalRoots,
			replyTo
		}), params.retryConfig);
	}
}
async function deliverDiscordReply(params) {
	const chunkLimit = Math.min(params.textLimit, 2e3);
	const replyTo = params.replyToId?.trim() || void 0;
	const replyOnce = (params.replyToMode ?? "all") === "first";
	let replyUsed = false;
	const resolveReplyTo = () => {
		if (!replyTo) return;
		if (!replyOnce) return replyTo;
		if (replyUsed) return;
		replyUsed = true;
		return replyTo;
	};
	const binding = resolveBoundThreadBinding({
		threadBindings: params.threadBindings,
		sessionKey: params.sessionKey,
		target: params.target
	});
	const persona = resolveBindingPersona(params.cfg, binding);
	const channelId = resolveTargetChannelId(params.target);
	const account = resolveDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const retryConfig = resolveDeliveryRetryConfig(account.config.retry);
	const request = channelId ? createDiscordRetryRunner({ configRetry: account.config.retry }) : void 0;
	let deliveredAny = false;
	for (const payload of params.replies) {
		const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
		const text = convertMarkdownTables(payload.text ?? "", params.tableMode ?? "code");
		if (!text && mediaList.length === 0) continue;
		if (mediaList.length === 0) {
			const mode = params.chunkMode ?? "length";
			const chunks = chunkDiscordTextWithMode(text, {
				maxChars: chunkLimit,
				maxLines: params.maxLinesPerMessage,
				chunkMode: mode
			});
			if (!chunks.length && text) chunks.push(text);
			for (const chunk of chunks) {
				if (!chunk.trim()) continue;
				const replyTo = resolveReplyTo();
				await sendDiscordChunkWithFallback({
					cfg: params.cfg,
					target: params.target,
					text: chunk,
					token: params.token,
					rest: params.rest,
					accountId: params.accountId,
					maxLinesPerMessage: params.maxLinesPerMessage,
					replyTo,
					binding,
					chunkMode: params.chunkMode,
					username: persona.username,
					avatarUrl: persona.avatarUrl,
					channelId,
					request,
					retryConfig
				});
				deliveredAny = true;
			}
			continue;
		}
		const firstMedia = mediaList[0];
		if (!firstMedia) continue;
		const sendRemainingMedia = () => sendAdditionalDiscordMedia({
			cfg: params.cfg,
			target: params.target,
			token: params.token,
			rest: params.rest,
			accountId: params.accountId,
			mediaUrls: mediaList.slice(1),
			mediaLocalRoots: params.mediaLocalRoots,
			resolveReplyTo,
			retryConfig
		});
		if (payload.audioAsVoice) {
			const replyTo = resolveReplyTo();
			await sendVoiceMessageDiscord(params.target, firstMedia, {
				cfg: params.cfg,
				token: params.token,
				rest: params.rest,
				accountId: params.accountId,
				replyTo
			});
			deliveredAny = true;
			await sendDiscordChunkWithFallback({
				cfg: params.cfg,
				target: params.target,
				text,
				token: params.token,
				rest: params.rest,
				accountId: params.accountId,
				maxLinesPerMessage: params.maxLinesPerMessage,
				replyTo: resolveReplyTo(),
				binding,
				chunkMode: params.chunkMode,
				username: persona.username,
				avatarUrl: persona.avatarUrl,
				channelId,
				request,
				retryConfig
			});
			await sendRemainingMedia();
			continue;
		}
		const replyTo = resolveReplyTo();
		await sendMessageDiscord(params.target, text, {
			cfg: params.cfg,
			token: params.token,
			rest: params.rest,
			mediaUrl: firstMedia,
			accountId: params.accountId,
			mediaLocalRoots: params.mediaLocalRoots,
			replyTo
		});
		deliveredAny = true;
		await sendRemainingMedia();
	}
	if (binding && deliveredAny) params.threadBindings?.touchThread?.({ threadId: binding.threadId });
}
//#endregion
//#region extensions/discord/src/monitor/threading.ts
init_globals();
const DISCORD_THREAD_STARTER_CACHE_TTL_MS = 300 * 1e3;
const DISCORD_THREAD_STARTER_CACHE_MAX = 500;
const DISCORD_THREAD_STARTER_CACHE = /* @__PURE__ */ new Map();
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
function isDiscordThreadType(type) {
	return type === ChannelType$1.PublicThread || type === ChannelType$1.PrivateThread || type === ChannelType$1.AnnouncementThread;
}
function resolveTrimmedDiscordMessageChannelId(params) {
	return (params.messageChannelId || resolveDiscordMessageChannelId({ message: params.message })).trim();
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
	let parentId = threadChannel.parentId ?? threadChannel.parent?.id ?? channelInfo?.parentId ?? void 0;
	if (!parentId && threadChannel.id) parentId = (await resolveDiscordChannelInfo(client, threadChannel.id))?.parentId ?? void 0;
	if (!parentId) return {};
	let parentName = threadChannel.parent?.name;
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
		const parentType = params.parentType;
		const messageChannelId = parentType === ChannelType$1.GuildForum || parentType === ChannelType$1.GuildMedia ? params.channel.id : params.parentId;
		if (!messageChannelId) return null;
		const starter = await params.client.rest.get(Routes.channelMessage(messageChannelId, params.channel.id));
		if (!starter) return null;
		const content = starter.content?.trim() ?? "";
		const embedText = resolveDiscordEmbedText(starter.embeds?.[0]);
		const text = content || embedText;
		if (!text) return null;
		const payload = {
			text,
			author: starter.member?.nick ?? starter.member?.displayName ?? (starter.author ? starter.author.discriminator && starter.author.discriminator !== "0" ? `${starter.author.username ?? "Unknown"}#${starter.author.discriminator}` : starter.author.username ?? starter.author.id ?? "Unknown" : "Unknown"),
			timestamp: params.resolveTimestampMs(starter.timestamp) ?? void 0
		};
		setCachedThreadStarter(cacheKey, payload, Date.now());
		return payload;
	} catch {
		return null;
	}
}
function sanitizeDiscordThreadName(rawName, fallbackId) {
	return truncateUtf16Safe(truncateUtf16Safe(rawName.replace(/<@!?\d+>/g, "").replace(/<@&\d+>/g, "").replace(/<#\d+>/g, "").replace(/\s+/g, " ").trim() || `Thread ${fallbackId}`, 80), 100) || `Thread ${fallbackId}`;
}
function resolveDiscordAutoThreadContext(params) {
	const createdThreadId = String(params.createdThreadId ?? "").trim();
	if (!createdThreadId) return null;
	const messageChannelId = params.messageChannelId.trim();
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
		ParentSessionKey: parentSessionKey
	};
}
async function resolveDiscordAutoThreadReplyPlan(params) {
	const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
	const originalReplyTarget = `channel:${params.threadChannel?.id ?? (messageChannelId || "unknown")}`;
	const createdThreadId = await maybeCreateDiscordAutoThread({
		client: params.client,
		message: params.message,
		messageChannelId: messageChannelId || void 0,
		isGuildMessage: params.isGuildMessage,
		channelConfig: params.channelConfig,
		threadChannel: params.threadChannel,
		channelType: params.channelType,
		baseText: params.baseText,
		combinedBody: params.combinedBody
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
		createdThreadId
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
	if (params.channelType === ChannelType$1.GuildForum || params.channelType === ChannelType$1.GuildMedia || params.channelType === ChannelType$1.GuildVoice || params.channelType === ChannelType$1.GuildStageVoice) return;
	const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
	if (!messageChannelId) return;
	try {
		const threadName = sanitizeDiscordThreadName(params.baseText || params.combinedBody || "Thread", params.message.id);
		const archiveDuration = params.channelConfig?.autoArchiveDuration ? Number(params.channelConfig.autoArchiveDuration) : 60;
		const created = await params.client.rest.post(`${Routes.channelMessage(messageChannelId, params.message.id)}/threads`, { body: {
			name: threadName,
			auto_archive_duration: archiveDuration
		} });
		return (created?.id ? String(created.id) : "") || void 0;
	} catch (err) {
		logVerbose(`discord: autoThread creation failed for ${messageChannelId}/${params.message.id}: ${String(err)}`);
		try {
			const msg = await params.client.rest.get(Routes.channelMessage(messageChannelId, params.message.id));
			const existingThreadId = msg?.thread?.id ? String(msg.thread.id) : "";
			if (existingThreadId) {
				logVerbose(`discord: autoThread reusing existing thread ${existingThreadId} on ${messageChannelId}/${params.message.id}`);
				return existingThreadId;
			}
		} catch {}
		return;
	}
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
//#region extensions/discord/src/monitor/typing.ts
async function sendTyping(params) {
	const channel = await params.client.fetchChannel(params.channelId);
	if (!channel) return;
	if ("triggerTyping" in channel && typeof channel.triggerTyping === "function") await channel.triggerTyping();
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.process.ts
init_globals();
init_session_key();
init_utils();
init_accounts();
init_allow_list();
init_format();
function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
const DISCORD_TYPING_MAX_DURATION_MS = 20 * 6e4;
function isProcessAborted(abortSignal) {
	return Boolean(abortSignal?.aborted);
}
async function processDiscordMessage(ctx) {
	const { cfg, discordConfig, accountId, token, runtime, guildHistories, historyLimit, mediaMaxBytes, textLimit, replyToMode, ackReactionScope, message, author, sender, data, client, channelInfo, channelName, messageChannelId, isGuildMessage, isDirectMessage, isGroupDm, baseText, messageText, shouldRequireMention, canDetectMention, effectiveWasMentioned, shouldBypassMention, threadChannel, threadParentId, threadParentName, threadParentType, threadName, displayChannelSlug, guildInfo, guildSlug, channelConfig, baseSessionKey, boundSessionKey, threadBindings, route, commandAuthorized, discordRestFetch, abortSignal } = ctx;
	if (isProcessAborted(abortSignal)) return;
	const ssrfPolicy = cfg.browser?.ssrfPolicy;
	const mediaList = await resolveMediaList(message, mediaMaxBytes, discordRestFetch, ssrfPolicy);
	if (isProcessAborted(abortSignal)) return;
	const forwardedMediaList = await resolveForwardedMediaList(message, mediaMaxBytes, discordRestFetch, ssrfPolicy);
	if (isProcessAborted(abortSignal)) return;
	mediaList.push(...forwardedMediaList);
	const text = messageText;
	if (!text) {
		logVerbose("discord: drop message " + message.id + " (empty content)");
		return;
	}
	const boundThreadId = ctx.threadBinding?.conversation?.conversationId?.trim();
	if (boundThreadId && typeof threadBindings.touchThread === "function") threadBindings.touchThread({ threadId: boundThreadId });
	const ackReaction = resolveAckReaction(cfg, route.agentId, {
		channel: "discord",
		accountId
	});
	const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
	const shouldAckReaction$1 = () => Boolean(ackReaction && shouldAckReaction({
		scope: ackReactionScope,
		isDirect: isDirectMessage,
		isGroup: isGuildMessage || isGroupDm,
		isMentionableGroup: isGuildMessage,
		requireMention: Boolean(shouldRequireMention),
		canDetectMention,
		effectiveWasMentioned,
		shouldBypassMention
	}));
	const statusReactionsEnabled = shouldAckReaction$1();
	const discordRest = client.rest;
	const statusReactions = createStatusReactionController({
		enabled: statusReactionsEnabled,
		adapter: {
			setReaction: async (emoji) => {
				await reactMessageDiscord(messageChannelId, message.id, emoji, { rest: discordRest });
			},
			removeReaction: async (emoji) => {
				await removeReactionDiscord(messageChannelId, message.id, emoji, { rest: discordRest });
			}
		},
		initialEmoji: ackReaction,
		emojis: cfg.messages?.statusReactions?.emojis,
		timing: cfg.messages?.statusReactions?.timing,
		onError: (err) => {
			logAckFailure({
				log: logVerbose,
				channel: "discord",
				target: `${messageChannelId}/${message.id}`,
				error: err
			});
		}
	});
	if (statusReactionsEnabled) statusReactions.setQueued();
	const fromLabel = isDirectMessage ? buildDirectLabel(author) : buildGuildLabel({
		guild: data.guild ?? void 0,
		channelName: channelName ?? messageChannelId,
		channelId: messageChannelId
	});
	const senderLabel = sender.label;
	const isForumParent = threadParentType === ChannelType$1.GuildForum || threadParentType === ChannelType$1.GuildMedia;
	const forumParentSlug = isForumParent && threadParentName ? normalizeDiscordSlug(threadParentName) : "";
	const threadChannelId = threadChannel?.id;
	const forumContextLine = Boolean(threadChannelId && isForumParent && forumParentSlug) && message.id === threadChannelId ? `[Forum parent: #${forumParentSlug}]` : null;
	const groupChannel = isGuildMessage && displayChannelSlug ? `#${displayChannelSlug}` : void 0;
	const groupSubject = isDirectMessage ? void 0 : groupChannel;
	const senderName = sender.isPluralKit ? sender.name ?? author.username : data.member?.nickname ?? author.globalName ?? author.username;
	const senderUsername = sender.isPluralKit ? sender.tag ?? sender.name ?? author.username : author.username;
	const senderTag = sender.tag;
	const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
		channelConfig,
		guildInfo,
		sender: {
			id: sender.id,
			name: sender.name,
			tag: sender.tag
		},
		allowNameMatching: isDangerousNameMatchingEnabled(discordConfig),
		isGuild: isGuildMessage,
		channelTopic: channelInfo?.topic
	});
	const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
	const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
	const previousTimestamp = readSessionUpdatedAt({
		storePath,
		sessionKey: route.sessionKey
	});
	let combinedBody = formatInboundEnvelope({
		channel: "Discord",
		from: fromLabel,
		timestamp: resolveTimestampMs(message.timestamp),
		body: text,
		chatType: isDirectMessage ? "direct" : "channel",
		senderLabel,
		previousTimestamp,
		envelope: envelopeOptions
	});
	const shouldIncludeChannelHistory = !isDirectMessage && !(isGuildMessage && channelConfig?.autoThread && !threadChannel);
	if (shouldIncludeChannelHistory) combinedBody = buildPendingHistoryContextFromMap({
		historyMap: guildHistories,
		historyKey: messageChannelId,
		limit: historyLimit,
		currentMessage: combinedBody,
		formatEntry: (entry) => formatInboundEnvelope({
			channel: "Discord",
			from: fromLabel,
			timestamp: entry.timestamp,
			body: `${entry.body} [id:${entry.messageId ?? "unknown"} channel:${messageChannelId}]`,
			chatType: "channel",
			senderLabel: entry.sender,
			envelope: envelopeOptions
		})
	});
	const replyContext = resolveReplyContext(message, resolveDiscordMessageText);
	if (forumContextLine) combinedBody = `${combinedBody}\n${forumContextLine}`;
	let threadStarterBody;
	let threadLabel;
	let parentSessionKey;
	if (threadChannel) {
		if (channelConfig?.includeThreadStarter !== false) {
			const starter = await resolveDiscordThreadStarter({
				channel: threadChannel,
				client,
				parentId: threadParentId,
				parentType: threadParentType,
				resolveTimestampMs
			});
			if (starter?.text) threadStarterBody = starter.text;
		}
		const parentName = threadParentName ?? "parent";
		threadLabel = threadName ? `Discord thread #${normalizeDiscordSlug(parentName)} › ${threadName}` : `Discord thread #${normalizeDiscordSlug(parentName)}`;
		if (threadParentId) parentSessionKey = buildAgentSessionKey({
			agentId: route.agentId,
			channel: route.channel,
			peer: {
				kind: "channel",
				id: threadParentId
			}
		});
	}
	const mediaPayload = buildDiscordMediaPayload(mediaList);
	const threadKeys = resolveThreadSessionKeys({
		baseSessionKey,
		threadId: threadChannel ? messageChannelId : void 0,
		parentSessionKey,
		useSuffix: false
	});
	const replyPlan = await resolveDiscordAutoThreadReplyPlan({
		client,
		message,
		messageChannelId,
		isGuildMessage,
		channelConfig,
		threadChannel,
		channelType: channelInfo?.type,
		baseText: baseText ?? "",
		combinedBody,
		replyToMode,
		agentId: route.agentId,
		channel: route.channel
	});
	const deliverTarget = replyPlan.deliverTarget;
	const replyTarget = replyPlan.replyTarget;
	const replyReference = replyPlan.replyReference;
	const autoThreadContext = replyPlan.autoThreadContext;
	const effectiveFrom = isDirectMessage ? `discord:${author.id}` : autoThreadContext?.From ?? `discord:channel:${messageChannelId}`;
	const effectiveTo = autoThreadContext?.To ?? replyTarget;
	if (!effectiveTo) {
		runtime.error?.(danger("discord: missing reply target"));
		return;
	}
	const lastRouteTo = isDirectMessage ? `user:${author.id}` : effectiveTo;
	const inboundHistory = shouldIncludeChannelHistory && historyLimit > 0 ? (guildHistories.get(messageChannelId) ?? []).map((entry) => ({
		sender: entry.sender,
		body: entry.body,
		timestamp: entry.timestamp
	})) : void 0;
	const ctxPayload = finalizeInboundContext({
		Body: combinedBody,
		BodyForAgent: baseText ?? text,
		InboundHistory: inboundHistory,
		RawBody: baseText,
		CommandBody: baseText,
		From: effectiveFrom,
		To: effectiveTo,
		SessionKey: boundSessionKey ?? autoThreadContext?.SessionKey ?? threadKeys.sessionKey,
		AccountId: route.accountId,
		ChatType: isDirectMessage ? "direct" : "channel",
		ConversationLabel: fromLabel,
		SenderName: senderName,
		SenderId: sender.id,
		SenderUsername: senderUsername,
		SenderTag: senderTag,
		GroupSubject: groupSubject,
		GroupChannel: groupChannel,
		UntrustedContext: untrustedContext,
		GroupSystemPrompt: isGuildMessage ? groupSystemPrompt : void 0,
		GroupSpace: isGuildMessage ? (guildInfo?.id ?? guildSlug) || void 0 : void 0,
		OwnerAllowFrom: ownerAllowFrom,
		Provider: "discord",
		Surface: "discord",
		WasMentioned: effectiveWasMentioned,
		MessageSid: message.id,
		ReplyToId: replyContext?.id,
		ReplyToBody: replyContext?.body,
		ReplyToSender: replyContext?.sender,
		ParentSessionKey: autoThreadContext?.ParentSessionKey ?? threadKeys.parentSessionKey,
		MessageThreadId: threadChannel?.id ?? autoThreadContext?.createdThreadId ?? void 0,
		ThreadStarterBody: threadStarterBody,
		ThreadLabel: threadLabel,
		Timestamp: resolveTimestampMs(message.timestamp),
		...mediaPayload,
		CommandAuthorized: commandAuthorized,
		CommandSource: "text",
		OriginatingChannel: "discord",
		OriginatingTo: autoThreadContext?.OriginatingTo ?? replyTarget
	});
	const persistedSessionKey = ctxPayload.SessionKey ?? route.sessionKey;
	await recordInboundSession({
		storePath,
		sessionKey: persistedSessionKey,
		ctx: ctxPayload,
		updateLastRoute: {
			sessionKey: persistedSessionKey,
			channel: "discord",
			to: lastRouteTo,
			accountId: route.accountId
		},
		onRecordError: (err) => {
			logVerbose(`discord: failed updating session meta: ${String(err)}`);
		}
	});
	if (shouldLogVerbose()) {
		const preview = truncateUtf16Safe(combinedBody, 200).replace(/\n/g, "\\n");
		logVerbose(`discord inbound: channel=${messageChannelId} deliver=${deliverTarget} from=${ctxPayload.From} preview="${preview}"`);
	}
	const typingChannelId = deliverTarget.startsWith("channel:") ? deliverTarget.slice(8) : messageChannelId;
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg,
		agentId: route.agentId,
		channel: "discord",
		accountId: route.accountId
	});
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "discord",
		accountId
	});
	const maxLinesPerMessage = resolveDiscordMaxLinesPerMessage({
		cfg,
		discordConfig,
		accountId
	});
	const chunkMode = resolveChunkMode(cfg, "discord", accountId);
	const typingCallbacks = createTypingCallbacks({
		start: () => sendTyping({
			client,
			channelId: typingChannelId
		}),
		onStartError: (err) => {
			logTypingFailure({
				log: logVerbose,
				channel: "discord",
				target: typingChannelId,
				error: err
			});
		},
		maxDurationMs: DISCORD_TYPING_MAX_DURATION_MS
	});
	const discordStreamMode = resolveDiscordPreviewStreamMode(discordConfig);
	const draftMaxChars = Math.min(textLimit, 2e3);
	const accountBlockStreamingEnabled = typeof discordConfig?.blockStreaming === "boolean" ? discordConfig.blockStreaming : cfg.agents?.defaults?.blockStreamingDefault === "on";
	const canStreamDraft = discordStreamMode !== "off" && !accountBlockStreamingEnabled;
	const draftReplyToMessageId = () => replyReference.use();
	const deliverChannelId = deliverTarget.startsWith("channel:") ? deliverTarget.slice(8) : messageChannelId;
	const draftStream = canStreamDraft ? createDiscordDraftStream({
		rest: client.rest,
		channelId: deliverChannelId,
		maxChars: draftMaxChars,
		replyToMessageId: draftReplyToMessageId,
		minInitialChars: 30,
		throttleMs: 1200,
		log: logVerbose,
		warn: logVerbose
	}) : void 0;
	const draftChunking = draftStream && discordStreamMode === "block" ? resolveDiscordDraftStreamingChunking(cfg, accountId) : void 0;
	const shouldSplitPreviewMessages = discordStreamMode === "block";
	const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : void 0;
	let lastPartialText = "";
	let draftText = "";
	let hasStreamedMessage = false;
	let finalizedViaPreviewMessage = false;
	const resolvePreviewFinalText = (text) => {
		if (typeof text !== "string") return;
		const formatted = convertMarkdownTables(text, tableMode);
		const chunks = chunkDiscordTextWithMode(formatted, {
			maxChars: draftMaxChars,
			maxLines: maxLinesPerMessage,
			chunkMode
		});
		if (!chunks.length && formatted) chunks.push(formatted);
		if (chunks.length !== 1) return;
		const trimmed = chunks[0].trim();
		if (!trimmed) return;
		const currentPreviewText = discordStreamMode === "block" ? draftText : lastPartialText;
		if (currentPreviewText && currentPreviewText.startsWith(trimmed) && trimmed.length < currentPreviewText.length) return;
		return trimmed;
	};
	const updateDraftFromPartial = (text) => {
		if (!draftStream || !text) return;
		const cleaned = stripReasoningTagsFromText(text, {
			mode: "strict",
			trim: "both"
		});
		if (!cleaned || cleaned.startsWith("Reasoning:\n")) return;
		if (cleaned === lastPartialText) return;
		hasStreamedMessage = true;
		if (discordStreamMode === "partial") {
			if (lastPartialText && lastPartialText.startsWith(cleaned) && cleaned.length < lastPartialText.length) return;
			lastPartialText = cleaned;
			draftStream.update(cleaned);
			return;
		}
		let delta = cleaned;
		if (cleaned.startsWith(lastPartialText)) delta = cleaned.slice(lastPartialText.length);
		else {
			draftChunker?.reset();
			draftText = "";
		}
		lastPartialText = cleaned;
		if (!delta) return;
		if (!draftChunker) {
			draftText = cleaned;
			draftStream.update(draftText);
			return;
		}
		draftChunker.append(delta);
		draftChunker.drain({
			force: false,
			emit: (chunk) => {
				draftText += chunk;
				draftStream.update(draftText);
			}
		});
	};
	const flushDraft = async () => {
		if (!draftStream) return;
		if (draftChunker?.hasBuffered()) {
			draftChunker.drain({
				force: true,
				emit: (chunk) => {
					draftText += chunk;
				}
			});
			draftChunker.reset();
			if (draftText) draftStream.update(draftText);
		}
		await draftStream.flush();
	};
	const disableBlockStreamingForDraft = draftStream ? true : void 0;
	const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } = createReplyDispatcherWithTyping({
		...prefixOptions,
		humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
		typingCallbacks,
		deliver: async (payload, info) => {
			if (isProcessAborted(abortSignal)) return;
			const isFinal = info.kind === "final";
			if (payload.isReasoning) return;
			if (draftStream && isFinal) {
				await flushDraft();
				const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
				const finalText = payload.text;
				const previewFinalText = resolvePreviewFinalText(finalText);
				const previewMessageId = draftStream.messageId();
				if (!finalizedViaPreviewMessage && !hasMedia && typeof previewFinalText === "string" && typeof previewMessageId === "string" && !payload.isError) {
					await draftStream.stop();
					if (isProcessAborted(abortSignal)) return;
					try {
						await editMessageDiscord(deliverChannelId, previewMessageId, { content: previewFinalText }, { rest: client.rest });
						finalizedViaPreviewMessage = true;
						replyReference.markSent();
						return;
					} catch (err) {
						logVerbose(`discord: preview final edit failed; falling back to standard send (${String(err)})`);
					}
				}
				if (!finalizedViaPreviewMessage) {
					await draftStream.stop();
					if (isProcessAborted(abortSignal)) return;
					const messageIdAfterStop = draftStream.messageId();
					if (typeof messageIdAfterStop === "string" && typeof previewFinalText === "string" && !hasMedia && !payload.isError) try {
						await editMessageDiscord(deliverChannelId, messageIdAfterStop, { content: previewFinalText }, { rest: client.rest });
						finalizedViaPreviewMessage = true;
						replyReference.markSent();
						return;
					} catch (err) {
						logVerbose(`discord: post-stop preview edit failed; falling back to standard send (${String(err)})`);
					}
				}
				if (!finalizedViaPreviewMessage) await draftStream.clear();
			}
			if (isProcessAborted(abortSignal)) return;
			const replyToId = replyReference.use();
			await deliverDiscordReply({
				cfg,
				replies: [payload],
				target: deliverTarget,
				token,
				accountId,
				rest: client.rest,
				runtime,
				replyToId,
				replyToMode,
				textLimit,
				maxLinesPerMessage,
				tableMode,
				chunkMode,
				sessionKey: ctxPayload.SessionKey,
				threadBindings,
				mediaLocalRoots
			});
			replyReference.markSent();
		},
		onError: (err, info) => {
			runtime.error?.(danger(`discord ${info.kind} reply failed: ${String(err)}`));
		},
		onReplyStart: async () => {
			if (isProcessAborted(abortSignal)) return;
			await typingCallbacks.onReplyStart();
			await statusReactions.setThinking();
		}
	});
	let dispatchResult = null;
	let dispatchError = false;
	let dispatchAborted = false;
	try {
		if (isProcessAborted(abortSignal)) {
			dispatchAborted = true;
			return;
		}
		dispatchResult = await dispatchInboundMessage({
			ctx: ctxPayload,
			cfg,
			dispatcher,
			replyOptions: {
				...replyOptions,
				abortSignal,
				skillFilter: channelConfig?.skills,
				disableBlockStreaming: disableBlockStreamingForDraft ?? (typeof discordConfig?.blockStreaming === "boolean" ? !discordConfig.blockStreaming : void 0),
				onPartialReply: draftStream ? (payload) => updateDraftFromPartial(payload.text) : void 0,
				onAssistantMessageStart: draftStream ? () => {
					if (shouldSplitPreviewMessages && hasStreamedMessage) {
						logVerbose("discord: calling forceNewMessage() for draft stream");
						draftStream.forceNewMessage();
					}
					lastPartialText = "";
					draftText = "";
					draftChunker?.reset();
				} : void 0,
				onReasoningEnd: draftStream ? () => {
					if (shouldSplitPreviewMessages && hasStreamedMessage) {
						logVerbose("discord: calling forceNewMessage() for draft stream");
						draftStream.forceNewMessage();
					}
					lastPartialText = "";
					draftText = "";
					draftChunker?.reset();
				} : void 0,
				onModelSelected,
				onReasoningStream: async () => {
					await statusReactions.setThinking();
				},
				onToolStart: async (payload) => {
					if (isProcessAborted(abortSignal)) return;
					await statusReactions.setTool(payload.name);
				},
				onCompactionStart: async () => {
					if (isProcessAborted(abortSignal)) return;
					await statusReactions.setCompacting();
				},
				onCompactionEnd: async () => {
					if (isProcessAborted(abortSignal)) return;
					statusReactions.cancelPending();
					await statusReactions.setThinking();
				}
			}
		});
		if (isProcessAborted(abortSignal)) {
			dispatchAborted = true;
			return;
		}
	} catch (err) {
		if (isProcessAborted(abortSignal)) {
			dispatchAborted = true;
			return;
		}
		dispatchError = true;
		throw err;
	} finally {
		try {
			await draftStream?.stop();
			if (!finalizedViaPreviewMessage) await draftStream?.clear();
		} catch (err) {
			logVerbose(`discord: draft cleanup failed: ${String(err)}`);
		} finally {
			markRunComplete();
			markDispatchIdle();
		}
		if (statusReactionsEnabled) if (dispatchAborted) if (removeAckAfterReply) statusReactions.clear();
		else statusReactions.restoreInitial();
		else {
			if (dispatchError) await statusReactions.setError();
			else await statusReactions.setDone();
			if (removeAckAfterReply) (async () => {
				await sleep(dispatchError ? DEFAULT_TIMING.errorHoldMs : DEFAULT_TIMING.doneHoldMs);
				await statusReactions.clear();
			})();
			else statusReactions.restoreInitial();
		}
	}
	if (dispatchAborted) return;
	if (!dispatchResult?.queuedFinal) {
		if (isGuildMessage) clearHistoryEntriesIfEnabled({
			historyMap: guildHistories,
			historyKey: messageChannelId,
			limit: historyLimit
		});
		return;
	}
	if (shouldLogVerbose()) {
		const finalCount = dispatchResult.counts.final;
		logVerbose(`discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`);
	}
	if (isGuildMessage) clearHistoryEntriesIfEnabled({
		historyMap: guildHistories,
		historyKey: messageChannelId,
		limit: historyLimit
	});
}
//#endregion
//#region extensions/discord/src/monitor/inbound-worker.ts
init_globals();
function formatDiscordRunContextSuffix(job) {
	const channelId = job.payload.messageChannelId?.trim();
	const messageId = job.payload.data?.message?.id?.trim();
	const details = [channelId ? `channelId=${channelId}` : null, messageId ? `messageId=${messageId}` : null].filter((entry) => Boolean(entry));
	if (details.length === 0) return "";
	return ` (${details.join(", ")})`;
}
async function processDiscordInboundJob(params) {
	const timeoutMs = normalizeDiscordInboundWorkerTimeoutMs(params.runTimeoutMs);
	const contextSuffix = formatDiscordRunContextSuffix(params.job);
	await runDiscordTaskWithTimeout({
		run: async (abortSignal) => {
			await processDiscordMessage(materializeDiscordInboundJob(params.job, abortSignal));
		},
		timeoutMs,
		abortSignals: [params.job.runtime.abortSignal, params.lifecycleSignal],
		onTimeout: (resolvedTimeoutMs) => {
			params.runtime.error?.(danger(`discord inbound worker timed out after ${formatDurationSeconds(resolvedTimeoutMs, {
				decimals: 1,
				unit: "seconds"
			})}${contextSuffix}`));
		},
		onErrorAfterTimeout: (error) => {
			params.runtime.error?.(danger(`discord inbound worker failed after timeout: ${String(error)}${contextSuffix}`));
		}
	});
}
function createDiscordInboundWorker(params) {
	const runQueue = new KeyedAsyncQueue();
	const runState = createRunStateMachine({
		setStatus: params.setStatus,
		abortSignal: params.abortSignal
	});
	return {
		enqueue(job) {
			runQueue.enqueue(job.queueKey, async () => {
				if (!runState.isActive()) return;
				runState.onRunStart();
				try {
					if (!runState.isActive()) return;
					await processDiscordInboundJob({
						job,
						runtime: params.runtime,
						lifecycleSignal: params.abortSignal,
						runTimeoutMs: params.runTimeoutMs
					});
				} finally {
					runState.onRunEnd();
				}
			}).catch((error) => {
				params.runtime.error?.(danger(`discord inbound worker failed: ${String(error)}`));
			});
		},
		deactivate: runState.deactivate
	};
}
//#endregion
//#region extensions/discord/src/pluralkit.ts
init_conversation_binding();
init_session_binding_service();
init_fetch();
const PLURALKIT_API_BASE = "https://api.pluralkit.me/v2";
async function fetchPluralKitMessageInfo(params) {
	if (!params.config?.enabled) return null;
	const fetchImpl = resolveFetch(params.fetcher);
	if (!fetchImpl) return null;
	const headers = {};
	if (params.config.token?.trim()) headers.Authorization = params.config.token.trim();
	const res = await fetchImpl(`${PLURALKIT_API_BASE}/messages/${params.messageId}`, { headers });
	if (res.status === 404) return null;
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		const detail = text.trim() ? `: ${text.trim()}` : "";
		throw new Error(`PluralKit API failed (${res.status})${detail}`);
	}
	return await res.json();
}
//#endregion
//#region extensions/discord/src/monitor/dm-command-auth.ts
init_fetch_timeout();
init_allow_list();
const DISCORD_ALLOW_LIST_PREFIXES = [
	"discord:",
	"user:",
	"pk:"
];
function resolveSenderAllowMatch(params) {
	const allowList = normalizeDiscordAllowList(params.allowEntries, DISCORD_ALLOW_LIST_PREFIXES);
	return allowList ? resolveDiscordAllowListMatch({
		allowList,
		candidate: params.sender,
		allowNameMatching: params.allowNameMatching
	}) : { allowed: false };
}
function resolveDmPolicyCommandAuthorization(params) {
	if (params.dmPolicy === "open" && params.decision === "allow") return true;
	return params.commandAuthorized;
}
async function resolveDiscordDmCommandAccess(params) {
	const storeAllowFrom = params.readStoreAllowFrom ? await params.readStoreAllowFrom().catch(() => []) : await readStoreAllowFromForDmPolicy({
		provider: "discord",
		accountId: params.accountId,
		dmPolicy: params.dmPolicy
	});
	const access = resolveDmGroupAccessWithLists({
		isGroup: false,
		dmPolicy: params.dmPolicy,
		allowFrom: params.configuredAllowFrom,
		groupAllowFrom: [],
		storeAllowFrom,
		isSenderAllowed: (allowEntries) => resolveSenderAllowMatch({
			allowEntries,
			sender: params.sender,
			allowNameMatching: params.allowNameMatching
		}).allowed
	});
	const allowMatch = resolveSenderAllowMatch({
		allowEntries: access.effectiveAllowFrom,
		sender: params.sender,
		allowNameMatching: params.allowNameMatching
	});
	const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups: params.useAccessGroups,
		authorizers: [{
			configured: access.effectiveAllowFrom.length > 0,
			allowed: allowMatch.allowed
		}],
		modeWhenAccessGroupsOff: "configured"
	});
	return {
		decision: access.decision,
		reason: access.reason,
		commandAuthorized: resolveDmPolicyCommandAuthorization({
			dmPolicy: params.dmPolicy,
			decision: access.decision,
			commandAuthorized
		}),
		allowMatch
	};
}
//#endregion
//#region extensions/discord/src/monitor/dm-command-decision.ts
async function handleDiscordDmCommandDecision(params) {
	if (params.dmAccess.decision === "allow") return true;
	if (params.dmAccess.decision === "pairing") {
		const upsertPairingRequest = params.upsertPairingRequest ?? upsertChannelPairingRequest;
		const result = await issuePairingChallenge({
			channel: "discord",
			senderId: params.sender.id,
			senderIdLine: `Your Discord user id: ${params.sender.id}`,
			meta: {
				tag: params.sender.tag,
				name: params.sender.name
			},
			upsertPairingRequest: async ({ id, meta }) => await upsertPairingRequest({
				channel: "discord",
				id,
				accountId: params.accountId,
				meta
			}),
			sendPairingReply: async () => {}
		});
		if (result.created && result.code) await params.onPairingCreated(result.code);
		return false;
	}
	await params.onUnauthorized();
	return false;
}
//#endregion
//#region extensions/discord/src/monitor/preflight-audio.ts
init_globals();
function collectAudioAttachments(attachments) {
	if (!Array.isArray(attachments)) return [];
	return attachments.filter((att) => att.content_type?.startsWith("audio/"));
}
async function resolveDiscordPreflightAudioMentionContext(params) {
	const audioAttachments = collectAudioAttachments(params.message.attachments);
	const hasAudioAttachment = audioAttachments.length > 0;
	const hasTypedText = Boolean(params.message.content?.trim());
	const needsPreflightTranscription = !params.isDirectMessage && params.shouldRequireMention && hasAudioAttachment && !hasTypedText && params.mentionRegexes.length > 0;
	let transcript;
	if (needsPreflightTranscription) {
		if (params.abortSignal?.aborted) return {
			hasAudioAttachment,
			hasTypedText
		};
		try {
			const { transcribeFirstAudio } = await import("./audio-preflight-Cm_5btQa.js");
			if (params.abortSignal?.aborted) return {
				hasAudioAttachment,
				hasTypedText
			};
			const audioUrls = audioAttachments.map((att) => att.url).filter((url) => typeof url === "string" && url.length > 0);
			if (audioUrls.length > 0) {
				transcript = await transcribeFirstAudio({
					ctx: {
						MediaUrls: audioUrls,
						MediaTypes: audioAttachments.map((att) => att.content_type).filter((contentType) => Boolean(contentType))
					},
					cfg: params.cfg,
					agentDir: void 0
				});
				if (params.abortSignal?.aborted) transcript = void 0;
			}
		} catch (err) {
			logVerbose(`discord: audio preflight transcription failed: ${String(err)}`);
		}
	}
	return {
		hasAudioAttachment,
		hasTypedText,
		transcript
	};
}
//#endregion
//#region extensions/discord/src/monitor/route-resolution.ts
init_session_key();
function buildDiscordRoutePeer(params) {
	return {
		kind: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
		id: params.isDirectMessage ? params.directUserId?.trim() || params.conversationId : params.conversationId
	};
}
function resolveDiscordConversationRoute(params) {
	return resolveAgentRoute({
		cfg: params.cfg,
		channel: "discord",
		accountId: params.accountId,
		guildId: params.guildId ?? void 0,
		memberRoleIds: params.memberRoleIds,
		peer: params.peer,
		parentPeer: params.parentConversationId ? {
			kind: "channel",
			id: params.parentConversationId
		} : void 0
	});
}
function resolveDiscordBoundConversationRoute(params) {
	return resolveDiscordEffectiveRoute({
		route: resolveDiscordConversationRoute({
			cfg: params.cfg,
			accountId: params.accountId,
			guildId: params.guildId,
			memberRoleIds: params.memberRoleIds,
			peer: buildDiscordRoutePeer({
				isDirectMessage: params.isDirectMessage,
				isGroupDm: params.isGroupDm,
				directUserId: params.directUserId,
				conversationId: params.conversationId
			}),
			parentConversationId: params.parentConversationId
		}),
		boundSessionKey: params.boundSessionKey,
		configuredRoute: params.configuredRoute,
		matchedBy: params.matchedBy
	});
}
function resolveDiscordEffectiveRoute(params) {
	const boundSessionKey = params.boundSessionKey?.trim();
	if (!boundSessionKey) return params.configuredRoute?.route ?? params.route;
	return {
		...params.route,
		sessionKey: boundSessionKey,
		agentId: resolveAgentIdFromSessionKey(boundSessionKey),
		lastRoutePolicy: deriveLastRoutePolicy({
			sessionKey: boundSessionKey,
			mainSessionKey: params.route.mainSessionKey
		}),
		...params.matchedBy ? { matchedBy: params.matchedBy } : {}
	};
}
//#endregion
//#region extensions/discord/src/monitor/system-events.ts
init_format();
function resolveDiscordSystemEvent(message, location) {
	switch (message.type) {
		case MessageType.ChannelPinnedMessage: return buildDiscordSystemEvent(message, location, "pinned a message");
		case MessageType.RecipientAdd: return buildDiscordSystemEvent(message, location, "added a recipient");
		case MessageType.RecipientRemove: return buildDiscordSystemEvent(message, location, "removed a recipient");
		case MessageType.UserJoin: return buildDiscordSystemEvent(message, location, "user joined");
		case MessageType.GuildBoost: return buildDiscordSystemEvent(message, location, "boosted the server");
		case MessageType.GuildBoostTier1: return buildDiscordSystemEvent(message, location, "boosted the server (Tier 1 reached)");
		case MessageType.GuildBoostTier2: return buildDiscordSystemEvent(message, location, "boosted the server (Tier 2 reached)");
		case MessageType.GuildBoostTier3: return buildDiscordSystemEvent(message, location, "boosted the server (Tier 3 reached)");
		case MessageType.ThreadCreated: return buildDiscordSystemEvent(message, location, "created a thread");
		case MessageType.AutoModerationAction: return buildDiscordSystemEvent(message, location, "auto moderation action");
		case MessageType.GuildIncidentAlertModeEnabled: return buildDiscordSystemEvent(message, location, "raid protection enabled");
		case MessageType.GuildIncidentAlertModeDisabled: return buildDiscordSystemEvent(message, location, "raid protection disabled");
		case MessageType.GuildIncidentReportRaid: return buildDiscordSystemEvent(message, location, "raid reported");
		case MessageType.GuildIncidentReportFalseAlarm: return buildDiscordSystemEvent(message, location, "raid report marked false alarm");
		case MessageType.StageStart: return buildDiscordSystemEvent(message, location, "stage started");
		case MessageType.StageEnd: return buildDiscordSystemEvent(message, location, "stage ended");
		case MessageType.StageSpeaker: return buildDiscordSystemEvent(message, location, "stage speaker updated");
		case MessageType.StageTopic: return buildDiscordSystemEvent(message, location, "stage topic updated");
		case MessageType.PollResult: return buildDiscordSystemEvent(message, location, "poll results posted");
		case MessageType.PurchaseNotification: return buildDiscordSystemEvent(message, location, "purchase notification");
		default: return null;
	}
}
function buildDiscordSystemEvent(message, location, action) {
	const authorLabel = message.author ? formatDiscordUserTag(message.author) : "";
	return `Discord system: ${authorLabel ? `${authorLabel} ` : ""}${action} in ${location}`;
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.preflight.ts
init_globals();
init_session_key();
init_allow_list();
init_format();
const DISCORD_BOUND_THREAD_SYSTEM_PREFIXES = [
	"⚙️",
	"🤖",
	"🧰"
];
function isPreflightAborted(abortSignal) {
	return Boolean(abortSignal?.aborted);
}
function isBoundThreadBotSystemMessage(params) {
	if (!params.isBoundThreadSession || !params.isBotAuthor) return false;
	const text = params.text?.trim();
	if (!text) return false;
	return DISCORD_BOUND_THREAD_SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix));
}
function resolvePreflightMentionRequirement(params) {
	if (!params.shouldRequireMention) return false;
	return !params.isBoundThreadSession;
}
function shouldIgnoreBoundThreadWebhookMessage(params) {
	const webhookId = params.webhookId?.trim() || "";
	if (!webhookId) return false;
	const boundWebhookId = typeof params.threadBinding?.metadata?.webhookId === "string" ? params.threadBinding.metadata.webhookId.trim() : "";
	if (!boundWebhookId) {
		const threadId = params.threadId?.trim() || "";
		if (!threadId) return false;
		return isRecentlyUnboundThreadWebhookMessage({
			accountId: params.accountId,
			threadId,
			webhookId
		});
	}
	return webhookId === boundWebhookId;
}
async function preflightDiscordMessage(params) {
	if (isPreflightAborted(params.abortSignal)) return null;
	const logger = getChildLogger({ module: "discord-auto-reply" });
	const message = params.data.message;
	const author = params.data.author;
	if (!author) return null;
	const messageChannelId = resolveDiscordMessageChannelId({
		message,
		eventChannelId: params.data.channel_id
	});
	if (!messageChannelId) {
		logVerbose(`discord: drop message ${message.id} (missing channel id)`);
		return null;
	}
	const allowBotsSetting = params.discordConfig?.allowBots;
	const allowBotsMode = allowBotsSetting === "mentions" ? "mentions" : allowBotsSetting === true ? "all" : "off";
	if (params.botUserId && author.id === params.botUserId) return null;
	const pluralkitConfig = params.discordConfig?.pluralkit;
	const webhookId = resolveDiscordWebhookId(message);
	const shouldCheckPluralKit = Boolean(pluralkitConfig?.enabled) && !webhookId;
	let pluralkitInfo = null;
	if (shouldCheckPluralKit) try {
		pluralkitInfo = await fetchPluralKitMessageInfo({
			messageId: message.id,
			config: pluralkitConfig
		});
		if (isPreflightAborted(params.abortSignal)) return null;
	} catch (err) {
		logVerbose(`discord: pluralkit lookup failed for ${message.id}: ${String(err)}`);
	}
	const sender = resolveDiscordSenderIdentity({
		author,
		member: params.data.member,
		pluralkitInfo
	});
	if (author.bot) {
		if (allowBotsMode === "off" && !sender.isPluralKit) {
			logVerbose("discord: drop bot message (allowBots=false)");
			return null;
		}
	}
	const isGuildMessage = Boolean(params.data.guild_id);
	const channelInfo = await resolveDiscordChannelInfo(params.client, messageChannelId);
	if (isPreflightAborted(params.abortSignal)) return null;
	const isDirectMessage = channelInfo?.type === ChannelType$1.DM;
	const isGroupDm = channelInfo?.type === ChannelType$1.GroupDM;
	logDebug(`[discord-preflight] channelId=${messageChannelId} guild_id=${params.data.guild_id} channelType=${channelInfo?.type} isGuild=${isGuildMessage} isDM=${isDirectMessage} isGroupDm=${isGroupDm}`);
	if (isGroupDm && !params.groupDmEnabled) {
		logVerbose("discord: drop group dm (group dms disabled)");
		return null;
	}
	if (isDirectMessage && !params.dmEnabled) {
		logVerbose("discord: drop dm (dms disabled)");
		return null;
	}
	const dmPolicy = params.discordConfig?.dmPolicy ?? params.discordConfig?.dm?.policy ?? "pairing";
	const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
	const resolvedAccountId = params.accountId ?? "default";
	const allowNameMatching = isDangerousNameMatchingEnabled(params.discordConfig);
	let commandAuthorized = true;
	if (isDirectMessage) {
		if (dmPolicy === "disabled") {
			logVerbose("discord: drop dm (dmPolicy: disabled)");
			return null;
		}
		const dmAccess = await resolveDiscordDmCommandAccess({
			accountId: resolvedAccountId,
			dmPolicy,
			configuredAllowFrom: params.allowFrom ?? [],
			sender: {
				id: sender.id,
				name: sender.name,
				tag: sender.tag
			},
			allowNameMatching,
			useAccessGroups
		});
		if (isPreflightAborted(params.abortSignal)) return null;
		commandAuthorized = dmAccess.commandAuthorized;
		if (dmAccess.decision !== "allow") {
			const allowMatchMeta = formatAllowlistMatchMeta(dmAccess.allowMatch.allowed ? dmAccess.allowMatch : void 0);
			await handleDiscordDmCommandDecision({
				dmAccess,
				accountId: resolvedAccountId,
				sender: {
					id: author.id,
					tag: formatDiscordUserTag(author),
					name: author.username ?? void 0
				},
				onPairingCreated: async (code) => {
					logVerbose(`discord pairing request sender=${author.id} tag=${formatDiscordUserTag(author)} (${allowMatchMeta})`);
					try {
						await sendMessageDiscord(`user:${author.id}`, buildPairingReply({
							channel: "discord",
							idLine: `Your Discord user id: ${author.id}`,
							code
						}), {
							token: params.token,
							rest: params.client.rest,
							accountId: params.accountId
						});
					} catch (err) {
						logVerbose(`discord pairing reply failed for ${author.id}: ${String(err)}`);
					}
				},
				onUnauthorized: async () => {
					logVerbose(`Blocked unauthorized discord sender ${sender.id} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`);
				}
			});
			return null;
		}
	}
	const botId = params.botUserId;
	const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
	const messageText = resolveDiscordMessageText(message, { includeForwarded: true });
	if (!isDirectMessage && baseText && hasControlCommand(baseText, params.cfg)) {
		logVerbose(`discord: drop text-based slash command ${message.id} (intercepted at gateway)`);
		return null;
	}
	recordChannelActivity({
		channel: "discord",
		accountId: params.accountId,
		direction: "inbound"
	});
	const channelName = channelInfo?.name ?? ((isGuildMessage || isGroupDm) && message.channel && "name" in message.channel ? message.channel.name : void 0);
	const earlyThreadChannel = resolveDiscordThreadChannel({
		isGuildMessage,
		message,
		channelInfo,
		messageChannelId
	});
	let earlyThreadParentId;
	let earlyThreadParentName;
	let earlyThreadParentType;
	if (earlyThreadChannel) {
		const parentInfo = await resolveDiscordThreadParentInfo({
			client: params.client,
			threadChannel: earlyThreadChannel,
			channelInfo
		});
		if (isPreflightAborted(params.abortSignal)) return null;
		earlyThreadParentId = parentInfo.id;
		earlyThreadParentName = parentInfo.name;
		earlyThreadParentType = parentInfo.type;
	}
	const memberRoleIds = Array.isArray(params.data.rawMember?.roles) ? params.data.rawMember.roles.map((roleId) => String(roleId)) : [];
	const freshCfg = loadConfig();
	const route = resolveDiscordConversationRoute({
		cfg: freshCfg,
		accountId: params.accountId,
		guildId: params.data.guild_id ?? void 0,
		memberRoleIds,
		peer: buildDiscordRoutePeer({
			isDirectMessage,
			isGroupDm,
			directUserId: author.id,
			conversationId: messageChannelId
		}),
		parentConversationId: earlyThreadParentId
	});
	const bindingConversationId = isDirectMessage ? `user:${author.id}` : messageChannelId;
	let threadBinding;
	threadBinding = getSessionBindingService().resolveByConversation({
		channel: "discord",
		accountId: params.accountId,
		conversationId: bindingConversationId,
		parentConversationId: earlyThreadParentId
	}) ?? void 0;
	const configuredRoute = threadBinding == null ? resolveConfiguredAcpRoute({
		cfg: freshCfg,
		route,
		channel: "discord",
		accountId: params.accountId,
		conversationId: messageChannelId,
		parentConversationId: earlyThreadParentId
	}) : null;
	const configuredBinding = configuredRoute?.configuredBinding ?? null;
	if (!threadBinding && configuredBinding) threadBinding = configuredBinding.record;
	if (shouldIgnoreBoundThreadWebhookMessage({
		accountId: params.accountId,
		threadId: messageChannelId,
		webhookId,
		threadBinding
	})) {
		logVerbose(`discord: drop bound-thread webhook echo message ${message.id}`);
		return null;
	}
	const boundSessionKey = isPluginOwnedSessionBindingRecord(threadBinding) ? "" : threadBinding?.targetSessionKey?.trim();
	const effectiveRoute = resolveDiscordEffectiveRoute({
		route,
		boundSessionKey,
		configuredRoute,
		matchedBy: "binding.channel"
	});
	const boundAgentId = boundSessionKey ? effectiveRoute.agentId : void 0;
	const isBoundThreadSession = Boolean(threadBinding && earlyThreadChannel);
	if (isBoundThreadBotSystemMessage({
		isBoundThreadSession,
		isBotAuthor: Boolean(author.bot),
		text: messageText
	})) {
		logVerbose(`discord: drop bound-thread bot system message ${message.id}`);
		return null;
	}
	const mentionRegexes = buildMentionRegexes(params.cfg, effectiveRoute.agentId);
	const explicitlyMentioned = Boolean(botId && message.mentionedUsers?.some((user) => user.id === botId));
	const hasAnyMention = Boolean(!isDirectMessage && ((message.mentionedUsers?.length ?? 0) > 0 || (message.mentionedRoles?.length ?? 0) > 0 || message.mentionedEveryone && (!author.bot || sender.isPluralKit)));
	const hasUserOrRoleMention = Boolean(!isDirectMessage && ((message.mentionedUsers?.length ?? 0) > 0 || (message.mentionedRoles?.length ?? 0) > 0));
	if (isGuildMessage && (message.type === MessageType.ChatInputCommand || message.type === MessageType.ContextMenuCommand)) {
		logVerbose("discord: drop channel command message");
		return null;
	}
	const guildInfo = isGuildMessage ? resolveDiscordGuildEntry({
		guild: params.data.guild ?? void 0,
		guildId: params.data.guild_id ?? void 0,
		guildEntries: params.guildEntries
	}) : null;
	logDebug(`[discord-preflight] guild_id=${params.data.guild_id} guild_obj=${!!params.data.guild} guild_obj_id=${params.data.guild?.id} guildInfo=${!!guildInfo} guildEntries=${params.guildEntries ? Object.keys(params.guildEntries).join(",") : "none"}`);
	if (isGuildMessage && params.guildEntries && Object.keys(params.guildEntries).length > 0 && !guildInfo) {
		logDebug(`[discord-preflight] guild blocked: guild_id=${params.data.guild_id} guildEntries keys=${Object.keys(params.guildEntries).join(",")}`);
		logVerbose(`Blocked discord guild ${params.data.guild_id ?? "unknown"} (not in discord.guilds)`);
		return null;
	}
	const threadChannel = earlyThreadChannel;
	const threadParentId = earlyThreadParentId;
	const threadParentName = earlyThreadParentName;
	const threadParentType = earlyThreadParentType;
	const threadName = threadChannel?.name;
	const configChannelName = threadParentName ?? channelName;
	const configChannelSlug = configChannelName ? normalizeDiscordSlug(configChannelName) : "";
	const displayChannelName = threadName ?? channelName;
	const displayChannelSlug = displayChannelName ? normalizeDiscordSlug(displayChannelName) : "";
	const guildSlug = guildInfo?.slug || (params.data.guild?.name ? normalizeDiscordSlug(params.data.guild.name) : "");
	const threadChannelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
	const threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";
	const baseSessionKey = effectiveRoute.sessionKey;
	const channelConfig = isGuildMessage ? resolveDiscordChannelConfigWithFallback({
		guildInfo,
		channelId: messageChannelId,
		channelName,
		channelSlug: threadChannelSlug,
		parentId: threadParentId ?? void 0,
		parentName: threadParentName ?? void 0,
		parentSlug: threadParentSlug,
		scope: threadChannel ? "thread" : "channel"
	}) : null;
	const channelMatchMeta = formatAllowlistMatchMeta(channelConfig);
	if (shouldLogVerbose()) logDebug(`[discord-preflight] channelConfig=${channelConfig ? `allowed=${channelConfig.allowed} enabled=${channelConfig.enabled ?? "unset"} requireMention=${channelConfig.requireMention ?? "unset"} ignoreOtherMentions=${channelConfig.ignoreOtherMentions ?? "unset"} matchKey=${channelConfig.matchKey ?? "none"} matchSource=${channelConfig.matchSource ?? "none"} users=${channelConfig.users?.length ?? 0} roles=${channelConfig.roles?.length ?? 0} skills=${channelConfig.skills?.length ?? 0}` : "none"} channelMatchMeta=${channelMatchMeta} channelId=${messageChannelId}`);
	if (isGuildMessage && channelConfig?.enabled === false) {
		logDebug(`[discord-preflight] drop: channel disabled`);
		logVerbose(`Blocked discord channel ${messageChannelId} (channel disabled, ${channelMatchMeta})`);
		return null;
	}
	const groupDmAllowed = isGroupDm && resolveGroupDmAllow({
		channels: params.groupDmChannels,
		channelId: messageChannelId,
		channelName: displayChannelName,
		channelSlug: displayChannelSlug
	});
	if (isGroupDm && !groupDmAllowed) return null;
	const channelAllowlistConfigured = Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
	const channelAllowed = channelConfig?.allowed !== false;
	if (isGuildMessage && !isDiscordGroupAllowedByPolicy({
		groupPolicy: params.groupPolicy,
		guildAllowlisted: Boolean(guildInfo),
		channelAllowlistConfigured,
		channelAllowed
	})) {
		if (params.groupPolicy === "disabled") {
			logDebug(`[discord-preflight] drop: groupPolicy disabled`);
			logVerbose(`discord: drop guild message (groupPolicy: disabled, ${channelMatchMeta})`);
		} else if (!channelAllowlistConfigured) {
			logDebug(`[discord-preflight] drop: groupPolicy allowlist, no channel allowlist configured`);
			logVerbose(`discord: drop guild message (groupPolicy: allowlist, no channel allowlist, ${channelMatchMeta})`);
		} else {
			logDebug(`[discord] Ignored message from channel ${messageChannelId} (not in guild allowlist). Add to guilds.<guildId>.channels to enable.`);
			logVerbose(`Blocked discord channel ${messageChannelId} not in guild channel allowlist (groupPolicy: allowlist, ${channelMatchMeta})`);
		}
		return null;
	}
	if (isGuildMessage && channelConfig?.allowed === false) {
		logDebug(`[discord-preflight] drop: channelConfig.allowed===false`);
		logVerbose(`Blocked discord channel ${messageChannelId} not in guild channel allowlist (${channelMatchMeta})`);
		return null;
	}
	if (isGuildMessage) {
		logDebug(`[discord-preflight] pass: channel allowed`);
		logVerbose(`discord: allow channel ${messageChannelId} (${channelMatchMeta})`);
	}
	const textForHistory = resolveDiscordMessageText(message, { includeForwarded: true });
	const historyEntry = isGuildMessage && params.historyLimit > 0 && textForHistory ? {
		sender: sender.label,
		body: textForHistory,
		timestamp: resolveTimestampMs(message.timestamp),
		messageId: message.id
	} : void 0;
	const threadOwnerId = threadChannel ? threadChannel.ownerId ?? channelInfo?.ownerId : void 0;
	const shouldRequireMentionByConfig = resolveDiscordShouldRequireMention({
		isGuildMessage,
		isThread: Boolean(threadChannel),
		botId,
		threadOwnerId,
		channelConfig,
		guildInfo
	});
	const shouldRequireMention = resolvePreflightMentionRequirement({
		shouldRequireMention: shouldRequireMentionByConfig,
		isBoundThreadSession
	});
	const { hasTypedText, transcript: preflightTranscript } = await resolveDiscordPreflightAudioMentionContext({
		message,
		isDirectMessage,
		shouldRequireMention,
		mentionRegexes,
		cfg: params.cfg,
		abortSignal: params.abortSignal
	});
	if (isPreflightAborted(params.abortSignal)) return null;
	const wasMentioned = !isDirectMessage && matchesMentionWithExplicit({
		text: hasTypedText ? baseText : "",
		mentionRegexes,
		explicit: {
			hasAnyMention,
			isExplicitlyMentioned: explicitlyMentioned,
			canResolveExplicit: Boolean(botId)
		},
		transcript: preflightTranscript
	});
	const implicitMention = Boolean(!isDirectMessage && botId && message.referencedMessage?.author?.id && message.referencedMessage.author.id === botId);
	if (shouldLogVerbose()) logVerbose(`discord: inbound id=${message.id} guild=${params.data.guild_id ?? "dm"} channel=${messageChannelId} mention=${wasMentioned ? "yes" : "no"} type=${isDirectMessage ? "dm" : isGroupDm ? "group-dm" : "guild"} content=${messageText ? "yes" : "no"}`);
	const allowTextCommands = shouldHandleTextCommands({
		cfg: params.cfg,
		surface: "discord"
	});
	const hasControlCommandInMessage = hasControlCommand(baseText, params.cfg);
	const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
		channelConfig,
		guildInfo,
		memberRoleIds,
		sender,
		allowNameMatching
	});
	if (!isDirectMessage) {
		const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
			allowFrom: params.allowFrom,
			sender: {
				id: sender.id,
				name: sender.name,
				tag: sender.tag
			},
			allowNameMatching
		});
		const commandGate = resolveControlCommandGate({
			useAccessGroups,
			authorizers: [{
				configured: ownerAllowList != null,
				allowed: ownerOk
			}, {
				configured: hasAccessRestrictions,
				allowed: memberAllowed
			}],
			modeWhenAccessGroupsOff: "configured",
			allowTextCommands,
			hasControlCommand: hasControlCommandInMessage
		});
		commandAuthorized = commandGate.commandAuthorized;
		if (commandGate.shouldBlock) {
			logInboundDrop({
				log: logVerbose,
				channel: "discord",
				reason: "control command (unauthorized)",
				target: sender.id
			});
			return null;
		}
	}
	const canDetectMention = Boolean(botId) || mentionRegexes.length > 0;
	const mentionGate = resolveMentionGatingWithBypass({
		isGroup: isGuildMessage,
		requireMention: Boolean(shouldRequireMention),
		canDetectMention,
		wasMentioned,
		implicitMention,
		hasAnyMention,
		allowTextCommands,
		hasControlCommand: hasControlCommandInMessage,
		commandAuthorized
	});
	const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
	logDebug(`[discord-preflight] shouldRequireMention=${shouldRequireMention} baseRequireMention=${shouldRequireMentionByConfig} boundThreadSession=${isBoundThreadSession} mentionGate.shouldSkip=${mentionGate.shouldSkip} wasMentioned=${wasMentioned}`);
	if (isGuildMessage && shouldRequireMention) {
		if (botId && mentionGate.shouldSkip) {
			logDebug(`[discord-preflight] drop: no-mention`);
			logVerbose(`discord: drop guild message (mention required, botId=${botId})`);
			logger.info({
				channelId: messageChannelId,
				reason: "no-mention"
			}, "discord: skipping guild message");
			recordPendingHistoryEntryIfEnabled({
				historyMap: params.guildHistories,
				historyKey: messageChannelId,
				limit: params.historyLimit,
				entry: historyEntry ?? null
			});
			return null;
		}
	}
	if (author.bot && !sender.isPluralKit && allowBotsMode === "mentions") {
		if (!(isDirectMessage || wasMentioned || implicitMention)) {
			logDebug(`[discord-preflight] drop: bot message missing mention (allowBots=mentions)`);
			logVerbose("discord: drop bot message (allowBots=mentions, missing mention)");
			return null;
		}
	}
	const ignoreOtherMentions = channelConfig?.ignoreOtherMentions ?? guildInfo?.ignoreOtherMentions ?? false;
	if (isGuildMessage && ignoreOtherMentions && hasUserOrRoleMention && !wasMentioned && !implicitMention) {
		logDebug(`[discord-preflight] drop: other-mention`);
		logVerbose(`discord: drop guild message (another user/role mentioned, ignoreOtherMentions=true, botId=${botId})`);
		recordPendingHistoryEntryIfEnabled({
			historyMap: params.guildHistories,
			historyKey: messageChannelId,
			limit: params.historyLimit,
			entry: historyEntry ?? null
		});
		return null;
	}
	if (isGuildMessage && hasAccessRestrictions && !memberAllowed) {
		logDebug(`[discord-preflight] drop: member not allowed`);
		logVerbose(`Blocked discord guild sender ${sender.id} (not in users/roles allowlist)`);
		return null;
	}
	const systemText = resolveDiscordSystemEvent(message, resolveDiscordSystemLocation({
		isDirectMessage,
		isGroupDm,
		guild: params.data.guild ?? void 0,
		channelName: channelName ?? messageChannelId
	}));
	if (systemText) {
		logDebug(`[discord-preflight] drop: system event`);
		enqueueSystemEvent(systemText, {
			sessionKey: effectiveRoute.sessionKey,
			contextKey: `discord:system:${messageChannelId}:${message.id}`
		});
		return null;
	}
	if (!messageText) {
		logDebug(`[discord-preflight] drop: empty content`);
		logVerbose(`discord: drop message ${message.id} (empty content)`);
		return null;
	}
	if (configuredBinding) {
		const ensured = await ensureConfiguredAcpRouteReady({
			cfg: freshCfg,
			configuredBinding
		});
		if (!ensured.ok) {
			logVerbose(`discord: configured ACP binding unavailable for channel ${configuredBinding.spec.conversationId}: ${ensured.error}`);
			return null;
		}
	}
	logDebug(`[discord-preflight] success: route=${effectiveRoute.agentId} sessionKey=${effectiveRoute.sessionKey}`);
	return {
		cfg: params.cfg,
		discordConfig: params.discordConfig,
		accountId: params.accountId,
		token: params.token,
		runtime: params.runtime,
		botUserId: params.botUserId,
		abortSignal: params.abortSignal,
		guildHistories: params.guildHistories,
		historyLimit: params.historyLimit,
		mediaMaxBytes: params.mediaMaxBytes,
		textLimit: params.textLimit,
		replyToMode: params.replyToMode,
		ackReactionScope: params.ackReactionScope,
		groupPolicy: params.groupPolicy,
		data: params.data,
		client: params.client,
		message,
		messageChannelId,
		author,
		sender,
		channelInfo,
		channelName,
		isGuildMessage,
		isDirectMessage,
		isGroupDm,
		commandAuthorized,
		baseText,
		messageText,
		wasMentioned,
		route: effectiveRoute,
		threadBinding,
		boundSessionKey: boundSessionKey || void 0,
		boundAgentId,
		guildInfo,
		guildSlug,
		threadChannel,
		threadParentId,
		threadParentName,
		threadParentType,
		threadName,
		configChannelName,
		configChannelSlug,
		displayChannelName,
		displayChannelSlug,
		baseSessionKey,
		channelConfig,
		channelAllowlistConfigured,
		channelAllowed,
		shouldRequireMention,
		hasAnyMention,
		allowTextCommands,
		shouldBypassMention: mentionGate.shouldBypassMention,
		effectiveWasMentioned,
		canDetectMention,
		historyEntry,
		threadBindings: params.threadBindings,
		discordRestFetch: params.discordRestFetch
	};
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.ts
init_globals();
function createDiscordMessageHandler(params) {
	const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: params.cfg.channels?.discord !== void 0,
		groupPolicy: params.discordConfig?.groupPolicy,
		defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy
	});
	const ackReactionScope = params.discordConfig?.ackReactionScope ?? params.cfg.messages?.ackReactionScope ?? "group-mentions";
	const inboundWorker = createDiscordInboundWorker({
		runtime: params.runtime,
		setStatus: params.setStatus,
		abortSignal: params.abortSignal,
		runTimeoutMs: params.workerRunTimeoutMs
	});
	const { debouncer } = createChannelInboundDebouncer({
		cfg: params.cfg,
		channel: "discord",
		buildKey: (entry) => {
			const message = entry.data.message;
			const authorId = entry.data.author?.id;
			if (!message || !authorId) return null;
			const channelId = resolveDiscordMessageChannelId({
				message,
				eventChannelId: entry.data.channel_id
			});
			if (!channelId) return null;
			return `discord:${params.accountId}:${channelId}:${authorId}`;
		},
		shouldDebounce: (entry) => {
			const message = entry.data.message;
			if (!message) return false;
			return shouldDebounceTextInbound({
				text: resolveDiscordMessageText(message, { includeForwarded: false }),
				cfg: params.cfg,
				hasMedia: Boolean(message.attachments && message.attachments.length > 0 || hasDiscordMessageStickers(message))
			});
		},
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) return;
			const abortSignal = last.abortSignal;
			if (abortSignal?.aborted) return;
			if (entries.length === 1) {
				const ctx = await preflightDiscordMessage({
					...params,
					ackReactionScope,
					groupPolicy,
					abortSignal,
					data: last.data,
					client: last.client
				});
				if (!ctx) return;
				inboundWorker.enqueue(buildDiscordInboundJob(ctx));
				return;
			}
			const combinedBaseText = entries.map((entry) => resolveDiscordMessageText(entry.data.message, { includeForwarded: false })).filter(Boolean).join("\n");
			const syntheticMessage = {
				...last.data.message,
				content: combinedBaseText,
				attachments: [],
				message_snapshots: last.data.message.message_snapshots,
				messageSnapshots: last.data.message.messageSnapshots,
				rawData: { ...last.data.message.rawData }
			};
			const syntheticData = {
				...last.data,
				message: syntheticMessage
			};
			const ctx = await preflightDiscordMessage({
				...params,
				ackReactionScope,
				groupPolicy,
				abortSignal,
				data: syntheticData,
				client: last.client
			});
			if (!ctx) return;
			if (entries.length > 1) {
				const ids = entries.map((entry) => entry.data.message?.id).filter(Boolean);
				if (ids.length > 0) {
					const ctxBatch = ctx;
					ctxBatch.MessageSids = ids;
					ctxBatch.MessageSidFirst = ids[0];
					ctxBatch.MessageSidLast = ids[ids.length - 1];
				}
			}
			inboundWorker.enqueue(buildDiscordInboundJob(ctx));
		},
		onError: (err) => {
			params.runtime.error?.(danger(`discord debounce flush failed: ${String(err)}`));
		}
	});
	const handler = async (data, client, options) => {
		try {
			if (options?.abortSignal?.aborted) return;
			const msgAuthorId = data.message?.author?.id ?? data.author?.id;
			if (params.botUserId && msgAuthorId === params.botUserId) return;
			await debouncer.enqueue({
				data,
				client,
				abortSignal: options?.abortSignal
			});
		} catch (err) {
			params.runtime.error?.(danger(`handler failed: ${String(err)}`));
		}
	};
	handler.deactivate = inboundWorker.deactivate;
	return handler;
}
//#endregion
//#region extensions/discord/src/monitor/model-picker-preferences.ts
init_commands();
const MODEL_PICKER_PREFERENCES_LOCK_OPTIONS = {
	retries: {
		retries: 8,
		factor: 2,
		minTimeout: 50,
		maxTimeout: 5e3,
		randomize: true
	},
	stale: 15e3
};
const DEFAULT_RECENT_LIMIT = 5;
function resolvePreferencesStorePath(env = process.env) {
	const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir));
	return path.join(stateDir, "discord", "model-picker-preferences.json");
}
function normalizeId(value) {
	return value?.trim() ?? "";
}
function buildDiscordModelPickerPreferenceKey(scope) {
	const userId = normalizeId(scope.userId);
	if (!userId) return null;
	const accountId = normalizeAccountId(scope.accountId);
	const guildId = normalizeId(scope.guildId);
	if (guildId) return `discord:${accountId}:guild:${guildId}:user:${userId}`;
	return `discord:${accountId}:dm:user:${userId}`;
}
function normalizeModelRef(raw) {
	const value = raw?.trim();
	if (!value) return null;
	const slashIndex = value.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= value.length - 1) return null;
	const provider = normalizeProviderId(value.slice(0, slashIndex));
	const model = value.slice(slashIndex + 1).trim();
	if (!provider || !model) return null;
	return `${provider}/${model}`;
}
function sanitizeRecentModels(models, limit) {
	const deduped = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of models ?? []) {
		const normalized = normalizeModelRef(item);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		deduped.push(normalized);
		if (deduped.length >= limit) break;
	}
	return deduped;
}
async function readPreferencesStore(filePath) {
	const { value } = await readJsonFileWithFallback(filePath, {
		version: 1,
		entries: {}
	});
	if (!value || typeof value !== "object" || value.version !== 1) return {
		version: 1,
		entries: {}
	};
	return {
		version: 1,
		entries: value.entries && typeof value.entries === "object" ? value.entries : {}
	};
}
async function readDiscordModelPickerRecentModels(params) {
	const key = buildDiscordModelPickerPreferenceKey(params.scope);
	if (!key) return [];
	const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
	const entry = (await readPreferencesStore(resolvePreferencesStorePath(params.env))).entries[key];
	const recent = sanitizeRecentModels(entry?.recent, limit);
	if (!params.allowedModelRefs || params.allowedModelRefs.size === 0) return recent;
	return recent.filter((modelRef) => params.allowedModelRefs?.has(modelRef));
}
async function recordDiscordModelPickerRecentModel(params) {
	const key = buildDiscordModelPickerPreferenceKey(params.scope);
	const normalizedModelRef = normalizeModelRef(params.modelRef);
	if (!key || !normalizedModelRef) return;
	const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
	const filePath = resolvePreferencesStorePath(params.env);
	await withFileLock(filePath, MODEL_PICKER_PREFERENCES_LOCK_OPTIONS, async () => {
		const store = await readPreferencesStore(filePath);
		const next = [normalizedModelRef, ...sanitizeRecentModels(store.entries[key]?.recent, limit).filter((entry) => entry !== normalizedModelRef)].slice(0, limit);
		store.entries[key] = {
			recent: next,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await writeJsonFileAtomically(filePath, store);
	});
}
//#endregion
//#region extensions/discord/src/monitor/model-picker.ts
const DISCORD_MODEL_PICKER_CUSTOM_ID_KEY = "mdlpk";
const DISCORD_PROVIDER_BUTTON_LABEL_MAX_CHARS = 18;
const COMMAND_CONTEXTS = ["model", "models"];
const PICKER_ACTIONS = [
	"open",
	"provider",
	"model",
	"submit",
	"quick",
	"back",
	"reset",
	"cancel",
	"recents"
];
const PICKER_VIEWS = [
	"providers",
	"models",
	"recents"
];
function encodeCustomIdValue$1(value) {
	return encodeURIComponent(value);
}
function decodeCustomIdValue$1(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
function isValidCommandContext(value) {
	return COMMAND_CONTEXTS.includes(value);
}
function isValidPickerAction(value) {
	return PICKER_ACTIONS.includes(value);
}
function isValidPickerView(value) {
	return PICKER_VIEWS.includes(value);
}
function normalizePage(value) {
	const numeric = typeof value === "number" ? value : NaN;
	if (!Number.isFinite(numeric)) return 1;
	return Math.max(1, Math.floor(numeric));
}
function parseRawPage(value) {
	if (typeof value === "number") return normalizePage(value);
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return normalizePage(parsed);
	}
	return 1;
}
function parseRawPositiveInt(value) {
	if (typeof value !== "string" && typeof value !== "number") return;
	const parsed = Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed) || parsed < 1) return;
	return Math.floor(parsed);
}
function coerceString(value) {
	return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function clampPageSize(rawPageSize, max, fallback) {
	if (!Number.isFinite(rawPageSize)) return fallback;
	return Math.min(max, Math.max(1, Math.floor(rawPageSize ?? fallback)));
}
function paginateItems(params) {
	const totalItems = params.items.length;
	const totalPages = Math.max(1, Math.ceil(totalItems / params.pageSize));
	const page = Math.max(1, Math.min(params.page, totalPages));
	const startIndex = (page - 1) * params.pageSize;
	const endIndexExclusive = Math.min(totalItems, startIndex + params.pageSize);
	return {
		items: params.items.slice(startIndex, endIndexExclusive),
		page,
		pageSize: params.pageSize,
		totalPages,
		totalItems,
		hasPrev: page > 1,
		hasNext: page < totalPages
	};
}
function parseCurrentModelRef(raw) {
	const match = (raw?.trim())?.match(/^([^/]+)\/(.+)$/u);
	if (!match) return null;
	const provider = normalizeProviderId(match[1]);
	const model = match[2];
	if (!provider || !model) return null;
	return {
		provider,
		model
	};
}
function formatCurrentModelLine(currentModel) {
	const parsed = parseCurrentModelRef(currentModel);
	if (!parsed) return "Current model: default";
	return `Current model: ${parsed.provider}/${parsed.model}`;
}
function formatProviderButtonLabel(provider) {
	if (provider.length <= DISCORD_PROVIDER_BUTTON_LABEL_MAX_CHARS) return provider;
	return `${provider.slice(0, DISCORD_PROVIDER_BUTTON_LABEL_MAX_CHARS - 1)}…`;
}
function chunkProvidersForRows(items) {
	if (items.length === 0) return [];
	const rowCount = Math.max(1, Math.ceil(items.length / 5));
	const minPerRow = Math.floor(items.length / rowCount);
	const rowsWithExtraItem = items.length % rowCount;
	const counts = Array.from({ length: rowCount }, (_, index) => index < rowCount - rowsWithExtraItem ? minPerRow : minPerRow + 1);
	const rows = [];
	let cursor = 0;
	for (const count of counts) {
		rows.push(items.slice(cursor, cursor + count));
		cursor += count;
	}
	return rows;
}
function createModelPickerButton(params) {
	class DiscordModelPickerButton extends Button {
		constructor(..._args) {
			super(..._args);
			this.label = params.label;
			this.customId = params.customId;
			this.style = params.style ?? ButtonStyle.Secondary;
			this.disabled = params.disabled ?? false;
		}
	}
	return new DiscordModelPickerButton();
}
function createModelSelect(params) {
	class DiscordModelPickerSelect extends StringSelectMenu {
		constructor(..._args2) {
			super(..._args2);
			this.customId = params.customId;
			this.options = params.options;
			this.minValues = 1;
			this.maxValues = 1;
			this.placeholder = params.placeholder;
			this.disabled = params.disabled ?? false;
		}
	}
	return new DiscordModelPickerSelect();
}
function buildRenderedShell(params) {
	if (params.layout === "classic") return {
		layout: "classic",
		content: [
			params.title,
			...params.detailLines,
			"",
			params.footer
		].filter(Boolean).join("\n"),
		components: params.rows
	};
	const containerComponents = [new TextDisplay(`## ${params.title}`)];
	if (params.detailLines.length > 0) containerComponents.push(new TextDisplay(params.detailLines.join("\n")));
	containerComponents.push(new Separator({
		divider: true,
		spacing: "small"
	}));
	if (params.preRowText) containerComponents.push(new TextDisplay(params.preRowText));
	containerComponents.push(...params.rows);
	if (params.trailingRows && params.trailingRows.length > 0) {
		containerComponents.push(new Separator({
			divider: true,
			spacing: "small"
		}));
		containerComponents.push(...params.trailingRows);
	}
	if (params.footer) {
		containerComponents.push(new Separator({
			divider: false,
			spacing: "small"
		}));
		containerComponents.push(new TextDisplay(`-# ${params.footer}`));
	}
	return {
		layout: "v2",
		components: [new Container(containerComponents)]
	};
}
function buildProviderRows(params) {
	return chunkProvidersForRows(params.page.items).map((providers) => new Row(providers.map((provider) => {
		const style = provider.id === params.currentProvider ? ButtonStyle.Primary : ButtonStyle.Secondary;
		return createModelPickerButton({
			label: formatProviderButtonLabel(provider.id),
			style,
			customId: buildDiscordModelPickerCustomId({
				command: params.command,
				action: "provider",
				view: "models",
				provider: provider.id,
				page: params.page.page,
				userId: params.userId
			})
		});
	})));
}
function buildModelRows(params) {
	const parsedCurrentModel = parseCurrentModelRef(params.currentModel);
	const parsedPendingModel = parseCurrentModelRef(params.pendingModel);
	const rows = [];
	const hasQuickModels = (params.quickModels ?? []).length > 0;
	const providerPage = getDiscordModelPickerProviderPage({
		data: params.data,
		page: params.providerPage
	});
	const providerOptions = providerPage.items.map((provider) => ({
		label: provider.id,
		value: provider.id,
		default: provider.id === params.modelPage.provider
	}));
	rows.push(new Row([createModelSelect({
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "provider",
			view: "models",
			provider: params.modelPage.provider,
			page: providerPage.page,
			providerPage: providerPage.page,
			userId: params.userId
		}),
		options: providerOptions,
		placeholder: "Select provider"
	})]));
	const selectedModelRef = parsedPendingModel ?? parsedCurrentModel;
	const modelOptions = params.modelPage.items.map((model) => ({
		label: model,
		value: model,
		default: selectedModelRef ? selectedModelRef.provider === params.modelPage.provider && selectedModelRef.model === model : false
	}));
	rows.push(new Row([createModelSelect({
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "model",
			view: "models",
			provider: params.modelPage.provider,
			page: params.modelPage.page,
			providerPage: providerPage.page,
			userId: params.userId
		}),
		options: modelOptions,
		placeholder: `Select ${params.modelPage.provider} model`
	})]));
	const resolvedDefault = params.data.resolvedDefault;
	const shouldDisableReset = Boolean(parsedCurrentModel) && parsedCurrentModel?.provider === resolvedDefault.provider && parsedCurrentModel?.model === resolvedDefault.model;
	const hasPendingSelection = Boolean(parsedPendingModel) && parsedPendingModel?.provider === params.modelPage.provider && typeof params.pendingModelIndex === "number" && params.pendingModelIndex > 0;
	const buttonRowItems = [createModelPickerButton({
		label: "Cancel",
		style: ButtonStyle.Secondary,
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "cancel",
			view: "models",
			provider: params.modelPage.provider,
			page: params.modelPage.page,
			providerPage: providerPage.page,
			userId: params.userId
		})
	}), createModelPickerButton({
		label: "Reset to default",
		style: ButtonStyle.Secondary,
		disabled: shouldDisableReset,
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "reset",
			view: "models",
			provider: params.modelPage.provider,
			page: params.modelPage.page,
			providerPage: providerPage.page,
			userId: params.userId
		})
	})];
	if (hasQuickModels) buttonRowItems.push(createModelPickerButton({
		label: "Recents",
		style: ButtonStyle.Secondary,
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "recents",
			view: "recents",
			provider: params.modelPage.provider,
			page: params.modelPage.page,
			providerPage: providerPage.page,
			userId: params.userId
		})
	}));
	buttonRowItems.push(createModelPickerButton({
		label: "Submit",
		style: ButtonStyle.Primary,
		disabled: !hasPendingSelection,
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "submit",
			view: "models",
			provider: params.modelPage.provider,
			page: params.modelPage.page,
			providerPage: providerPage.page,
			modelIndex: params.pendingModelIndex,
			userId: params.userId
		})
	}));
	return {
		rows,
		buttonRow: new Row(buttonRowItems)
	};
}
/**
* Source-of-truth data for Discord picker views. This intentionally reuses the
* same provider/model resolver used by text and Telegram model commands.
*/
async function loadDiscordModelPickerData(cfg, agentId) {
	return buildModelsProviderData(cfg, agentId);
}
function buildDiscordModelPickerCustomId(params) {
	const userId = params.userId.trim();
	if (!userId) throw new Error("Discord model picker custom_id requires userId");
	const page = normalizePage(params.page);
	const providerPage = typeof params.providerPage === "number" && Number.isFinite(params.providerPage) ? Math.max(1, Math.floor(params.providerPage)) : void 0;
	const normalizedProvider = params.provider ? normalizeProviderId(params.provider) : void 0;
	const modelIndex = typeof params.modelIndex === "number" && Number.isFinite(params.modelIndex) ? Math.max(1, Math.floor(params.modelIndex)) : void 0;
	const recentSlot = typeof params.recentSlot === "number" && Number.isFinite(params.recentSlot) ? Math.max(1, Math.floor(params.recentSlot)) : void 0;
	const parts = [
		`${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:c=${encodeCustomIdValue$1(params.command)}`,
		`a=${encodeCustomIdValue$1(params.action)}`,
		`v=${encodeCustomIdValue$1(params.view)}`,
		`u=${encodeCustomIdValue$1(userId)}`,
		`g=${String(page)}`
	];
	if (normalizedProvider) parts.push(`p=${encodeCustomIdValue$1(normalizedProvider)}`);
	if (providerPage) parts.push(`pp=${String(providerPage)}`);
	if (modelIndex) parts.push(`mi=${String(modelIndex)}`);
	if (recentSlot) parts.push(`rs=${String(recentSlot)}`);
	const customId = parts.join(";");
	if (customId.length > 100) throw new Error(`Discord model picker custom_id exceeds 100 chars (${customId.length})`);
	return customId;
}
function parseDiscordModelPickerData(data) {
	if (!data || typeof data !== "object") return null;
	const command = decodeCustomIdValue$1(coerceString(data.c ?? data.cmd));
	const action = decodeCustomIdValue$1(coerceString(data.a ?? data.act));
	const view = decodeCustomIdValue$1(coerceString(data.v ?? data.view));
	const userId = decodeCustomIdValue$1(coerceString(data.u));
	const providerRaw = decodeCustomIdValue$1(coerceString(data.p));
	const page = parseRawPage(data.g ?? data.pg);
	const providerPage = parseRawPositiveInt(data.pp);
	const modelIndex = parseRawPositiveInt(data.mi);
	const recentSlot = parseRawPositiveInt(data.rs);
	if (!isValidCommandContext(command) || !isValidPickerAction(action) || !isValidPickerView(view)) return null;
	const trimmedUserId = userId.trim();
	if (!trimmedUserId) return null;
	return {
		command,
		action,
		view,
		userId: trimmedUserId,
		provider: providerRaw ? normalizeProviderId(providerRaw) : void 0,
		page,
		...typeof providerPage === "number" ? { providerPage } : {},
		...typeof modelIndex === "number" ? { modelIndex } : {},
		...typeof recentSlot === "number" ? { recentSlot } : {}
	};
}
function buildDiscordModelPickerProviderItems(data) {
	return data.providers.map((provider) => ({
		id: provider,
		count: data.byProvider.get(provider)?.size ?? 0
	}));
}
function getDiscordModelPickerProviderPage(params) {
	const items = buildDiscordModelPickerProviderItems(params.data);
	const maxPageSize = items.length <= 25 ? 25 : 20;
	const pageSize = clampPageSize(params.pageSize, maxPageSize, maxPageSize);
	return paginateItems({
		items,
		page: normalizePage(params.page),
		pageSize
	});
}
function getDiscordModelPickerModelPage(params) {
	const provider = normalizeProviderId(params.provider);
	const modelSet = params.data.byProvider.get(provider);
	if (!modelSet) return null;
	const pageSize = clampPageSize(params.pageSize, 25, 25);
	return {
		...paginateItems({
			items: [...modelSet].toSorted(),
			page: normalizePage(params.page),
			pageSize
		}),
		provider
	};
}
function renderDiscordModelPickerProvidersView(params) {
	const page = getDiscordModelPickerProviderPage({
		data: params.data,
		page: params.page
	});
	const parsedCurrent = parseCurrentModelRef(params.currentModel);
	const rows = buildProviderRows({
		command: params.command,
		userId: params.userId,
		page,
		currentProvider: parsedCurrent?.provider
	});
	const detailLines = [formatCurrentModelLine(params.currentModel), `Select a provider (${page.totalItems} available).`];
	return buildRenderedShell({
		layout: params.layout ?? "v2",
		title: "Model Picker",
		detailLines,
		rows,
		footer: `All ${page.totalItems} providers shown`
	});
}
function renderDiscordModelPickerModelsView(params) {
	const providerPage = normalizePage(params.providerPage);
	const modelPage = getDiscordModelPickerModelPage({
		data: params.data,
		provider: params.provider,
		page: params.page
	});
	if (!modelPage) {
		const rows = [new Row([createModelPickerButton({
			label: "Back",
			customId: buildDiscordModelPickerCustomId({
				command: params.command,
				action: "back",
				view: "providers",
				page: providerPage,
				userId: params.userId
			})
		})])];
		return buildRenderedShell({
			layout: params.layout ?? "v2",
			title: "Model Picker",
			detailLines: [formatCurrentModelLine(params.currentModel), `Provider not found: ${normalizeProviderId(params.provider)}`],
			rows,
			footer: "Choose a different provider."
		});
	}
	const { rows, buttonRow } = buildModelRows({
		command: params.command,
		userId: params.userId,
		data: params.data,
		providerPage,
		modelPage,
		currentModel: params.currentModel,
		pendingModel: params.pendingModel,
		pendingModelIndex: params.pendingModelIndex,
		quickModels: params.quickModels
	});
	const defaultModel = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
	const pendingLine = params.pendingModel ? `Selected: ${params.pendingModel} (press Submit)` : "Select a model, then press Submit.";
	return buildRenderedShell({
		layout: params.layout ?? "v2",
		title: "Model Picker",
		detailLines: [formatCurrentModelLine(params.currentModel), `Default: ${defaultModel}`],
		preRowText: pendingLine,
		rows,
		trailingRows: [buttonRow]
	});
}
function formatRecentsButtonLabel(modelRef, suffix) {
	const maxLen = 80;
	const label = suffix ? `${modelRef} ${suffix}` : modelRef;
	if (label.length <= maxLen) return label;
	return suffix ? `${modelRef.slice(0, maxLen - suffix.length - 2)}… ${suffix}` : `${modelRef.slice(0, maxLen - 1)}…`;
}
function renderDiscordModelPickerRecentsView(params) {
	const defaultModelRef = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
	const rows = [];
	const dedupedQuickModels = params.quickModels.filter((modelRef) => modelRef !== defaultModelRef);
	rows.push(new Row([createModelPickerButton({
		label: formatRecentsButtonLabel(defaultModelRef, "(default)"),
		style: ButtonStyle.Secondary,
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "submit",
			view: "recents",
			recentSlot: 1,
			provider: params.provider,
			page: params.page,
			providerPage: params.providerPage,
			userId: params.userId
		})
	})]));
	for (let i = 0; i < dedupedQuickModels.length; i++) {
		const modelRef = dedupedQuickModels[i];
		rows.push(new Row([createModelPickerButton({
			label: formatRecentsButtonLabel(modelRef),
			style: ButtonStyle.Secondary,
			customId: buildDiscordModelPickerCustomId({
				command: params.command,
				action: "submit",
				view: "recents",
				recentSlot: i + 2,
				provider: params.provider,
				page: params.page,
				providerPage: params.providerPage,
				userId: params.userId
			})
		})]));
	}
	const backRow = new Row([createModelPickerButton({
		label: "Back",
		style: ButtonStyle.Secondary,
		customId: buildDiscordModelPickerCustomId({
			command: params.command,
			action: "back",
			view: "models",
			provider: params.provider,
			page: params.page,
			providerPage: params.providerPage,
			userId: params.userId
		})
	})]);
	return buildRenderedShell({
		layout: params.layout ?? "v2",
		title: "Recents",
		detailLines: ["Models you've previously selected appear here.", formatCurrentModelLine(params.currentModel)],
		preRowText: "Tap a model to switch.",
		rows,
		trailingRows: [backRow]
	});
}
function toDiscordModelPickerMessagePayload(view) {
	if (view.layout === "classic") return {
		content: view.content,
		components: view.components
	};
	return { components: view.components };
}
//#endregion
//#region extensions/discord/src/monitor/native-command-context.ts
function buildDiscordNativeCommandContext(params) {
	const conversationLabel = params.isDirectMessage ? params.user.globalName ?? params.user.username : params.channelId;
	const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
		channelConfig: params.channelConfig,
		guildInfo: params.guildInfo,
		sender: params.sender,
		allowNameMatching: params.allowNameMatching,
		isGuild: params.isGuild,
		channelTopic: params.channelTopic
	});
	return finalizeInboundContext({
		Body: params.prompt,
		BodyForAgent: params.prompt,
		RawBody: params.prompt,
		CommandBody: params.prompt,
		CommandArgs: params.commandArgs,
		From: params.isDirectMessage ? `discord:${params.user.id}` : params.isGroupDm ? `discord:group:${params.channelId}` : `discord:channel:${params.channelId}`,
		To: `slash:${params.user.id}`,
		SessionKey: params.sessionKey,
		CommandTargetSessionKey: params.commandTargetSessionKey,
		AccountId: params.accountId ?? void 0,
		ChatType: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
		ConversationLabel: conversationLabel,
		GroupSubject: params.isGuild ? params.guildName : void 0,
		GroupSystemPrompt: groupSystemPrompt,
		UntrustedContext: untrustedContext,
		OwnerAllowFrom: ownerAllowFrom,
		SenderName: params.user.globalName ?? params.user.username,
		SenderId: params.user.id,
		SenderUsername: params.user.username,
		SenderTag: params.sender.tag,
		Provider: "discord",
		Surface: "discord",
		WasMentioned: true,
		MessageSid: params.interactionId,
		MessageThreadId: params.isThreadChannel ? params.channelId : void 0,
		Timestamp: params.timestampMs ?? Date.now(),
		CommandAuthorized: params.commandAuthorized,
		CommandSource: "native",
		OriginatingChannel: "discord",
		OriginatingTo: params.isDirectMessage ? `user:${params.user.id}` : `channel:${params.channelId}`,
		ThreadParentId: params.isThreadChannel ? params.threadParentId : void 0
	});
}
//#endregion
//#region extensions/discord/src/monitor/native-command.ts
init_runtime_group_policy();
init_globals();
init_subsystem();
init_accounts();
init_allow_list();
const log = createSubsystemLogger("discord/native-command");
function resolveDiscordNativeCommandAllowlistAccess(params) {
	const commandsAllowFrom = params.cfg.commands?.allowFrom;
	if (!commandsAllowFrom || typeof commandsAllowFrom !== "object") return {
		configured: false,
		allowed: false
	};
	const rawAllowList = Array.isArray(commandsAllowFrom.discord) ? commandsAllowFrom.discord : commandsAllowFrom["*"];
	if (!Array.isArray(rawAllowList)) return {
		configured: false,
		allowed: false
	};
	const allowList = normalizeDiscordAllowList(rawAllowList.map(String), [
		"discord:",
		"user:",
		"pk:"
	]);
	if (!allowList) return {
		configured: true,
		allowed: false
	};
	return {
		configured: true,
		allowed: resolveDiscordAllowListMatch({
			allowList,
			candidate: params.sender,
			allowNameMatching: false
		}).allowed
	};
}
function buildDiscordCommandOptions(params) {
	const { command, cfg } = params;
	const args = command.args;
	if (!args || args.length === 0) return;
	return args.map((arg) => {
		const required = arg.required ?? false;
		if (arg.type === "number") return {
			name: arg.name,
			description: arg.description,
			type: ApplicationCommandOptionType.Number,
			required
		};
		if (arg.type === "boolean") return {
			name: arg.name,
			description: arg.description,
			type: ApplicationCommandOptionType.Boolean,
			required
		};
		const resolvedChoices = resolveCommandArgChoices({
			command,
			arg,
			cfg
		});
		const autocomplete = arg.preferAutocomplete === true || resolvedChoices.length > 0 && (typeof arg.choices === "function" || resolvedChoices.length > 25) ? async (interaction) => {
			const focused = interaction.options.getFocused();
			const focusValue = typeof focused?.value === "string" ? focused.value.trim().toLowerCase() : "";
			const choices = resolveCommandArgChoices({
				command,
				arg,
				cfg
			});
			const filtered = focusValue ? choices.filter((choice) => choice.label.toLowerCase().includes(focusValue)) : choices;
			await interaction.respond(filtered.slice(0, 25).map((choice) => ({
				name: choice.label,
				value: choice.value
			})));
		} : void 0;
		const choices = resolvedChoices.length > 0 && !autocomplete ? resolvedChoices.slice(0, 25).map((choice) => ({
			name: choice.label,
			value: choice.value
		})) : void 0;
		return {
			name: arg.name,
			description: arg.description,
			type: ApplicationCommandOptionType.String,
			required,
			choices,
			autocomplete
		};
	});
}
function readDiscordCommandArgs(interaction, definitions) {
	if (!definitions || definitions.length === 0) return;
	const values = {};
	for (const definition of definitions) {
		let value;
		if (definition.type === "number") value = interaction.options.getNumber(definition.name) ?? null;
		else if (definition.type === "boolean") value = interaction.options.getBoolean(definition.name) ?? null;
		else value = interaction.options.getString(definition.name) ?? null;
		if (value != null) values[definition.name] = value;
	}
	return Object.keys(values).length > 0 ? { values } : void 0;
}
const DISCORD_COMMAND_ARG_CUSTOM_ID_KEY = "cmdarg";
function createCommandArgsWithValue(params) {
	return { values: { [params.argName]: params.value } };
}
function encodeDiscordCommandArgValue(value) {
	return encodeURIComponent(value);
}
function decodeDiscordCommandArgValue(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
function isDiscordUnknownInteraction(error) {
	if (!error || typeof error !== "object") return false;
	const err = error;
	if (err.discordCode === 10062 || err.rawBody?.code === 10062) return true;
	if (err.status === 404 && /Unknown interaction/i.test(err.message ?? "")) return true;
	if (/Unknown interaction/i.test(err.rawBody?.message ?? "")) return true;
	return false;
}
function hasRenderableReplyPayload(payload) {
	if ((payload.text ?? "").trim()) return true;
	if ((payload.mediaUrl ?? "").trim()) return true;
	if (payload.mediaUrls?.some((entry) => entry.trim())) return true;
	const discordData = payload.channelData?.discord;
	if (Array.isArray(discordData?.components) && discordData.components.length > 0) return true;
	return false;
}
async function safeDiscordInteractionCall(label, fn) {
	try {
		return await fn();
	} catch (error) {
		if (isDiscordUnknownInteraction(error)) {
			logVerbose(`discord: ${label} skipped (interaction expired)`);
			return null;
		}
		throw error;
	}
}
function buildDiscordCommandArgCustomId(params) {
	return [
		`${DISCORD_COMMAND_ARG_CUSTOM_ID_KEY}:command=${encodeDiscordCommandArgValue(params.command)}`,
		`arg=${encodeDiscordCommandArgValue(params.arg)}`,
		`value=${encodeDiscordCommandArgValue(params.value)}`,
		`user=${encodeDiscordCommandArgValue(params.userId)}`
	].join(";");
}
function parseDiscordCommandArgData(data) {
	if (!data || typeof data !== "object") return null;
	const coerce = (value) => typeof value === "string" || typeof value === "number" ? String(value) : "";
	const rawCommand = coerce(data.command);
	const rawArg = coerce(data.arg);
	const rawValue = coerce(data.value);
	const rawUser = coerce(data.user);
	if (!rawCommand || !rawArg || !rawValue || !rawUser) return null;
	return {
		command: decodeDiscordCommandArgValue(rawCommand),
		arg: decodeDiscordCommandArgValue(rawArg),
		value: decodeDiscordCommandArgValue(rawValue),
		userId: decodeDiscordCommandArgValue(rawUser)
	};
}
function resolveDiscordModelPickerCommandContext(command) {
	const normalized = (command.nativeName ?? command.key).trim().toLowerCase();
	if (normalized === "model" || normalized === "models") return normalized;
	return null;
}
function resolveCommandArgStringValue(args, key) {
	const value = args?.values?.[key];
	if (typeof value !== "string") return "";
	return value.trim();
}
function shouldOpenDiscordModelPickerFromCommand(params) {
	const context = resolveDiscordModelPickerCommandContext(params.command);
	if (!context) return null;
	const serializedArgs = serializeCommandArgs(params.command, params.commandArgs)?.trim() ?? "";
	if (context === "model") return !resolveCommandArgStringValue(params.commandArgs, "model") && !serializedArgs ? context : null;
	return serializedArgs ? null : context;
}
function buildDiscordModelPickerCurrentModel(defaultProvider, defaultModel) {
	return `${defaultProvider}/${defaultModel}`;
}
function buildDiscordModelPickerAllowedModelRefs(data) {
	const out = /* @__PURE__ */ new Set();
	for (const provider of data.providers) {
		const models = data.byProvider.get(provider);
		if (!models) continue;
		for (const model of models) out.add(`${provider}/${model}`);
	}
	return out;
}
function resolveDiscordModelPickerPreferenceScope(params) {
	return {
		accountId: params.accountId,
		guildId: params.interaction.guild?.id ?? void 0,
		userId: params.userId
	};
}
function buildDiscordModelPickerNoticePayload(message) {
	return { components: [new Container([new TextDisplay(message)])] };
}
async function resolveDiscordModelPickerRoute(params) {
	const { interaction, cfg, accountId } = params;
	const channel = interaction.channel;
	const channelType = channel?.type;
	const isDirectMessage = channelType === ChannelType$1.DM;
	const isGroupDm = channelType === ChannelType$1.GroupDM;
	const isThreadChannel = channelType === ChannelType$1.PublicThread || channelType === ChannelType$1.PrivateThread || channelType === ChannelType$1.AnnouncementThread;
	const rawChannelId = channel?.id ?? "unknown";
	const memberRoleIds = Array.isArray(interaction.rawData.member?.roles) ? interaction.rawData.member.roles.map((roleId) => String(roleId)) : [];
	let threadParentId;
	if (interaction.guild && channel && isThreadChannel && rawChannelId) {
		const channelInfo = await resolveDiscordChannelInfo(interaction.client, rawChannelId);
		threadParentId = (await resolveDiscordThreadParentInfo({
			client: interaction.client,
			threadChannel: {
				id: rawChannelId,
				name: "name" in channel ? channel.name : void 0,
				parentId: "parentId" in channel ? channel.parentId ?? void 0 : void 0,
				parent: void 0
			},
			channelInfo
		})).id;
	}
	const threadBinding = isThreadChannel ? params.threadBindings.getByThreadId(rawChannelId) : void 0;
	return resolveDiscordBoundConversationRoute({
		cfg,
		accountId,
		guildId: interaction.guild?.id ?? void 0,
		memberRoleIds,
		isDirectMessage,
		isGroupDm,
		directUserId: interaction.user?.id ?? rawChannelId,
		conversationId: rawChannelId,
		parentConversationId: threadParentId,
		boundSessionKey: threadBinding?.targetSessionKey
	});
}
function resolveDiscordModelPickerCurrentModel(params) {
	const fallback = buildDiscordModelPickerCurrentModel(params.data.resolvedDefault.provider, params.data.resolvedDefault.model);
	try {
		const sessionStore = loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId: params.route.agentId }), { skipCache: true });
		const sessionEntry = sessionStore[params.route.sessionKey];
		const override = resolveStoredModelOverride({
			sessionEntry,
			sessionStore,
			sessionKey: params.route.sessionKey
		});
		if (!override?.model) return fallback;
		const provider = (override.provider || params.data.resolvedDefault.provider).trim();
		if (!provider) return fallback;
		return `${provider}/${override.model}`;
	} catch {
		return fallback;
	}
}
async function replyWithDiscordModelPickerProviders(params) {
	const route = await resolveDiscordModelPickerRoute({
		interaction: params.interaction,
		cfg: params.cfg,
		accountId: params.accountId,
		threadBindings: params.threadBindings
	});
	const data = await loadDiscordModelPickerData(params.cfg, route.agentId);
	const currentModel = resolveDiscordModelPickerCurrentModel({
		cfg: params.cfg,
		route,
		data
	});
	const quickModels = await readDiscordModelPickerRecentModels({
		scope: resolveDiscordModelPickerPreferenceScope({
			interaction: params.interaction,
			accountId: params.accountId,
			userId: params.userId
		}),
		allowedModelRefs: buildDiscordModelPickerAllowedModelRefs(data),
		limit: 5
	});
	const payload = {
		...toDiscordModelPickerMessagePayload(renderDiscordModelPickerModelsView({
			command: params.command,
			userId: params.userId,
			data,
			provider: splitDiscordModelRef(currentModel ?? "")?.provider ?? data.resolvedDefault.provider,
			page: 1,
			providerPage: 1,
			currentModel,
			quickModels
		})),
		ephemeral: true
	};
	await safeDiscordInteractionCall("model picker reply", async () => {
		if (params.preferFollowUp) {
			await params.interaction.followUp(payload);
			return;
		}
		await params.interaction.reply(payload);
	});
}
function resolveModelPickerSelectionValue(interaction) {
	const rawValues = interaction.values;
	if (!Array.isArray(rawValues) || rawValues.length === 0) return null;
	const first = rawValues[0];
	if (typeof first !== "string") return null;
	return first.trim() || null;
}
function buildDiscordModelPickerSelectionCommand(params) {
	const commandDefinition = findCommandByNativeName("model", "discord") ?? listChatCommands().find((entry) => entry.key === "model");
	if (!commandDefinition) return null;
	const commandArgs = {
		values: { model: params.modelRef },
		raw: params.modelRef
	};
	return {
		command: commandDefinition,
		args: commandArgs,
		prompt: buildCommandTextFromArgs(commandDefinition, commandArgs)
	};
}
function listDiscordModelPickerProviderModels(data, provider) {
	const modelSet = data.byProvider.get(provider);
	if (!modelSet) return [];
	return [...modelSet].toSorted();
}
function resolveDiscordModelPickerModelIndex(params) {
	const models = listDiscordModelPickerProviderModels(params.data, params.provider);
	if (!models.length) return null;
	const index = models.indexOf(params.model);
	if (index < 0) return null;
	return index + 1;
}
function resolveDiscordModelPickerModelByIndex(params) {
	if (!params.modelIndex || params.modelIndex < 1) return null;
	const models = listDiscordModelPickerProviderModels(params.data, params.provider);
	if (!models.length) return null;
	return models[params.modelIndex - 1] ?? null;
}
function splitDiscordModelRef(modelRef) {
	const trimmed = modelRef.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) return null;
	const provider = trimmed.slice(0, slashIndex).trim();
	const model = trimmed.slice(slashIndex + 1).trim();
	if (!provider || !model) return null;
	return {
		provider,
		model
	};
}
async function handleDiscordModelPickerInteraction(interaction, data, ctx) {
	const parsed = parseDiscordModelPickerData(data);
	if (!parsed) {
		await safeDiscordInteractionCall("model picker update", () => interaction.update(buildDiscordModelPickerNoticePayload("Sorry, that model picker interaction is no longer available.")));
		return;
	}
	if (interaction.user?.id && interaction.user.id !== parsed.userId) {
		await safeDiscordInteractionCall("model picker ack", () => interaction.acknowledge());
		return;
	}
	const route = await resolveDiscordModelPickerRoute({
		interaction,
		cfg: ctx.cfg,
		accountId: ctx.accountId,
		threadBindings: ctx.threadBindings
	});
	const pickerData = await loadDiscordModelPickerData(ctx.cfg, route.agentId);
	const currentModelRef = resolveDiscordModelPickerCurrentModel({
		cfg: ctx.cfg,
		route,
		data: pickerData
	});
	const allowedModelRefs = buildDiscordModelPickerAllowedModelRefs(pickerData);
	const preferenceScope = resolveDiscordModelPickerPreferenceScope({
		interaction,
		accountId: ctx.accountId,
		userId: parsed.userId
	});
	const quickModels = await readDiscordModelPickerRecentModels({
		scope: preferenceScope,
		allowedModelRefs,
		limit: 5
	});
	if (parsed.action === "recents") {
		const rendered = renderDiscordModelPickerRecentsView({
			command: parsed.command,
			userId: parsed.userId,
			data: pickerData,
			quickModels,
			currentModel: currentModelRef,
			provider: parsed.provider,
			page: parsed.page,
			providerPage: parsed.providerPage
		});
		await safeDiscordInteractionCall("model picker update", () => interaction.update(toDiscordModelPickerMessagePayload(rendered)));
		return;
	}
	if (parsed.action === "back" && parsed.view === "providers") {
		const rendered = renderDiscordModelPickerProvidersView({
			command: parsed.command,
			userId: parsed.userId,
			data: pickerData,
			page: parsed.page,
			currentModel: currentModelRef
		});
		await safeDiscordInteractionCall("model picker update", () => interaction.update(toDiscordModelPickerMessagePayload(rendered)));
		return;
	}
	if (parsed.action === "back" && parsed.view === "models") {
		const provider = parsed.provider ?? splitDiscordModelRef(currentModelRef ?? "")?.provider ?? pickerData.resolvedDefault.provider;
		const rendered = renderDiscordModelPickerModelsView({
			command: parsed.command,
			userId: parsed.userId,
			data: pickerData,
			provider,
			page: parsed.page ?? 1,
			providerPage: parsed.providerPage ?? 1,
			currentModel: currentModelRef,
			quickModels
		});
		await safeDiscordInteractionCall("model picker update", () => interaction.update(toDiscordModelPickerMessagePayload(rendered)));
		return;
	}
	if (parsed.action === "provider") {
		const selectedProvider = resolveModelPickerSelectionValue(interaction) ?? parsed.provider;
		if (!selectedProvider || !pickerData.byProvider.has(selectedProvider)) {
			await safeDiscordInteractionCall("model picker update", () => interaction.update(buildDiscordModelPickerNoticePayload("Sorry, that provider isn't available anymore.")));
			return;
		}
		const rendered = renderDiscordModelPickerModelsView({
			command: parsed.command,
			userId: parsed.userId,
			data: pickerData,
			provider: selectedProvider,
			page: 1,
			providerPage: parsed.providerPage ?? parsed.page,
			currentModel: currentModelRef,
			quickModels
		});
		await safeDiscordInteractionCall("model picker update", () => interaction.update(toDiscordModelPickerMessagePayload(rendered)));
		return;
	}
	if (parsed.action === "model") {
		const selectedModel = resolveModelPickerSelectionValue(interaction);
		const provider = parsed.provider;
		if (!provider || !selectedModel) {
			await safeDiscordInteractionCall("model picker update", () => interaction.update(buildDiscordModelPickerNoticePayload("Sorry, I couldn't read that model selection.")));
			return;
		}
		const modelIndex = resolveDiscordModelPickerModelIndex({
			data: pickerData,
			provider,
			model: selectedModel
		});
		if (!modelIndex) {
			await safeDiscordInteractionCall("model picker update", () => interaction.update(buildDiscordModelPickerNoticePayload("Sorry, that model isn't available anymore.")));
			return;
		}
		const modelRef = `${provider}/${selectedModel}`;
		const rendered = renderDiscordModelPickerModelsView({
			command: parsed.command,
			userId: parsed.userId,
			data: pickerData,
			provider,
			page: parsed.page,
			providerPage: parsed.providerPage ?? 1,
			currentModel: currentModelRef,
			pendingModel: modelRef,
			pendingModelIndex: modelIndex,
			quickModels
		});
		await safeDiscordInteractionCall("model picker update", () => interaction.update(toDiscordModelPickerMessagePayload(rendered)));
		return;
	}
	if (parsed.action === "submit" || parsed.action === "reset" || parsed.action === "quick") {
		let modelRef = null;
		if (parsed.action === "reset") modelRef = `${pickerData.resolvedDefault.provider}/${pickerData.resolvedDefault.model}`;
		else if (parsed.action === "quick") {
			const slot = parsed.recentSlot ?? 0;
			modelRef = slot >= 1 ? quickModels[slot - 1] ?? null : null;
		} else if (parsed.view === "recents") {
			const defaultModelRef = `${pickerData.resolvedDefault.provider}/${pickerData.resolvedDefault.model}`;
			const dedupedRecents = quickModels.filter((ref) => ref !== defaultModelRef);
			const slot = parsed.recentSlot ?? 0;
			if (slot === 1) modelRef = defaultModelRef;
			else if (slot >= 2) modelRef = dedupedRecents[slot - 2] ?? null;
		} else {
			const provider = parsed.provider;
			const selectedModel = resolveDiscordModelPickerModelByIndex({
				data: pickerData,
				provider: provider ?? "",
				modelIndex: parsed.modelIndex
			});
			modelRef = provider && selectedModel ? `${provider}/${selectedModel}` : null;
		}
		const parsedModelRef = modelRef ? splitDiscordModelRef(modelRef) : null;
		if (!parsedModelRef || !pickerData.byProvider.get(parsedModelRef.provider)?.has(parsedModelRef.model)) {
			await safeDiscordInteractionCall("model picker update", () => interaction.update(buildDiscordModelPickerNoticePayload("That selection expired. Please choose a model again.")));
			return;
		}
		const resolvedModelRef = `${parsedModelRef.provider}/${parsedModelRef.model}`;
		const selectionCommand = buildDiscordModelPickerSelectionCommand({ modelRef: resolvedModelRef });
		if (!selectionCommand) {
			await safeDiscordInteractionCall("model picker update", () => interaction.update(buildDiscordModelPickerNoticePayload("Sorry, /model is unavailable right now.")));
			return;
		}
		if (await safeDiscordInteractionCall("model picker update", () => interaction.update(buildDiscordModelPickerNoticePayload(`Applying model change to ${resolvedModelRef}...`))) === null) return;
		try {
			await withTimeout(dispatchDiscordCommandInteraction({
				interaction,
				prompt: selectionCommand.prompt,
				command: selectionCommand.command,
				commandArgs: selectionCommand.args,
				cfg: ctx.cfg,
				discordConfig: ctx.discordConfig,
				accountId: ctx.accountId,
				sessionPrefix: ctx.sessionPrefix,
				preferFollowUp: true,
				threadBindings: ctx.threadBindings,
				suppressReplies: true
			}), 12e3);
		} catch (error) {
			if (error instanceof Error && error.message === "timeout") {
				await safeDiscordInteractionCall("model picker follow-up", () => interaction.followUp({
					...buildDiscordModelPickerNoticePayload(`⏳ Model change to ${resolvedModelRef} is still processing. Check /status in a few seconds.`),
					ephemeral: true
				}));
				return;
			}
			await safeDiscordInteractionCall("model picker follow-up", () => interaction.followUp({
				...buildDiscordModelPickerNoticePayload(`❌ Failed to apply ${resolvedModelRef}. Try /model ${resolvedModelRef} directly.`),
				ephemeral: true
			}));
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		const effectiveModelRef = resolveDiscordModelPickerCurrentModel({
			cfg: ctx.cfg,
			route,
			data: pickerData
		});
		const persisted = effectiveModelRef === resolvedModelRef;
		if (!persisted) logVerbose(`discord: model picker override mismatch — expected ${resolvedModelRef} but read ${effectiveModelRef} from session key ${route.sessionKey}`);
		if (persisted) await recordDiscordModelPickerRecentModel({
			scope: preferenceScope,
			modelRef: resolvedModelRef,
			limit: 5
		}).catch(() => void 0);
		await safeDiscordInteractionCall("model picker follow-up", () => interaction.followUp({
			...buildDiscordModelPickerNoticePayload(persisted ? `✅ Model set to ${resolvedModelRef}.` : `⚠️ Tried to set ${resolvedModelRef}, but current model is ${effectiveModelRef}.`),
			ephemeral: true
		}));
		return;
	}
	if (parsed.action === "cancel") {
		const displayModel = currentModelRef ?? "default";
		await safeDiscordInteractionCall("model picker update", () => interaction.update(buildDiscordModelPickerNoticePayload(`ℹ️ Model kept as ${displayModel}.`)));
		return;
	}
}
async function handleDiscordCommandArgInteraction(interaction, data, ctx) {
	const parsed = parseDiscordCommandArgData(data);
	if (!parsed) {
		await safeDiscordInteractionCall("command arg update", () => interaction.update({
			content: "Sorry, that selection is no longer available.",
			components: []
		}));
		return;
	}
	if (interaction.user?.id && interaction.user.id !== parsed.userId) {
		await safeDiscordInteractionCall("command arg ack", () => interaction.acknowledge());
		return;
	}
	const commandDefinition = findCommandByNativeName(parsed.command, "discord") ?? listChatCommands().find((entry) => entry.key === parsed.command);
	if (!commandDefinition) {
		await safeDiscordInteractionCall("command arg update", () => interaction.update({
			content: "Sorry, that command is no longer available.",
			components: []
		}));
		return;
	}
	if (await safeDiscordInteractionCall("command arg update", () => interaction.update({
		content: `✅ Selected ${parsed.value}.`,
		components: []
	})) === null) return;
	const commandArgs = createCommandArgsWithValue({
		argName: parsed.arg,
		value: parsed.value
	});
	const commandArgsWithRaw = {
		...commandArgs,
		raw: serializeCommandArgs(commandDefinition, commandArgs)
	};
	await dispatchDiscordCommandInteraction({
		interaction,
		prompt: buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw),
		command: commandDefinition,
		commandArgs: commandArgsWithRaw,
		cfg: ctx.cfg,
		discordConfig: ctx.discordConfig,
		accountId: ctx.accountId,
		sessionPrefix: ctx.sessionPrefix,
		preferFollowUp: true,
		threadBindings: ctx.threadBindings
	});
}
var DiscordCommandArgButton = class extends Button {
	constructor(params) {
		super();
		this.style = ButtonStyle.Secondary;
		this.label = params.label;
		this.customId = params.customId;
		this.cfg = params.cfg;
		this.discordConfig = params.discordConfig;
		this.accountId = params.accountId;
		this.sessionPrefix = params.sessionPrefix;
		this.threadBindings = params.threadBindings;
	}
	async run(interaction, data) {
		await handleDiscordCommandArgInteraction(interaction, data, {
			cfg: this.cfg,
			discordConfig: this.discordConfig,
			accountId: this.accountId,
			sessionPrefix: this.sessionPrefix,
			threadBindings: this.threadBindings
		});
	}
};
var DiscordCommandArgFallbackButton = class extends Button {
	constructor(ctx) {
		super();
		this.label = "cmdarg";
		this.customId = "cmdarg:seed=1";
		this.ctx = ctx;
	}
	async run(interaction, data) {
		await handleDiscordCommandArgInteraction(interaction, data, this.ctx);
	}
};
function createDiscordCommandArgFallbackButton(params) {
	return new DiscordCommandArgFallbackButton(params);
}
var DiscordModelPickerFallbackButton = class extends Button {
	constructor(ctx) {
		super();
		this.label = DISCORD_MODEL_PICKER_CUSTOM_ID_KEY;
		this.customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=btn`;
		this.ctx = ctx;
	}
	async run(interaction, data) {
		await handleDiscordModelPickerInteraction(interaction, data, this.ctx);
	}
};
var DiscordModelPickerFallbackSelect = class extends StringSelectMenu {
	constructor(ctx) {
		super();
		this.customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=sel`;
		this.options = [];
		this.ctx = ctx;
	}
	async run(interaction, data) {
		await handleDiscordModelPickerInteraction(interaction, data, this.ctx);
	}
};
function createDiscordModelPickerFallbackButton(params) {
	return new DiscordModelPickerFallbackButton(params);
}
function createDiscordModelPickerFallbackSelect(params) {
	return new DiscordModelPickerFallbackSelect(params);
}
function buildDiscordCommandArgMenu(params) {
	const { command, menu, interaction } = params;
	const commandLabel = command.nativeName ?? command.key;
	const userId = interaction.user?.id ?? "";
	const rows = chunkItems(menu.choices, 4).map((choices) => {
		return new Row(choices.map((choice) => new DiscordCommandArgButton({
			label: choice.label,
			customId: buildDiscordCommandArgCustomId({
				command: commandLabel,
				arg: menu.arg.name,
				value: choice.value,
				userId
			}),
			cfg: params.cfg,
			discordConfig: params.discordConfig,
			accountId: params.accountId,
			sessionPrefix: params.sessionPrefix,
			threadBindings: params.threadBindings
		})));
	});
	return {
		content: menu.title ?? `Choose ${menu.arg.description || menu.arg.name} for /${commandLabel}.`,
		components: rows
	};
}
function createDiscordNativeCommand(params) {
	const { command, cfg, discordConfig, accountId, sessionPrefix, ephemeralDefault, threadBindings } = params;
	const commandDefinition = findCommandByNativeName(command.name, "discord") ?? {
		key: command.name,
		nativeName: command.name,
		description: command.description,
		textAliases: [],
		acceptsArgs: command.acceptsArgs,
		args: command.args,
		argsParsing: "none",
		scope: "native"
	};
	const argDefinitions = commandDefinition.args ?? command.args;
	const commandOptions = buildDiscordCommandOptions({
		command: commandDefinition,
		cfg
	});
	const options = commandOptions ? commandOptions : command.acceptsArgs ? [{
		name: "input",
		description: "Command input",
		type: ApplicationCommandOptionType.String,
		required: false
	}] : void 0;
	return new class extends Command {
		constructor(..._args) {
			super(..._args);
			this.name = command.name;
			this.description = command.description;
			this.defer = true;
			this.ephemeral = ephemeralDefault;
			this.options = options;
		}
		async run(interaction) {
			const commandArgs = argDefinitions?.length ? readDiscordCommandArgs(interaction, argDefinitions) : command.acceptsArgs ? parseCommandArgs(commandDefinition, interaction.options.getString("input") ?? "") : void 0;
			const commandArgsWithRaw = commandArgs ? {
				...commandArgs,
				raw: serializeCommandArgs(commandDefinition, commandArgs) ?? commandArgs.raw
			} : void 0;
			await dispatchDiscordCommandInteraction({
				interaction,
				prompt: buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw),
				command: commandDefinition,
				commandArgs: commandArgsWithRaw,
				cfg,
				discordConfig,
				accountId,
				sessionPrefix,
				preferFollowUp: false,
				threadBindings
			});
		}
	}();
}
async function dispatchDiscordCommandInteraction(params) {
	const { interaction, prompt, command, commandArgs, cfg, discordConfig, accountId, sessionPrefix, preferFollowUp, threadBindings, suppressReplies } = params;
	const respond = async (content, options) => {
		const payload = {
			content,
			...options?.ephemeral !== void 0 ? { ephemeral: options.ephemeral } : {}
		};
		await safeDiscordInteractionCall("interaction reply", async () => {
			if (preferFollowUp) {
				await interaction.followUp(payload);
				return;
			}
			await interaction.reply(payload);
		});
	};
	const useAccessGroups = cfg.commands?.useAccessGroups !== false;
	const user = interaction.user;
	if (!user) return;
	const sender = resolveDiscordSenderIdentity({
		author: user,
		pluralkitInfo: null
	});
	const channel = interaction.channel;
	const channelType = channel?.type;
	const isDirectMessage = channelType === ChannelType$1.DM;
	const isGroupDm = channelType === ChannelType$1.GroupDM;
	const isThreadChannel = channelType === ChannelType$1.PublicThread || channelType === ChannelType$1.PrivateThread || channelType === ChannelType$1.AnnouncementThread;
	const channelName = channel && "name" in channel ? channel.name : void 0;
	const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
	const rawChannelId = channel?.id ?? "";
	const memberRoleIds = Array.isArray(interaction.rawData.member?.roles) ? interaction.rawData.member.roles.map((roleId) => String(roleId)) : [];
	const allowNameMatching = isDangerousNameMatchingEnabled(discordConfig);
	const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
		allowFrom: discordConfig?.allowFrom ?? discordConfig?.dm?.allowFrom ?? [],
		sender: {
			id: sender.id,
			name: sender.name,
			tag: sender.tag
		},
		allowNameMatching
	});
	const commandsAllowFromAccess = resolveDiscordNativeCommandAllowlistAccess({
		cfg,
		accountId,
		sender: {
			id: sender.id,
			name: sender.name,
			tag: sender.tag
		},
		chatType: isDirectMessage ? "direct" : isThreadChannel ? "thread" : interaction.guild ? "channel" : "group",
		conversationId: rawChannelId || void 0
	});
	const guildInfo = resolveDiscordGuildEntry({
		guild: interaction.guild ?? void 0,
		guildId: interaction.guild?.id ?? void 0,
		guildEntries: discordConfig?.guilds
	});
	let threadParentId;
	let threadParentName;
	let threadParentSlug = "";
	if (interaction.guild && channel && isThreadChannel && rawChannelId) {
		const channelInfo = await resolveDiscordChannelInfo(interaction.client, rawChannelId);
		const parentInfo = await resolveDiscordThreadParentInfo({
			client: interaction.client,
			threadChannel: {
				id: rawChannelId,
				name: channelName,
				parentId: "parentId" in channel ? channel.parentId ?? void 0 : void 0,
				parent: void 0
			},
			channelInfo
		});
		threadParentId = parentInfo.id;
		threadParentName = parentInfo.name;
		threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";
	}
	const channelConfig = interaction.guild ? resolveDiscordChannelConfigWithFallback({
		guildInfo,
		channelId: rawChannelId,
		channelName,
		channelSlug,
		parentId: threadParentId,
		parentName: threadParentName,
		parentSlug: threadParentSlug,
		scope: isThreadChannel ? "thread" : "channel"
	}) : null;
	if (channelConfig?.enabled === false) {
		await respond("This channel is disabled.");
		return;
	}
	if (interaction.guild && channelConfig?.allowed === false) {
		await respond("This channel is not allowed.");
		return;
	}
	if (useAccessGroups && interaction.guild) {
		const channelAllowlistConfigured = Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
		const channelAllowed = channelConfig?.allowed !== false;
		const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
			providerConfigPresent: cfg.channels?.discord !== void 0,
			groupPolicy: discordConfig?.groupPolicy,
			defaultGroupPolicy: cfg.channels?.defaults?.groupPolicy
		});
		if (!isDiscordGroupAllowedByPolicy({
			groupPolicy,
			guildAllowlisted: Boolean(guildInfo),
			channelAllowlistConfigured,
			channelAllowed
		})) {
			await respond("This channel is not allowed.");
			return;
		}
	}
	const dmEnabled = discordConfig?.dm?.enabled ?? true;
	const dmPolicy = discordConfig?.dmPolicy ?? discordConfig?.dm?.policy ?? "pairing";
	let commandAuthorized = true;
	if (isDirectMessage) {
		if (!dmEnabled || dmPolicy === "disabled") {
			await respond("Discord DMs are disabled.");
			return;
		}
		const dmAccess = await resolveDiscordDmCommandAccess({
			accountId,
			dmPolicy,
			configuredAllowFrom: discordConfig?.allowFrom ?? discordConfig?.dm?.allowFrom ?? [],
			sender: {
				id: sender.id,
				name: sender.name,
				tag: sender.tag
			},
			allowNameMatching,
			useAccessGroups
		});
		commandAuthorized = dmAccess.commandAuthorized;
		if (dmAccess.decision !== "allow") {
			await handleDiscordDmCommandDecision({
				dmAccess,
				accountId,
				sender: {
					id: user.id,
					tag: sender.tag,
					name: sender.name
				},
				onPairingCreated: async (code) => {
					await respond(buildPairingReply({
						channel: "discord",
						idLine: `Your Discord user id: ${user.id}`,
						code
					}), { ephemeral: true });
				},
				onUnauthorized: async () => {
					await respond("You are not authorized to use this command.", { ephemeral: true });
				}
			});
			return;
		}
	}
	if (!isDirectMessage) {
		const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
			channelConfig,
			guildInfo,
			memberRoleIds,
			sender,
			allowNameMatching
		});
		commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
			useAccessGroups,
			authorizers: useAccessGroups ? [
				{
					configured: commandsAllowFromAccess.configured,
					allowed: commandsAllowFromAccess.allowed
				},
				{
					configured: ownerAllowList != null,
					allowed: ownerOk
				},
				{
					configured: hasAccessRestrictions,
					allowed: memberAllowed
				}
			] : [{
				configured: commandsAllowFromAccess.configured,
				allowed: commandsAllowFromAccess.allowed
			}, {
				configured: hasAccessRestrictions,
				allowed: memberAllowed
			}],
			modeWhenAccessGroupsOff: "configured"
		});
		if (!commandAuthorized) {
			await respond("You are not authorized to use this command.", { ephemeral: true });
			return;
		}
	}
	if (isGroupDm && discordConfig?.dm?.groupEnabled === false) {
		await respond("Discord group DMs are disabled.");
		return;
	}
	const menu = resolveCommandArgMenu({
		command,
		args: commandArgs,
		cfg
	});
	if (menu) {
		const menuPayload = buildDiscordCommandArgMenu({
			command,
			menu,
			interaction,
			cfg,
			discordConfig,
			accountId,
			sessionPrefix,
			threadBindings
		});
		if (preferFollowUp) {
			await safeDiscordInteractionCall("interaction follow-up", () => interaction.followUp({
				content: menuPayload.content,
				components: menuPayload.components,
				ephemeral: true
			}));
			return;
		}
		await safeDiscordInteractionCall("interaction reply", () => interaction.reply({
			content: menuPayload.content,
			components: menuPayload.components,
			ephemeral: true
		}));
		return;
	}
	const pluginMatch = matchPluginCommand(prompt);
	if (pluginMatch) {
		if (suppressReplies) return;
		const channelId = rawChannelId || "unknown";
		const pluginReply = await executePluginCommand({
			command: pluginMatch.command,
			args: pluginMatch.args,
			senderId: sender.id,
			channel: "discord",
			channelId,
			isAuthorizedSender: commandAuthorized,
			commandBody: prompt,
			config: cfg,
			from: isDirectMessage ? `discord:${user.id}` : isGroupDm ? `discord:group:${channelId}` : `discord:channel:${channelId}`,
			to: `slash:${user.id}`,
			accountId
		});
		if (!hasRenderableReplyPayload(pluginReply)) {
			await respond("Done.");
			return;
		}
		await deliverDiscordInteractionReply({
			interaction,
			payload: pluginReply,
			textLimit: resolveTextChunkLimit(cfg, "discord", accountId, { fallbackLimit: 2e3 }),
			maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
				cfg,
				discordConfig,
				accountId
			}),
			preferFollowUp,
			chunkMode: resolveChunkMode(cfg, "discord", accountId)
		});
		return;
	}
	const pickerCommandContext = shouldOpenDiscordModelPickerFromCommand({
		command,
		commandArgs
	});
	if (pickerCommandContext) {
		await replyWithDiscordModelPickerProviders({
			interaction,
			cfg,
			command: pickerCommandContext,
			userId: user.id,
			accountId,
			threadBindings,
			preferFollowUp
		});
		return;
	}
	const isGuild = Boolean(interaction.guild);
	const channelId = rawChannelId || "unknown";
	const interactionId = interaction.rawData.id;
	const route = resolveDiscordBoundConversationRoute({
		cfg,
		accountId,
		guildId: interaction.guild?.id ?? void 0,
		memberRoleIds,
		isDirectMessage,
		isGroupDm,
		directUserId: user.id,
		conversationId: channelId,
		parentConversationId: threadParentId
	});
	const threadBinding = isThreadChannel ? threadBindings.getByThreadId(rawChannelId) : void 0;
	const configuredRoute = threadBinding == null ? resolveConfiguredAcpRoute({
		cfg,
		route,
		channel: "discord",
		accountId,
		conversationId: channelId,
		parentConversationId: threadParentId
	}) : null;
	const configuredBinding = configuredRoute?.configuredBinding ?? null;
	if (configuredBinding) {
		const ensured = await ensureConfiguredAcpRouteReady({
			cfg,
			configuredBinding
		});
		if (!ensured.ok) {
			logVerbose(`discord native command: configured ACP binding unavailable for channel ${configuredBinding.spec.conversationId}: ${ensured.error}`);
			await respond("Configured ACP binding is unavailable right now. Please try again.");
			return;
		}
	}
	const configuredBoundSessionKey = configuredRoute?.boundSessionKey?.trim() || void 0;
	const boundSessionKey = threadBinding?.targetSessionKey?.trim() || configuredBoundSessionKey;
	const effectiveRoute = resolveDiscordEffectiveRoute({
		route,
		boundSessionKey,
		configuredRoute,
		matchedBy: configuredBinding ? "binding.channel" : void 0
	});
	const { sessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
		agentId: effectiveRoute.agentId,
		sessionPrefix,
		userId: user.id,
		targetSessionKey: effectiveRoute.sessionKey,
		boundSessionKey
	});
	const ctxPayload = buildDiscordNativeCommandContext({
		prompt,
		commandArgs: commandArgs ?? {},
		sessionKey,
		commandTargetSessionKey,
		accountId: effectiveRoute.accountId,
		interactionId,
		channelId,
		threadParentId,
		guildName: interaction.guild?.name,
		channelTopic: channel && "topic" in channel ? channel.topic ?? void 0 : void 0,
		channelConfig,
		guildInfo,
		allowNameMatching,
		commandAuthorized,
		isDirectMessage,
		isGroupDm,
		isGuild,
		isThreadChannel,
		user: {
			id: user.id,
			username: user.username,
			globalName: user.globalName
		},
		sender: {
			id: sender.id,
			name: sender.name,
			tag: sender.tag
		}
	});
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg,
		agentId: effectiveRoute.agentId,
		channel: "discord",
		accountId: effectiveRoute.accountId
	});
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, effectiveRoute.agentId);
	let didReply = false;
	const dispatchResult = await dispatchReplyWithDispatcher({
		ctx: ctxPayload,
		cfg,
		dispatcherOptions: {
			...prefixOptions,
			humanDelay: resolveHumanDelayConfig(cfg, effectiveRoute.agentId),
			deliver: async (payload) => {
				if (suppressReplies) return;
				try {
					await deliverDiscordInteractionReply({
						interaction,
						payload,
						mediaLocalRoots,
						textLimit: resolveTextChunkLimit(cfg, "discord", accountId, { fallbackLimit: 2e3 }),
						maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
							cfg,
							discordConfig,
							accountId
						}),
						preferFollowUp: preferFollowUp || didReply,
						chunkMode: resolveChunkMode(cfg, "discord", accountId)
					});
				} catch (error) {
					if (isDiscordUnknownInteraction(error)) {
						logVerbose("discord: interaction reply skipped (interaction expired)");
						return;
					}
					throw error;
				}
				didReply = true;
			},
			onError: (err, info) => {
				const message = err instanceof Error ? err.stack ?? err.message : String(err);
				log.error(`discord slash ${info.kind} reply failed: ${message}`);
			}
		},
		replyOptions: {
			skillFilter: channelConfig?.skills,
			disableBlockStreaming: typeof discordConfig?.blockStreaming === "boolean" ? !discordConfig.blockStreaming : void 0,
			onModelSelected
		}
	});
	if (!suppressReplies && !didReply && dispatchResult.counts.final === 0 && dispatchResult.counts.block === 0 && dispatchResult.counts.tool === 0) await safeDiscordInteractionCall("interaction empty fallback", async () => {
		const payload = {
			content: "✅ Done.",
			ephemeral: true
		};
		if (preferFollowUp) {
			await interaction.followUp(payload);
			return;
		}
		await interaction.reply(payload);
	});
}
async function deliverDiscordInteractionReply(params) {
	const { interaction, payload, textLimit, maxLinesPerMessage, preferFollowUp, chunkMode } = params;
	const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
	const text = payload.text ?? "";
	const discordData = payload.channelData?.discord;
	let firstMessageComponents = Array.isArray(discordData?.components) && discordData.components.length > 0 ? discordData.components : void 0;
	let hasReplied = false;
	const sendMessage = async (content, files, components) => {
		const payload = files && files.length > 0 ? {
			content,
			...components ? { components } : {},
			files: files.map((file) => {
				if (file.data instanceof Blob) return {
					name: file.name,
					data: file.data
				};
				const arrayBuffer = Uint8Array.from(file.data).buffer;
				return {
					name: file.name,
					data: new Blob([arrayBuffer])
				};
			})
		} : {
			content,
			...components ? { components } : {}
		};
		await safeDiscordInteractionCall("interaction send", async () => {
			if (!preferFollowUp && !hasReplied) {
				await interaction.reply(payload);
				hasReplied = true;
				firstMessageComponents = void 0;
				return;
			}
			await interaction.followUp(payload);
			hasReplied = true;
			firstMessageComponents = void 0;
		});
	};
	if (mediaList.length > 0) {
		const media = await Promise.all(mediaList.map(async (url) => {
			const loaded = await loadWebMedia(url, { localRoots: params.mediaLocalRoots });
			return {
				name: loaded.fileName ?? "upload",
				data: loaded.buffer
			};
		}));
		const chunks = chunkDiscordTextWithMode(text, {
			maxChars: textLimit,
			maxLines: maxLinesPerMessage,
			chunkMode
		});
		if (!chunks.length && text) chunks.push(text);
		await sendMessage(chunks[0] ?? "", media, firstMessageComponents);
		for (const chunk of chunks.slice(1)) {
			if (!chunk.trim()) continue;
			await interaction.followUp({ content: chunk });
		}
		return;
	}
	if (!text.trim() && !firstMessageComponents) return;
	const chunks = chunkDiscordTextWithMode(text, {
		maxChars: textLimit,
		maxLines: maxLinesPerMessage,
		chunkMode
	});
	if (!chunks.length && (text || firstMessageComponents)) chunks.push(text);
	for (const chunk of chunks) {
		if (!chunk.trim() && !firstMessageComponents) continue;
		await sendMessage(chunk, void 0, firstMessageComponents);
	}
}
//#endregion
//#region extensions/discord/src/monitor.gateway.ts
function getDiscordGatewayEmitter(gateway) {
	return gateway?.emitter;
}
async function waitForDiscordGatewayStop(params) {
	const { gateway, abortSignal, onGatewayError, shouldStopOnError } = params;
	const emitter = gateway?.emitter;
	return await new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			abortSignal?.removeEventListener("abort", onAbort);
			emitter?.removeListener("error", onGatewayErrorEvent);
		};
		const finishResolve = () => {
			if (settled) return;
			settled = true;
			cleanup();
			try {
				gateway?.disconnect?.();
			} finally {
				resolve();
			}
		};
		const finishReject = (err) => {
			if (settled) return;
			settled = true;
			cleanup();
			try {
				gateway?.disconnect?.();
			} finally {
				reject(err);
			}
		};
		const onAbort = () => {
			finishResolve();
		};
		const onGatewayErrorEvent = (err) => {
			onGatewayError?.(err);
			if (shouldStopOnError?.(err) ?? true) finishReject(err);
		};
		const onForceStop = (err) => {
			finishReject(err);
		};
		if (abortSignal?.aborted) {
			onAbort();
			return;
		}
		abortSignal?.addEventListener("abort", onAbort, { once: true });
		emitter?.on("error", onGatewayErrorEvent);
		params.registerForceStop?.(onForceStop);
	});
}
//#endregion
//#region extensions/discord/src/probe.ts
init_fetch();
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_APP_FLAG_GATEWAY_PRESENCE = 4096;
const DISCORD_APP_FLAG_GATEWAY_PRESENCE_LIMITED = 8192;
const DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS = 16384;
const DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED = 32768;
const DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT = 1 << 18;
const DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
async function fetchDiscordApplicationMe(token, timeoutMs, fetcher) {
	try {
		const appResponse = await fetchDiscordApplicationMeResponse(token, timeoutMs, fetcher);
		if (!appResponse || !appResponse.ok) return;
		return await appResponse.json();
	} catch {
		return;
	}
}
async function fetchDiscordApplicationMeResponse(token, timeoutMs, fetcher) {
	const normalized = normalizeDiscordToken(token, "channels.discord.token");
	if (!normalized) return;
	return await fetchWithTimeout(`${DISCORD_API_BASE}/oauth2/applications/@me`, { headers: { Authorization: `Bot ${normalized}` } }, timeoutMs, getResolvedFetch(fetcher));
}
function resolveDiscordPrivilegedIntentsFromFlags(flags) {
	const resolve = (enabledBit, limitedBit) => {
		if ((flags & enabledBit) !== 0) return "enabled";
		if ((flags & limitedBit) !== 0) return "limited";
		return "disabled";
	};
	return {
		presence: resolve(DISCORD_APP_FLAG_GATEWAY_PRESENCE, DISCORD_APP_FLAG_GATEWAY_PRESENCE_LIMITED),
		guildMembers: resolve(DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS, DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED),
		messageContent: resolve(DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT, DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED)
	};
}
async function fetchDiscordApplicationSummary(token, timeoutMs, fetcher = fetch) {
	const json = await fetchDiscordApplicationMe(token, timeoutMs, fetcher);
	if (!json) return;
	const flags = typeof json.flags === "number" && Number.isFinite(json.flags) ? json.flags : void 0;
	return {
		id: json.id ?? null,
		flags: flags ?? null,
		intents: typeof flags === "number" ? resolveDiscordPrivilegedIntentsFromFlags(flags) : void 0
	};
}
function getResolvedFetch(fetcher) {
	const fetchImpl = resolveFetch(fetcher);
	if (!fetchImpl) throw new Error("fetch is not available");
	return fetchImpl;
}
async function probeDiscord(token, timeoutMs, opts) {
	const started = Date.now();
	const fetcher = opts?.fetcher ?? fetch;
	const includeApplication = opts?.includeApplication === true;
	const normalized = normalizeDiscordToken(token, "channels.discord.token");
	const result = {
		ok: false,
		status: null,
		error: null,
		elapsedMs: 0
	};
	if (!normalized) return {
		...result,
		error: "missing token",
		elapsedMs: Date.now() - started
	};
	try {
		const res = await fetchWithTimeout(`${DISCORD_API_BASE}/users/@me`, { headers: { Authorization: `Bot ${normalized}` } }, timeoutMs, getResolvedFetch(fetcher));
		if (!res.ok) {
			result.status = res.status;
			result.error = `getMe failed (${res.status})`;
			return {
				...result,
				elapsedMs: Date.now() - started
			};
		}
		const json = await res.json();
		result.ok = true;
		result.bot = {
			id: json.id ?? null,
			username: json.username ?? null
		};
		if (includeApplication) result.application = await fetchDiscordApplicationSummary(normalized, timeoutMs, fetcher) ?? void 0;
		return {
			...result,
			elapsedMs: Date.now() - started
		};
	} catch (err) {
		return {
			...result,
			status: err instanceof Response ? err.status : result.status,
			error: err instanceof Error ? err.message : String(err),
			elapsedMs: Date.now() - started
		};
	}
}
/**
* Extract the application (bot user) ID from a Discord bot token by
* base64-decoding the first segment.  Discord tokens have the format:
*   base64(user_id) . timestamp . hmac
* The decoded first segment is the numeric snowflake ID as a plain string,
* so we keep it as a string to avoid precision loss for IDs that exceed
* Number.MAX_SAFE_INTEGER.
*/
function parseApplicationIdFromToken(token) {
	const normalized = normalizeDiscordToken(token, "channels.discord.token");
	if (!normalized) return;
	const firstDot = normalized.indexOf(".");
	if (firstDot <= 0) return;
	try {
		const decoded = Buffer.from(normalized.slice(0, firstDot), "base64").toString("utf-8");
		if (/^\d+$/.test(decoded)) return decoded;
		return;
	} catch {
		return;
	}
}
async function fetchDiscordApplicationId(token, timeoutMs, fetcher = fetch) {
	if (!normalizeDiscordToken(token, "channels.discord.token")) return;
	try {
		const res = await fetchDiscordApplicationMeResponse(token, timeoutMs, fetcher);
		if (!res) return;
		if (res.ok) {
			const json = await res.json();
			if (json?.id) return json.id;
		}
		return;
	} catch {
		return parseApplicationIdFromToken(token);
	}
}
//#endregion
//#region extensions/discord/src/voice/command.ts
init_allow_list();
const VOICE_CHANNEL_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
async function authorizeVoiceCommand(interaction, params, options) {
	const channelOverride = options?.channelOverride;
	const channel = channelOverride ? void 0 : interaction.channel;
	if (!interaction.guild) return {
		ok: false,
		message: "Voice commands are only available in guilds."
	};
	const user = interaction.user;
	if (!user) return {
		ok: false,
		message: "Unable to resolve command user."
	};
	const channelId = channelOverride?.id ?? channel?.id ?? "";
	const rawChannelName = channelOverride?.name ?? (channel && "name" in channel ? channel.name : void 0);
	const rawParentId = channelOverride?.parentId ?? ("parentId" in (channel ?? {}) ? channel.parentId ?? void 0 : void 0);
	const channelInfo = channelId ? await resolveDiscordChannelInfo(interaction.client, channelId) : null;
	const channelName = rawChannelName ?? channelInfo?.name;
	const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
	const isThreadChannel = channelInfo?.type === ChannelType$1.PublicThread || channelInfo?.type === ChannelType$1.PrivateThread || channelInfo?.type === ChannelType$1.AnnouncementThread;
	let parentId;
	let parentName;
	let parentSlug;
	if (isThreadChannel && channelId) {
		const parentInfo = await resolveDiscordThreadParentInfo({
			client: interaction.client,
			threadChannel: {
				id: channelId,
				name: channelName,
				parentId: rawParentId ?? channelInfo?.parentId,
				parent: void 0
			},
			channelInfo
		});
		parentId = parentInfo.id;
		parentName = parentInfo.name;
		parentSlug = parentName ? normalizeDiscordSlug(parentName) : void 0;
	}
	const guildInfo = resolveDiscordGuildEntry({
		guild: interaction.guild ?? void 0,
		guildId: interaction.guild?.id ?? interaction.rawData.guild_id ?? void 0,
		guildEntries: params.discordConfig.guilds
	});
	const channelConfig = channelId ? resolveDiscordChannelConfigWithFallback({
		guildInfo,
		channelId,
		channelName,
		channelSlug,
		parentId,
		parentName,
		parentSlug,
		scope: isThreadChannel ? "thread" : "channel"
	}) : null;
	if (channelConfig?.enabled === false) return {
		ok: false,
		message: "This channel is disabled."
	};
	const channelAllowlistConfigured = Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
	const channelAllowed = channelConfig?.allowed !== false;
	if (!isDiscordGroupAllowedByPolicy({
		groupPolicy: params.groupPolicy,
		guildAllowlisted: Boolean(guildInfo),
		channelAllowlistConfigured,
		channelAllowed
	}) || channelConfig?.allowed === false) {
		const channelId = channelOverride?.id ?? channel?.id;
		return {
			ok: false,
			message: `${channelId ? formatMention({ channelId }) : "This channel"} is not allowlisted for voice commands.`
		};
	}
	const memberRoleIds = Array.isArray(interaction.rawData.member?.roles) ? interaction.rawData.member.roles.map((roleId) => String(roleId)) : [];
	const sender = resolveDiscordSenderIdentity({
		author: user,
		member: interaction.rawData.member
	});
	const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
		channelConfig,
		guildInfo,
		memberRoleIds,
		sender,
		allowNameMatching: isDangerousNameMatchingEnabled(params.discordConfig)
	});
	const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
		allowFrom: params.discordConfig.allowFrom ?? params.discordConfig.dm?.allowFrom ?? [],
		sender: {
			id: sender.id,
			name: sender.name,
			tag: sender.tag
		},
		allowNameMatching: isDangerousNameMatchingEnabled(params.discordConfig)
	});
	const authorizers = params.useAccessGroups ? [{
		configured: ownerAllowList != null,
		allowed: ownerOk
	}, {
		configured: hasAccessRestrictions,
		allowed: memberAllowed
	}] : [{
		configured: hasAccessRestrictions,
		allowed: memberAllowed
	}];
	if (!resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups: params.useAccessGroups,
		authorizers,
		modeWhenAccessGroupsOff: "configured"
	})) return {
		ok: false,
		message: "You are not authorized to use this command."
	};
	return {
		ok: true,
		guildId: interaction.guild.id
	};
}
async function resolveVoiceCommandRuntimeContext(interaction, params) {
	const guildId = interaction.guild?.id;
	if (!guildId) {
		await interaction.reply({
			content: "Unable to resolve guild for this command.",
			ephemeral: true
		});
		return null;
	}
	const manager = params.getManager();
	if (!manager) {
		await interaction.reply({
			content: "Voice manager is not available yet.",
			ephemeral: true
		});
		return null;
	}
	return {
		guildId,
		manager
	};
}
async function ensureVoiceCommandAccess(params) {
	const access = await authorizeVoiceCommand(params.interaction, params.context, { channelOverride: params.channelOverride });
	if (access.ok) return true;
	await params.interaction.reply({
		content: access.message ?? "Not authorized.",
		ephemeral: true
	});
	return false;
}
function createDiscordVoiceCommand(params) {
	const resolveSessionChannelId = (manager, guildId) => manager.status().find((entry) => entry.guildId === guildId)?.channelId;
	class JoinCommand extends Command {
		constructor(..._args) {
			super(..._args);
			this.name = "join";
			this.description = "Join a voice channel";
			this.defer = true;
			this.ephemeral = params.ephemeralDefault;
			this.options = [{
				name: "channel",
				description: "Voice channel to join",
				type: ApplicationCommandOptionType.Channel,
				required: true,
				channel_types: VOICE_CHANNEL_TYPES
			}];
		}
		async run(interaction) {
			const channel = await interaction.options.getChannel("channel", true);
			if (!channel || !("id" in channel)) {
				await interaction.reply({
					content: "Voice channel not found.",
					ephemeral: true
				});
				return;
			}
			const access = await authorizeVoiceCommand(interaction, params, { channelOverride: {
				id: channel.id,
				name: "name" in channel ? channel.name : void 0,
				parentId: "parentId" in channel ? channel.parentId ?? void 0 : void 0
			} });
			if (!access.ok) {
				await interaction.reply({
					content: access.message ?? "Not authorized.",
					ephemeral: true
				});
				return;
			}
			if (!isVoiceChannelType(channel.type)) {
				await interaction.reply({
					content: "That is not a voice channel.",
					ephemeral: true
				});
				return;
			}
			const guildId = access.guildId ?? ("guildId" in channel ? channel.guildId : void 0);
			if (!guildId) {
				await interaction.reply({
					content: "Unable to resolve guild for this voice channel.",
					ephemeral: true
				});
				return;
			}
			const manager = params.getManager();
			if (!manager) {
				await interaction.reply({
					content: "Voice manager is not available yet.",
					ephemeral: true
				});
				return;
			}
			const result = await manager.join({
				guildId,
				channelId: channel.id
			});
			await interaction.reply({
				content: result.message,
				ephemeral: true
			});
		}
	}
	class LeaveCommand extends Command {
		constructor(..._args2) {
			super(..._args2);
			this.name = "leave";
			this.description = "Leave the current voice channel";
			this.defer = true;
			this.ephemeral = params.ephemeralDefault;
		}
		async run(interaction) {
			const runtimeContext = await resolveVoiceCommandRuntimeContext(interaction, params);
			if (!runtimeContext) return;
			const sessionChannelId = resolveSessionChannelId(runtimeContext.manager, runtimeContext.guildId);
			if (!await ensureVoiceCommandAccess({
				interaction,
				context: params,
				channelOverride: sessionChannelId ? { id: sessionChannelId } : void 0
			})) return;
			const result = await runtimeContext.manager.leave({ guildId: runtimeContext.guildId });
			await interaction.reply({
				content: result.message,
				ephemeral: true
			});
		}
	}
	class StatusCommand extends Command {
		constructor(..._args3) {
			super(..._args3);
			this.name = "status";
			this.description = "Show active voice sessions";
			this.defer = true;
			this.ephemeral = params.ephemeralDefault;
		}
		async run(interaction) {
			const runtimeContext = await resolveVoiceCommandRuntimeContext(interaction, params);
			if (!runtimeContext) return;
			const sessions = runtimeContext.manager.status().filter((entry) => entry.guildId === runtimeContext.guildId);
			const sessionChannelId = sessions[0]?.channelId;
			if (!await ensureVoiceCommandAccess({
				interaction,
				context: params,
				channelOverride: sessionChannelId ? { id: sessionChannelId } : void 0
			})) return;
			if (sessions.length === 0) {
				await interaction.reply({
					content: "No active voice sessions.",
					ephemeral: true
				});
				return;
			}
			const lines = sessions.map((entry) => `• ${formatMention({ channelId: entry.channelId })} (guild ${entry.guildId})`);
			await interaction.reply({
				content: lines.join("\n"),
				ephemeral: true
			});
		}
	}
	return new class extends CommandWithSubcommands {
		constructor(..._args4) {
			super(..._args4);
			this.name = "vc";
			this.description = "Voice channel controls";
			this.subcommands = [
				new JoinCommand(),
				new LeaveCommand(),
				new StatusCommand()
			];
		}
	}();
}
function isVoiceChannelType(type) {
	return type === ChannelType$1.GuildVoice || type === ChannelType$1.GuildStageVoice;
}
//#endregion
//#region extensions/discord/src/monitor/agent-components.ts
init_globals();
init_conversation_binding();
init_interactive();
init_accounts();
init_allow_list();
init_format();
const AGENT_BUTTON_KEY = "agent";
const AGENT_SELECT_KEY = "agentsel";
function resolveAgentComponentRoute(params) {
	return resolveAgentRoute({
		cfg: params.ctx.cfg,
		channel: "discord",
		accountId: params.ctx.accountId,
		guildId: params.rawGuildId,
		memberRoleIds: params.memberRoleIds,
		peer: {
			kind: params.isDirectMessage ? "direct" : "channel",
			id: params.isDirectMessage ? params.userId : params.channelId
		},
		parentPeer: params.parentId ? {
			kind: "channel",
			id: params.parentId
		} : void 0
	});
}
async function ackComponentInteraction(params) {
	try {
		await params.interaction.reply({
			content: "✓",
			...params.replyOpts
		});
	} catch (err) {
		logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
	}
}
function resolveDiscordChannelContext(interaction) {
	const channel = interaction.channel;
	const channelName = channel && "name" in channel ? channel.name : void 0;
	const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
	const channelType = channel && "type" in channel ? channel.type : void 0;
	const isThread = isThreadChannelType(channelType);
	let parentId;
	let parentName;
	let parentSlug = "";
	if (isThread && channel && "parentId" in channel) {
		parentId = channel.parentId ?? void 0;
		if ("parent" in channel) {
			const parent = channel.parent;
			if (parent?.name) {
				parentName = parent.name;
				parentSlug = normalizeDiscordSlug(parentName);
			}
		}
	}
	return {
		channelName,
		channelSlug,
		channelType,
		isThread,
		parentId,
		parentName,
		parentSlug
	};
}
async function resolveComponentInteractionContext(params) {
	const { interaction, label } = params;
	const channelId = interaction.rawData.channel_id;
	if (!channelId) {
		logError(`${label}: missing channel_id in interaction`);
		return null;
	}
	const user = interaction.user;
	if (!user) {
		logError(`${label}: missing user in interaction`);
		return null;
	}
	const shouldDefer = params.defer !== false && "defer" in interaction;
	let didDefer = false;
	if (shouldDefer) try {
		await interaction.defer({ ephemeral: true });
		didDefer = true;
	} catch (err) {
		logError(`${label}: failed to defer interaction: ${String(err)}`);
	}
	const replyOpts = didDefer ? {} : { ephemeral: true };
	const username = formatUsername(user);
	const userId = user.id;
	const rawGuildId = interaction.rawData.guild_id;
	return {
		channelId,
		user,
		username,
		userId,
		replyOpts,
		rawGuildId,
		isDirectMessage: !rawGuildId,
		memberRoleIds: Array.isArray(interaction.rawData.member?.roles) ? interaction.rawData.member.roles.map((roleId) => String(roleId)) : []
	};
}
async function ensureGuildComponentMemberAllowed(params) {
	const { interaction, guildInfo, channelId, rawGuildId, channelCtx, memberRoleIds, user, replyOpts, componentLabel, unauthorizedReply } = params;
	if (!rawGuildId) return true;
	const { memberAllowed } = resolveDiscordMemberAccessState({
		channelConfig: resolveDiscordChannelConfigWithFallback({
			guildInfo,
			channelId,
			channelName: channelCtx.channelName,
			channelSlug: channelCtx.channelSlug,
			parentId: channelCtx.parentId,
			parentName: channelCtx.parentName,
			parentSlug: channelCtx.parentSlug,
			scope: channelCtx.isThread ? "thread" : "channel"
		}),
		guildInfo,
		memberRoleIds,
		sender: {
			id: user.id,
			name: user.username,
			tag: user.discriminator ? `${user.username}#${user.discriminator}` : void 0
		},
		allowNameMatching: params.allowNameMatching
	});
	if (memberAllowed) return true;
	logVerbose(`agent ${componentLabel}: blocked user ${user.id} (not in users/roles allowlist)`);
	try {
		await interaction.reply({
			content: unauthorizedReply,
			...replyOpts
		});
	} catch {}
	return false;
}
async function ensureComponentUserAllowed(params) {
	const allowList = normalizeDiscordAllowList(params.entry.allowedUsers, [
		"discord:",
		"user:",
		"pk:"
	]);
	if (!allowList) return true;
	if (resolveDiscordAllowListMatch({
		allowList,
		candidate: {
			id: params.user.id,
			name: params.user.username,
			tag: formatDiscordUserTag(params.user)
		},
		allowNameMatching: params.allowNameMatching
	}).allowed) return true;
	logVerbose(`discord component ${params.componentLabel}: blocked user ${params.user.id} (not in allowedUsers)`);
	try {
		await params.interaction.reply({
			content: params.unauthorizedReply,
			...params.replyOpts
		});
	} catch {}
	return false;
}
async function ensureAgentComponentInteractionAllowed(params) {
	const guildInfo = resolveDiscordGuildEntry({
		guild: params.interaction.guild ?? void 0,
		guildId: params.rawGuildId,
		guildEntries: params.ctx.guildEntries
	});
	const channelCtx = resolveDiscordChannelContext(params.interaction);
	if (!await ensureGuildComponentMemberAllowed({
		interaction: params.interaction,
		guildInfo,
		channelId: params.channelId,
		rawGuildId: params.rawGuildId,
		channelCtx,
		memberRoleIds: params.memberRoleIds,
		user: params.user,
		replyOpts: params.replyOpts,
		componentLabel: params.componentLabel,
		unauthorizedReply: params.unauthorizedReply,
		allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig)
	})) return null;
	return { parentId: channelCtx.parentId };
}
/**
* Parse agent component data from Carbon's parsed ComponentData
* Supports both legacy { componentId } and Components v2 { cid } payloads.
*/
function readParsedComponentId(data) {
	if (!data || typeof data !== "object") return;
	return "cid" in data ? data.cid : data.componentId;
}
function parseAgentComponentData(data) {
	const raw = readParsedComponentId(data);
	const decodeSafe = (value) => {
		if (!value.includes("%")) return value;
		if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	};
	const componentId = typeof raw === "string" ? decodeSafe(raw) : typeof raw === "number" ? String(raw) : null;
	if (!componentId) return null;
	return { componentId };
}
function formatUsername(user) {
	if (user.discriminator && user.discriminator !== "0") return `${user.username}#${user.discriminator}`;
	return user.username;
}
/**
* Check if a channel type is a thread type
*/
function isThreadChannelType(channelType) {
	return channelType === ChannelType.PublicThread || channelType === ChannelType.PrivateThread || channelType === ChannelType.AnnouncementThread;
}
async function ensureDmComponentAuthorized(params) {
	const { ctx, interaction, user, componentLabel, replyOpts } = params;
	const dmPolicy = ctx.dmPolicy ?? "pairing";
	if (dmPolicy === "disabled") {
		logVerbose(`agent ${componentLabel}: blocked (DM policy disabled)`);
		try {
			await interaction.reply({
				content: "DM interactions are disabled.",
				...replyOpts
			});
		} catch {}
		return false;
	}
	if (dmPolicy === "open") return true;
	const storeAllowFrom = await readStoreAllowFromForDmPolicy({
		provider: "discord",
		accountId: ctx.accountId,
		dmPolicy
	});
	const allowList = normalizeDiscordAllowList([...ctx.allowFrom ?? [], ...storeAllowFrom], [
		"discord:",
		"user:",
		"pk:"
	]);
	if ((allowList ? resolveDiscordAllowListMatch({
		allowList,
		candidate: {
			id: user.id,
			name: user.username,
			tag: formatDiscordUserTag(user)
		},
		allowNameMatching: isDangerousNameMatchingEnabled(ctx.discordConfig)
	}) : { allowed: false }).allowed) return true;
	if (dmPolicy === "pairing") {
		if (!(await issuePairingChallenge({
			channel: "discord",
			senderId: user.id,
			senderIdLine: `Your Discord user id: ${user.id}`,
			meta: {
				tag: formatDiscordUserTag(user),
				name: user.username
			},
			upsertPairingRequest: async ({ id, meta }) => await upsertChannelPairingRequest({
				channel: "discord",
				id,
				accountId: ctx.accountId,
				meta
			}),
			sendPairingReply: async (text) => {
				await interaction.reply({
					content: text,
					...replyOpts
				});
			}
		})).created) try {
			await interaction.reply({
				content: "Pairing already requested. Ask the bot owner to approve your code.",
				...replyOpts
			});
		} catch {}
		return false;
	}
	logVerbose(`agent ${componentLabel}: blocked DM user ${user.id} (not in allowFrom)`);
	try {
		await interaction.reply({
			content: `You are not authorized to use this ${componentLabel}.`,
			...replyOpts
		});
	} catch {}
	return false;
}
async function resolveInteractionContextWithDmAuth(params) {
	const interactionCtx = await resolveComponentInteractionContext({
		interaction: params.interaction,
		label: params.label,
		defer: params.defer
	});
	if (!interactionCtx) return null;
	if (interactionCtx.isDirectMessage) {
		if (!await ensureDmComponentAuthorized({
			ctx: params.ctx,
			interaction: params.interaction,
			user: interactionCtx.user,
			componentLabel: params.componentLabel,
			replyOpts: interactionCtx.replyOpts
		})) return null;
	}
	return interactionCtx;
}
function normalizeComponentId(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : void 0;
	}
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
}
function parseDiscordComponentData(data, customId) {
	if (!data || typeof data !== "object") return null;
	const rawComponentId = readParsedComponentId(data);
	const rawModalId = "mid" in data ? data.mid : data.modalId;
	let componentId = normalizeComponentId(rawComponentId);
	let modalId = normalizeComponentId(rawModalId);
	if (!componentId && customId) {
		const parsed = parseDiscordComponentCustomId(customId);
		if (parsed) {
			componentId = parsed.componentId;
			modalId = parsed.modalId;
		}
	}
	if (!componentId) return null;
	return {
		componentId,
		modalId
	};
}
function parseDiscordModalId(data, customId) {
	if (data && typeof data === "object") {
		const modalId = normalizeComponentId("mid" in data ? data.mid : data.modalId);
		if (modalId) return modalId;
	}
	if (customId) return parseDiscordModalCustomId(customId);
	return null;
}
function resolveInteractionCustomId(interaction) {
	if (!interaction?.rawData || typeof interaction.rawData !== "object") return;
	if (!("data" in interaction.rawData)) return;
	const customId = interaction.rawData.data?.custom_id;
	if (typeof customId !== "string") return;
	const trimmed = customId.trim();
	return trimmed ? trimmed : void 0;
}
function mapOptionLabels(options, values) {
	if (!options || options.length === 0) return values;
	const map = new Map(options.map((option) => [option.value, option.label]));
	return values.map((value) => map.get(value) ?? value);
}
function mapSelectValues(entry, values) {
	if (entry.selectType === "string") return mapOptionLabels(entry.options, values);
	if (entry.selectType === "user") return values.map((value) => `user:${value}`);
	if (entry.selectType === "role") return values.map((value) => `role:${value}`);
	if (entry.selectType === "mentionable") return values.map((value) => `mentionable:${value}`);
	if (entry.selectType === "channel") return values.map((value) => `channel:${value}`);
	return values;
}
function resolveModalFieldValues(field, interaction) {
	const fields = interaction.fields;
	const optionLabels = field.options?.map((option) => ({
		value: option.value,
		label: option.label
	}));
	const required = field.required === true;
	try {
		switch (field.type) {
			case "text": {
				const value = required ? fields.getText(field.id, true) : fields.getText(field.id);
				return value ? [value] : [];
			}
			case "select":
			case "checkbox":
			case "radio": return mapOptionLabels(optionLabels, required ? fields.getStringSelect(field.id, true) : fields.getStringSelect(field.id) ?? []);
			case "role-select": try {
				return (required ? fields.getRoleSelect(field.id, true) : fields.getRoleSelect(field.id) ?? []).map((role) => role.name ?? role.id);
			} catch {
				return required ? fields.getStringSelect(field.id, true) : fields.getStringSelect(field.id) ?? [];
			}
			case "user-select": return (required ? fields.getUserSelect(field.id, true) : fields.getUserSelect(field.id) ?? []).map((user) => formatDiscordUserTag(user));
			default: return [];
		}
	} catch (err) {
		logError(`agent modal: failed to read field ${field.id}: ${String(err)}`);
		return [];
	}
}
function formatModalSubmissionText(entry, interaction) {
	const lines = [`Form "${entry.title}" submitted.`];
	for (const field of entry.fields) {
		const values = resolveModalFieldValues(field, interaction);
		if (values.length === 0) continue;
		lines.push(`- ${field.label}: ${values.join(", ")}`);
	}
	if (lines.length === 1) lines.push("- (no values)");
	return lines.join("\n");
}
function resolveDiscordInteractionId(interaction) {
	const rawId = interaction.rawData && typeof interaction.rawData === "object" && "id" in interaction.rawData ? interaction.rawData.id : void 0;
	if (typeof rawId === "string" && rawId.trim()) return rawId.trim();
	if (typeof rawId === "number" && Number.isFinite(rawId)) return String(rawId);
	return `discord-interaction:${Date.now()}`;
}
async function dispatchPluginDiscordInteractiveEvent(params) {
	const normalizedConversationId = params.interactionCtx.rawGuildId || params.channelCtx.channelType === ChannelType.GroupDM ? `channel:${params.interactionCtx.channelId}` : `user:${params.interactionCtx.userId}`;
	let responded = false;
	const respond = {
		acknowledge: async () => {
			responded = true;
			await params.interaction.acknowledge();
		},
		reply: async ({ text, ephemeral = true }) => {
			responded = true;
			await params.interaction.reply({
				content: text,
				ephemeral
			});
		},
		followUp: async ({ text, ephemeral = true }) => {
			responded = true;
			await params.interaction.followUp({
				content: text,
				ephemeral
			});
		},
		editMessage: async ({ text, components }) => {
			if (!("update" in params.interaction) || typeof params.interaction.update !== "function") throw new Error("Discord interaction cannot update the source message");
			responded = true;
			await params.interaction.update({
				...text !== void 0 ? { content: text } : {},
				...components !== void 0 ? { components } : {}
			});
		},
		clearComponents: async (input) => {
			if (!("update" in params.interaction) || typeof params.interaction.update !== "function") throw new Error("Discord interaction cannot clear components on the source message");
			responded = true;
			await params.interaction.update({
				...input?.text !== void 0 ? { content: input.text } : {},
				components: []
			});
		}
	};
	const pluginBindingApproval = parsePluginBindingApprovalCustomId(params.data);
	if (pluginBindingApproval) {
		const resolved = await resolvePluginConversationBindingApproval({
			approvalId: pluginBindingApproval.approvalId,
			decision: pluginBindingApproval.decision,
			senderId: params.interactionCtx.userId
		});
		let cleared = false;
		try {
			await respond.clearComponents();
			cleared = true;
		} catch {
			try {
				await respond.acknowledge();
			} catch {}
		}
		try {
			await respond.followUp({
				text: buildPluginBindingResolvedText(resolved),
				ephemeral: true
			});
		} catch (err) {
			logError(`discord plugin binding approval: failed to follow up: ${String(err)}`);
			if (!cleared) try {
				await respond.reply({
					text: buildPluginBindingResolvedText(resolved),
					ephemeral: true
				});
			} catch {}
		}
		return "handled";
	}
	const dispatched = await dispatchPluginInteractiveHandler({
		channel: "discord",
		data: params.data,
		interactionId: resolveDiscordInteractionId(params.interaction),
		ctx: {
			accountId: params.ctx.accountId,
			interactionId: resolveDiscordInteractionId(params.interaction),
			conversationId: normalizedConversationId,
			parentConversationId: params.channelCtx.parentId,
			guildId: params.interactionCtx.rawGuildId,
			senderId: params.interactionCtx.userId,
			senderUsername: params.interactionCtx.username,
			auth: { isAuthorizedSender: params.isAuthorizedSender },
			interaction: {
				kind: params.kind,
				messageId: params.messageId,
				values: params.values,
				fields: params.fields
			}
		},
		respond
	});
	if (!dispatched.matched) return "unmatched";
	if (dispatched.handled) {
		if (!responded) try {
			await respond.acknowledge();
		} catch {}
		return "handled";
	}
	return "unmatched";
}
function resolveComponentCommandAuthorized(params) {
	const { ctx, interactionCtx, channelConfig, guildInfo } = params;
	if (interactionCtx.isDirectMessage) return true;
	const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
		allowFrom: ctx.allowFrom,
		sender: {
			id: interactionCtx.user.id,
			name: interactionCtx.user.username,
			tag: formatDiscordUserTag(interactionCtx.user)
		},
		allowNameMatching: params.allowNameMatching
	});
	const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
		channelConfig,
		guildInfo,
		memberRoleIds: interactionCtx.memberRoleIds,
		sender: {
			id: interactionCtx.user.id,
			name: interactionCtx.user.username,
			tag: formatDiscordUserTag(interactionCtx.user)
		},
		allowNameMatching: params.allowNameMatching
	});
	const useAccessGroups = ctx.cfg.commands?.useAccessGroups !== false;
	return resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups,
		authorizers: useAccessGroups ? [{
			configured: ownerAllowList != null,
			allowed: ownerOk
		}, {
			configured: hasAccessRestrictions,
			allowed: memberAllowed
		}] : [{
			configured: hasAccessRestrictions,
			allowed: memberAllowed
		}],
		modeWhenAccessGroupsOff: "configured"
	});
}
async function dispatchDiscordComponentEvent(params) {
	const { ctx, interaction, interactionCtx, channelCtx, guildInfo, eventText } = params;
	const runtime = ctx.runtime ?? createNonExitingRuntime();
	const route = resolveAgentRoute({
		cfg: ctx.cfg,
		channel: "discord",
		accountId: ctx.accountId,
		guildId: interactionCtx.rawGuildId,
		memberRoleIds: interactionCtx.memberRoleIds,
		peer: {
			kind: interactionCtx.isDirectMessage ? "direct" : "channel",
			id: interactionCtx.isDirectMessage ? interactionCtx.userId : interactionCtx.channelId
		},
		parentPeer: channelCtx.parentId ? {
			kind: "channel",
			id: channelCtx.parentId
		} : void 0
	});
	const sessionKey = params.routeOverrides?.sessionKey ?? route.sessionKey;
	const agentId = params.routeOverrides?.agentId ?? route.agentId;
	const accountId = params.routeOverrides?.accountId ?? route.accountId;
	const fromLabel = interactionCtx.isDirectMessage ? buildDirectLabel(interactionCtx.user) : buildGuildLabel({
		guild: interaction.guild ?? void 0,
		channelName: channelCtx.channelName ?? interactionCtx.channelId,
		channelId: interactionCtx.channelId
	});
	const senderName = interactionCtx.user.globalName ?? interactionCtx.user.username;
	const senderUsername = interactionCtx.user.username;
	const senderTag = formatDiscordUserTag(interactionCtx.user);
	const groupChannel = !interactionCtx.isDirectMessage && channelCtx.channelSlug ? `#${channelCtx.channelSlug}` : void 0;
	const groupSubject = interactionCtx.isDirectMessage ? void 0 : groupChannel;
	const channelConfig = resolveDiscordChannelConfigWithFallback({
		guildInfo,
		channelId: interactionCtx.channelId,
		channelName: channelCtx.channelName,
		channelSlug: channelCtx.channelSlug,
		parentId: channelCtx.parentId,
		parentName: channelCtx.parentName,
		parentSlug: channelCtx.parentSlug,
		scope: channelCtx.isThread ? "thread" : "channel"
	});
	const allowNameMatching = isDangerousNameMatchingEnabled(ctx.discordConfig);
	const { ownerAllowFrom } = buildDiscordInboundAccessContext({
		channelConfig,
		guildInfo,
		sender: {
			id: interactionCtx.user.id,
			name: interactionCtx.user.username,
			tag: senderTag
		},
		allowNameMatching,
		isGuild: !interactionCtx.isDirectMessage
	});
	const groupSystemPrompt = buildDiscordGroupSystemPrompt(channelConfig);
	const pinnedMainDmOwner = interactionCtx.isDirectMessage ? resolvePinnedMainDmOwnerFromAllowlist({
		dmScope: ctx.cfg.session?.dmScope,
		allowFrom: channelConfig?.users ?? guildInfo?.users,
		normalizeEntry: (entry) => {
			const candidate = normalizeDiscordAllowList([entry], [
				"discord:",
				"user:",
				"pk:"
			])?.ids.values().next().value;
			return typeof candidate === "string" && /^\d+$/.test(candidate) ? candidate : void 0;
		}
	}) : null;
	const commandAuthorized = resolveComponentCommandAuthorized({
		ctx,
		interactionCtx,
		channelConfig,
		guildInfo,
		allowNameMatching
	});
	const storePath = resolveStorePath(ctx.cfg.session?.store, { agentId });
	const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
	const previousTimestamp = readSessionUpdatedAt({
		storePath,
		sessionKey
	});
	const timestamp = Date.now();
	const ctxPayload = finalizeInboundContext({
		Body: formatInboundEnvelope({
			channel: "Discord",
			from: fromLabel,
			timestamp,
			body: eventText,
			chatType: interactionCtx.isDirectMessage ? "direct" : "channel",
			senderLabel: senderName,
			previousTimestamp,
			envelope: envelopeOptions
		}),
		BodyForAgent: eventText,
		RawBody: eventText,
		CommandBody: eventText,
		From: interactionCtx.isDirectMessage ? `discord:${interactionCtx.userId}` : `discord:channel:${interactionCtx.channelId}`,
		To: `channel:${interactionCtx.channelId}`,
		SessionKey: sessionKey,
		AccountId: accountId,
		ChatType: interactionCtx.isDirectMessage ? "direct" : "channel",
		ConversationLabel: fromLabel,
		SenderName: senderName,
		SenderId: interactionCtx.userId,
		SenderUsername: senderUsername,
		SenderTag: senderTag,
		GroupSubject: groupSubject,
		GroupChannel: groupChannel,
		GroupSystemPrompt: interactionCtx.isDirectMessage ? void 0 : groupSystemPrompt,
		GroupSpace: guildInfo?.id ?? guildInfo?.slug ?? interactionCtx.rawGuildId ?? void 0,
		OwnerAllowFrom: ownerAllowFrom,
		Provider: "discord",
		Surface: "discord",
		WasMentioned: true,
		CommandAuthorized: commandAuthorized,
		CommandSource: "text",
		MessageSid: interaction.rawData.id,
		Timestamp: timestamp,
		OriginatingChannel: "discord",
		OriginatingTo: `channel:${interactionCtx.channelId}`
	});
	await recordInboundSession({
		storePath,
		sessionKey: ctxPayload.SessionKey ?? sessionKey,
		ctx: ctxPayload,
		updateLastRoute: interactionCtx.isDirectMessage ? {
			sessionKey: route.mainSessionKey,
			channel: "discord",
			to: `user:${interactionCtx.userId}`,
			accountId,
			mainDmOwnerPin: pinnedMainDmOwner ? {
				ownerRecipient: pinnedMainDmOwner,
				senderRecipient: interactionCtx.userId,
				onSkip: ({ ownerRecipient, senderRecipient }) => {
					logVerbose(`discord: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`);
				}
			} : void 0
		} : void 0,
		onRecordError: (err) => {
			logVerbose(`discord: failed updating component session meta: ${String(err)}`);
		}
	});
	const deliverTarget = `channel:${interactionCtx.channelId}`;
	const typingChannelId = interactionCtx.channelId;
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg: ctx.cfg,
		agentId,
		channel: "discord",
		accountId
	});
	const tableMode = resolveMarkdownTableMode({
		cfg: ctx.cfg,
		channel: "discord",
		accountId
	});
	const textLimit = resolveTextChunkLimit(ctx.cfg, "discord", accountId, { fallbackLimit: 2e3 });
	const token = ctx.token ?? "";
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(ctx.cfg, agentId);
	const replyToMode = ctx.discordConfig?.replyToMode ?? ctx.cfg.channels?.discord?.replyToMode ?? "off";
	const replyReference = createReplyReferencePlanner({
		replyToMode,
		startId: params.replyToId
	});
	await dispatchReplyWithBufferedBlockDispatcher({
		ctx: ctxPayload,
		cfg: ctx.cfg,
		replyOptions: { onModelSelected },
		dispatcherOptions: {
			...prefixOptions,
			humanDelay: resolveHumanDelayConfig(ctx.cfg, agentId),
			deliver: async (payload) => {
				const replyToId = replyReference.use();
				await deliverDiscordReply({
					cfg: ctx.cfg,
					replies: [payload],
					target: deliverTarget,
					token,
					accountId,
					rest: interaction.client.rest,
					runtime,
					replyToId,
					replyToMode,
					textLimit,
					maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
						cfg: ctx.cfg,
						discordConfig: ctx.discordConfig,
						accountId
					}),
					tableMode,
					chunkMode: resolveChunkMode(ctx.cfg, "discord", accountId),
					mediaLocalRoots
				});
				replyReference.markSent();
			},
			onReplyStart: async () => {
				try {
					await sendTyping({
						client: interaction.client,
						channelId: typingChannelId
					});
				} catch (err) {
					logVerbose(`discord: typing failed for component reply: ${String(err)}`);
				}
			},
			onError: (err) => {
				logError(`discord component dispatch failed: ${String(err)}`);
			}
		}
	});
}
async function handleDiscordComponentEvent(params) {
	const parsed = parseDiscordComponentData(params.data, resolveInteractionCustomId(params.interaction));
	if (!parsed) {
		logError(`${params.label}: failed to parse component data`);
		try {
			await params.interaction.reply({
				content: "This component is no longer valid.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const entry = resolveDiscordComponentEntry({
		id: parsed.componentId,
		consume: false
	});
	if (!entry) {
		try {
			await params.interaction.reply({
				content: "This component has expired.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const interactionCtx = await resolveInteractionContextWithDmAuth({
		ctx: params.ctx,
		interaction: params.interaction,
		label: params.label,
		componentLabel: params.componentLabel
	});
	if (!interactionCtx) return;
	const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
	const guildInfo = resolveDiscordGuildEntry({
		guild: params.interaction.guild ?? void 0,
		guildId: rawGuildId,
		guildEntries: params.ctx.guildEntries
	});
	const channelCtx = resolveDiscordChannelContext(params.interaction);
	const allowNameMatching = isDangerousNameMatchingEnabled(params.ctx.discordConfig);
	const channelConfig = resolveDiscordChannelConfigWithFallback({
		guildInfo,
		channelId,
		channelName: channelCtx.channelName,
		channelSlug: channelCtx.channelSlug,
		parentId: channelCtx.parentId,
		parentName: channelCtx.parentName,
		parentSlug: channelCtx.parentSlug,
		scope: channelCtx.isThread ? "thread" : "channel"
	});
	const unauthorizedReply = `You are not authorized to use this ${params.componentLabel}.`;
	if (!await ensureGuildComponentMemberAllowed({
		interaction: params.interaction,
		guildInfo,
		channelId,
		rawGuildId,
		channelCtx,
		memberRoleIds,
		user,
		replyOpts,
		componentLabel: params.componentLabel,
		unauthorizedReply,
		allowNameMatching
	})) return;
	if (!await ensureComponentUserAllowed({
		entry,
		interaction: params.interaction,
		user,
		replyOpts,
		componentLabel: params.componentLabel,
		unauthorizedReply,
		allowNameMatching
	})) return;
	const commandAuthorized = resolveComponentCommandAuthorized({
		ctx: params.ctx,
		interactionCtx,
		channelConfig,
		guildInfo,
		allowNameMatching
	});
	const consumed = resolveDiscordComponentEntry({
		id: parsed.componentId,
		consume: !entry.reusable
	});
	if (!consumed) {
		try {
			await params.interaction.reply({
				content: "This component has expired.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	if (consumed.kind === "modal-trigger") {
		try {
			await params.interaction.reply({
				content: "This form is no longer available.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const values = params.values ? mapSelectValues(consumed, params.values) : void 0;
	if (consumed.callbackData) {
		if (await dispatchPluginDiscordInteractiveEvent({
			ctx: params.ctx,
			interaction: params.interaction,
			interactionCtx,
			channelCtx,
			isAuthorizedSender: commandAuthorized,
			data: consumed.callbackData,
			kind: consumed.kind === "select" ? "select" : "button",
			values,
			messageId: consumed.messageId ?? params.interaction.message?.id
		}) === "handled") return;
	}
	const eventText = formatDiscordComponentEventText({
		kind: consumed.kind === "select" ? "select" : "button",
		label: consumed.label,
		values
	});
	try {
		await params.interaction.reply({
			content: "✓",
			...replyOpts
		});
	} catch (err) {
		logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
	}
	await dispatchDiscordComponentEvent({
		ctx: params.ctx,
		interaction: params.interaction,
		interactionCtx,
		channelCtx,
		guildInfo,
		eventText,
		replyToId: consumed.messageId ?? params.interaction.message?.id,
		routeOverrides: {
			sessionKey: consumed.sessionKey,
			agentId: consumed.agentId,
			accountId: consumed.accountId
		}
	});
}
async function handleDiscordModalTrigger(params) {
	const parsed = parseDiscordComponentData(params.data, resolveInteractionCustomId(params.interaction));
	if (!parsed) {
		logError(`${params.label}: failed to parse modal trigger data`);
		try {
			await params.interaction.reply({
				content: "This button is no longer valid.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const entry = resolveDiscordComponentEntry({
		id: parsed.componentId,
		consume: false
	});
	if (!entry || entry.kind !== "modal-trigger") {
		try {
			await params.interaction.reply({
				content: "This button has expired.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const modalId = entry.modalId ?? parsed.modalId;
	if (!modalId) {
		try {
			await params.interaction.reply({
				content: "This form is no longer available.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const interactionCtx = await resolveInteractionContextWithDmAuth({
		ctx: params.ctx,
		interaction: params.interaction,
		label: params.label,
		componentLabel: "form",
		defer: false
	});
	if (!interactionCtx) return;
	const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
	const guildInfo = resolveDiscordGuildEntry({
		guild: params.interaction.guild ?? void 0,
		guildId: rawGuildId,
		guildEntries: params.ctx.guildEntries
	});
	const channelCtx = resolveDiscordChannelContext(params.interaction);
	const unauthorizedReply = "You are not authorized to use this form.";
	if (!await ensureGuildComponentMemberAllowed({
		interaction: params.interaction,
		guildInfo,
		channelId,
		rawGuildId,
		channelCtx,
		memberRoleIds,
		user,
		replyOpts,
		componentLabel: "form",
		unauthorizedReply,
		allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig)
	})) return;
	if (!await ensureComponentUserAllowed({
		entry,
		interaction: params.interaction,
		user,
		replyOpts,
		componentLabel: "form",
		unauthorizedReply,
		allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig)
	})) return;
	const consumed = resolveDiscordComponentEntry({
		id: parsed.componentId,
		consume: !entry.reusable
	});
	if (!consumed) {
		try {
			await params.interaction.reply({
				content: "This form has expired.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	const modalEntry = resolveDiscordModalEntry({
		id: consumed.modalId ?? modalId,
		consume: false
	});
	if (!modalEntry) {
		try {
			await params.interaction.reply({
				content: "This form has expired.",
				ephemeral: true
			});
		} catch {}
		return;
	}
	try {
		await params.interaction.showModal(createDiscordFormModal(modalEntry));
	} catch (err) {
		logError(`${params.label}: failed to show modal: ${String(err)}`);
	}
}
var AgentComponentButton = class extends Button {
	constructor(ctx) {
		super();
		this.label = AGENT_BUTTON_KEY;
		this.customId = `${AGENT_BUTTON_KEY}:seed=1`;
		this.style = ButtonStyle.Primary;
		this.ctx = ctx;
	}
	async run(interaction, data) {
		const parsed = parseAgentComponentData(data);
		if (!parsed) {
			logError("agent button: failed to parse component data");
			try {
				await interaction.reply({
					content: "This button is no longer valid.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		const { componentId } = parsed;
		const interactionCtx = await resolveInteractionContextWithDmAuth({
			ctx: this.ctx,
			interaction,
			label: "agent button",
			componentLabel: "button"
		});
		if (!interactionCtx) return;
		const { channelId, user, username, userId, replyOpts, rawGuildId, isDirectMessage, memberRoleIds } = interactionCtx;
		const allowed = await ensureAgentComponentInteractionAllowed({
			ctx: this.ctx,
			interaction,
			channelId,
			rawGuildId,
			memberRoleIds,
			user,
			replyOpts,
			componentLabel: "button",
			unauthorizedReply: "You are not authorized to use this button."
		});
		if (!allowed) return;
		const { parentId } = allowed;
		const route = resolveAgentComponentRoute({
			ctx: this.ctx,
			rawGuildId,
			memberRoleIds,
			isDirectMessage,
			userId,
			channelId,
			parentId
		});
		const eventText = `[Discord component: ${componentId} clicked by ${username} (${userId})]`;
		logDebug(`agent button: enqueuing event for channel ${channelId}: ${eventText}`);
		enqueueSystemEvent(eventText, {
			sessionKey: route.sessionKey,
			contextKey: `discord:agent-button:${channelId}:${componentId}:${userId}`
		});
		await ackComponentInteraction({
			interaction,
			replyOpts,
			label: "agent button"
		});
	}
};
var AgentSelectMenu = class extends StringSelectMenu {
	constructor(ctx) {
		super();
		this.customId = `${AGENT_SELECT_KEY}:seed=1`;
		this.options = [];
		this.ctx = ctx;
	}
	async run(interaction, data) {
		const parsed = parseAgentComponentData(data);
		if (!parsed) {
			logError("agent select: failed to parse component data");
			try {
				await interaction.reply({
					content: "This select menu is no longer valid.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		const { componentId } = parsed;
		const interactionCtx = await resolveInteractionContextWithDmAuth({
			ctx: this.ctx,
			interaction,
			label: "agent select",
			componentLabel: "select menu"
		});
		if (!interactionCtx) return;
		const { channelId, user, username, userId, replyOpts, rawGuildId, isDirectMessage, memberRoleIds } = interactionCtx;
		const allowed = await ensureAgentComponentInteractionAllowed({
			ctx: this.ctx,
			interaction,
			channelId,
			rawGuildId,
			memberRoleIds,
			user,
			replyOpts,
			componentLabel: "select",
			unauthorizedReply: "You are not authorized to use this select menu."
		});
		if (!allowed) return;
		const { parentId } = allowed;
		const values = interaction.values ?? [];
		const valuesText = values.length > 0 ? ` (selected: ${values.join(", ")})` : "";
		const route = resolveAgentComponentRoute({
			ctx: this.ctx,
			rawGuildId,
			memberRoleIds,
			isDirectMessage,
			userId,
			channelId,
			parentId
		});
		const eventText = `[Discord select menu: ${componentId} interacted by ${username} (${userId})${valuesText}]`;
		logDebug(`agent select: enqueuing event for channel ${channelId}: ${eventText}`);
		enqueueSystemEvent(eventText, {
			sessionKey: route.sessionKey,
			contextKey: `discord:agent-select:${channelId}:${componentId}:${userId}`
		});
		await ackComponentInteraction({
			interaction,
			replyOpts,
			label: "agent select"
		});
	}
};
var DiscordComponentButton = class extends Button {
	constructor(ctx) {
		super();
		this.label = "component";
		this.customId = "__openclaw_discord_component_button_wildcard__";
		this.style = ButtonStyle.Primary;
		this.customIdParser = parseDiscordComponentCustomIdForCarbon;
		this.ctx = ctx;
	}
	async run(interaction, data) {
		if (parseDiscordComponentData(data, resolveInteractionCustomId(interaction))?.modalId) {
			await handleDiscordModalTrigger({
				ctx: this.ctx,
				interaction,
				data,
				label: "discord component modal"
			});
			return;
		}
		await handleDiscordComponentEvent({
			ctx: this.ctx,
			interaction,
			data,
			componentLabel: "button",
			label: "discord component button"
		});
	}
};
var DiscordComponentStringSelect = class extends StringSelectMenu {
	constructor(ctx) {
		super();
		this.customId = "__openclaw_discord_component_string_select_wildcard__";
		this.options = [];
		this.customIdParser = parseDiscordComponentCustomIdForCarbon;
		this.ctx = ctx;
	}
	async run(interaction, data) {
		await handleDiscordComponentEvent({
			ctx: this.ctx,
			interaction,
			data,
			componentLabel: "select menu",
			label: "discord component select",
			values: interaction.values ?? []
		});
	}
};
var DiscordComponentUserSelect = class extends UserSelectMenu {
	constructor(ctx) {
		super();
		this.customId = "__openclaw_discord_component_user_select_wildcard__";
		this.customIdParser = parseDiscordComponentCustomIdForCarbon;
		this.ctx = ctx;
	}
	async run(interaction, data) {
		await handleDiscordComponentEvent({
			ctx: this.ctx,
			interaction,
			data,
			componentLabel: "user select",
			label: "discord component user select",
			values: interaction.values ?? []
		});
	}
};
var DiscordComponentRoleSelect = class extends RoleSelectMenu {
	constructor(ctx) {
		super();
		this.customId = "__openclaw_discord_component_role_select_wildcard__";
		this.customIdParser = parseDiscordComponentCustomIdForCarbon;
		this.ctx = ctx;
	}
	async run(interaction, data) {
		await handleDiscordComponentEvent({
			ctx: this.ctx,
			interaction,
			data,
			componentLabel: "role select",
			label: "discord component role select",
			values: interaction.values ?? []
		});
	}
};
var DiscordComponentMentionableSelect = class extends MentionableSelectMenu {
	constructor(ctx) {
		super();
		this.customId = "__openclaw_discord_component_mentionable_select_wildcard__";
		this.customIdParser = parseDiscordComponentCustomIdForCarbon;
		this.ctx = ctx;
	}
	async run(interaction, data) {
		await handleDiscordComponentEvent({
			ctx: this.ctx,
			interaction,
			data,
			componentLabel: "mentionable select",
			label: "discord component mentionable select",
			values: interaction.values ?? []
		});
	}
};
var DiscordComponentChannelSelect = class extends ChannelSelectMenu {
	constructor(ctx) {
		super();
		this.customId = "__openclaw_discord_component_channel_select_wildcard__";
		this.customIdParser = parseDiscordComponentCustomIdForCarbon;
		this.ctx = ctx;
	}
	async run(interaction, data) {
		await handleDiscordComponentEvent({
			ctx: this.ctx,
			interaction,
			data,
			componentLabel: "channel select",
			label: "discord component channel select",
			values: interaction.values ?? []
		});
	}
};
var DiscordComponentModal = class extends Modal {
	constructor(ctx) {
		super();
		this.title = "OpenClaw form";
		this.customId = "__openclaw_discord_component_modal_wildcard__";
		this.components = [];
		this.customIdParser = parseDiscordModalCustomIdForCarbon;
		this.ctx = ctx;
	}
	async run(interaction, data) {
		const modalId = parseDiscordModalId(data, resolveInteractionCustomId(interaction));
		if (!modalId) {
			logError("discord component modal: missing modal id");
			try {
				await interaction.reply({
					content: "This form is no longer valid.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		const modalEntry = resolveDiscordModalEntry({
			id: modalId,
			consume: false
		});
		if (!modalEntry) {
			try {
				await interaction.reply({
					content: "This form has expired.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		const interactionCtx = await resolveInteractionContextWithDmAuth({
			ctx: this.ctx,
			interaction,
			label: "discord component modal",
			componentLabel: "form",
			defer: false
		});
		if (!interactionCtx) return;
		const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
		const guildInfo = resolveDiscordGuildEntry({
			guild: interaction.guild ?? void 0,
			guildId: rawGuildId,
			guildEntries: this.ctx.guildEntries
		});
		const channelCtx = resolveDiscordChannelContext(interaction);
		const allowNameMatching = isDangerousNameMatchingEnabled(this.ctx.discordConfig);
		const channelConfig = resolveDiscordChannelConfigWithFallback({
			guildInfo,
			channelId,
			channelName: channelCtx.channelName,
			channelSlug: channelCtx.channelSlug,
			parentId: channelCtx.parentId,
			parentName: channelCtx.parentName,
			parentSlug: channelCtx.parentSlug,
			scope: channelCtx.isThread ? "thread" : "channel"
		});
		if (!await ensureGuildComponentMemberAllowed({
			interaction,
			guildInfo,
			channelId,
			rawGuildId,
			channelCtx,
			memberRoleIds,
			user,
			replyOpts,
			componentLabel: "form",
			unauthorizedReply: "You are not authorized to use this form.",
			allowNameMatching
		})) return;
		if (!await ensureComponentUserAllowed({
			entry: {
				id: modalEntry.id,
				kind: "button",
				label: modalEntry.title,
				allowedUsers: modalEntry.allowedUsers
			},
			interaction,
			user,
			replyOpts,
			componentLabel: "form",
			unauthorizedReply: "You are not authorized to use this form.",
			allowNameMatching
		})) return;
		const commandAuthorized = resolveComponentCommandAuthorized({
			ctx: this.ctx,
			interactionCtx,
			channelConfig,
			guildInfo,
			allowNameMatching
		});
		const consumed = resolveDiscordModalEntry({
			id: modalId,
			consume: !modalEntry.reusable
		});
		if (!consumed) {
			try {
				await interaction.reply({
					content: "This form has expired.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		if (consumed.callbackData) {
			const fields = consumed.fields.map((field) => ({
				id: field.id,
				name: field.name,
				values: resolveModalFieldValues(field, interaction)
			}));
			if (await dispatchPluginDiscordInteractiveEvent({
				ctx: this.ctx,
				interaction,
				interactionCtx,
				channelCtx,
				isAuthorizedSender: commandAuthorized,
				data: consumed.callbackData,
				kind: "modal",
				fields,
				messageId: consumed.messageId
			}) === "handled") return;
		}
		try {
			await interaction.acknowledge();
		} catch (err) {
			logError(`discord component modal: failed to acknowledge: ${String(err)}`);
		}
		const eventText = formatModalSubmissionText(consumed, interaction);
		await dispatchDiscordComponentEvent({
			ctx: this.ctx,
			interaction,
			interactionCtx,
			channelCtx,
			guildInfo,
			eventText,
			replyToId: consumed.messageId,
			routeOverrides: {
				sessionKey: consumed.sessionKey,
				agentId: consumed.agentId,
				accountId: consumed.accountId
			}
		});
	}
};
function createAgentComponentButton(ctx) {
	return new AgentComponentButton(ctx);
}
function createAgentSelectMenu(ctx) {
	return new AgentSelectMenu(ctx);
}
function createDiscordComponentButton(ctx) {
	return new DiscordComponentButton(ctx);
}
function createDiscordComponentStringSelect(ctx) {
	return new DiscordComponentStringSelect(ctx);
}
function createDiscordComponentUserSelect(ctx) {
	return new DiscordComponentUserSelect(ctx);
}
function createDiscordComponentRoleSelect(ctx) {
	return new DiscordComponentRoleSelect(ctx);
}
function createDiscordComponentMentionableSelect(ctx) {
	return new DiscordComponentMentionableSelect(ctx);
}
function createDiscordComponentChannelSelect(ctx) {
	return new DiscordComponentChannelSelect(ctx);
}
function createDiscordComponentModal(ctx) {
	return new DiscordComponentModal(ctx);
}
//#endregion
//#region extensions/discord/src/monitor/presence.ts
const DEFAULT_CUSTOM_ACTIVITY_TYPE$1 = 4;
const CUSTOM_STATUS_NAME$1 = "Custom Status";
function resolveDiscordPresenceUpdate(config) {
	const activityText = typeof config.activity === "string" ? config.activity.trim() : "";
	const status = typeof config.status === "string" ? config.status.trim() : "";
	const activityType = config.activityType;
	const activityUrl = typeof config.activityUrl === "string" ? config.activityUrl.trim() : "";
	const hasActivity = Boolean(activityText);
	if (!hasActivity && !Boolean(status)) return {
		since: null,
		activities: [],
		status: "online",
		afk: false
	};
	const activities = [];
	if (hasActivity) {
		const resolvedType = activityType ?? DEFAULT_CUSTOM_ACTIVITY_TYPE$1;
		const activity = resolvedType === DEFAULT_CUSTOM_ACTIVITY_TYPE$1 ? {
			name: CUSTOM_STATUS_NAME$1,
			type: resolvedType,
			state: activityText
		} : {
			name: activityText,
			type: resolvedType
		};
		if (resolvedType === 1 && activityUrl) activity.url = activityUrl;
		activities.push(activity);
	}
	return {
		since: null,
		activities,
		status: status || "online",
		afk: false
	};
}
//#endregion
//#region extensions/discord/src/monitor/auto-presence.ts
init_globals();
const DEFAULT_CUSTOM_ACTIVITY_TYPE = 4;
const CUSTOM_STATUS_NAME = "Custom Status";
const DEFAULT_INTERVAL_MS = 3e4;
const DEFAULT_MIN_UPDATE_INTERVAL_MS = 15e3;
const MIN_INTERVAL_MS = 5e3;
const MIN_UPDATE_INTERVAL_MS = 1e3;
function normalizeOptionalText(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function clampPositiveInt(value, fallback, minValue) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	if (rounded <= 0) return fallback;
	return Math.max(minValue, rounded);
}
function resolveAutoPresenceConfig(config) {
	const intervalMs = clampPositiveInt(config?.intervalMs, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);
	const minUpdateIntervalMs = clampPositiveInt(config?.minUpdateIntervalMs, DEFAULT_MIN_UPDATE_INTERVAL_MS, MIN_UPDATE_INTERVAL_MS);
	return {
		enabled: config?.enabled === true,
		intervalMs,
		minUpdateIntervalMs,
		healthyText: normalizeOptionalText(config?.healthyText),
		degradedText: normalizeOptionalText(config?.degradedText),
		exhaustedText: normalizeOptionalText(config?.exhaustedText)
	};
}
function buildCustomStatusActivity(text) {
	return {
		name: CUSTOM_STATUS_NAME,
		type: DEFAULT_CUSTOM_ACTIVITY_TYPE,
		state: text
	};
}
function renderTemplate(template, vars) {
	const rendered = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_full, key) => vars[key] ?? "").replace(/\s+/g, " ").trim();
	return rendered.length > 0 ? rendered : void 0;
}
function isExhaustedUnavailableReason(reason) {
	if (!reason) return false;
	return reason === "rate_limit" || reason === "overloaded" || reason === "billing" || reason === "auth" || reason === "auth_permanent";
}
function formatUnavailableReason(reason) {
	if (!reason) return "unknown";
	return reason.replace(/_/g, " ");
}
function resolveAuthAvailability(params) {
	const profileIds = Object.keys(params.store.profiles);
	if (profileIds.length === 0) return {
		state: "degraded",
		unavailableReason: null
	};
	clearExpiredCooldowns(params.store, params.now);
	if (profileIds.some((profileId) => !isProfileInCooldown(params.store, profileId, params.now))) return {
		state: "healthy",
		unavailableReason: null
	};
	const unavailableReason = resolveProfilesUnavailableReason({
		store: params.store,
		profileIds,
		now: params.now
	});
	if (isExhaustedUnavailableReason(unavailableReason)) return {
		state: "exhausted",
		unavailableReason
	};
	return {
		state: "degraded",
		unavailableReason
	};
}
function resolvePresenceActivities(params) {
	const reasonLabel = formatUnavailableReason(params.unavailableReason ?? null);
	if (params.state === "healthy") {
		if (params.cfg.healthyText) return [buildCustomStatusActivity(params.cfg.healthyText)];
		return params.basePresence?.activities ?? [];
	}
	if (params.state === "degraded") {
		const text = renderTemplate(params.cfg.degradedText ?? "runtime degraded", { reason: reasonLabel });
		return text ? [buildCustomStatusActivity(text)] : [];
	}
	const defaultTemplate = isExhaustedUnavailableReason(params.unavailableReason ?? null) ? "token exhausted" : "model unavailable ({reason})";
	const text = renderTemplate(params.cfg.exhaustedText ?? defaultTemplate, { reason: reasonLabel });
	return text ? [buildCustomStatusActivity(text)] : [];
}
function resolvePresenceStatus(state) {
	if (state === "healthy") return "online";
	if (state === "exhausted") return "dnd";
	return "idle";
}
function resolveDiscordAutoPresenceDecision(params) {
	const autoPresence = resolveAutoPresenceConfig(params.discordConfig.autoPresence);
	if (!autoPresence.enabled) return null;
	const now = params.now ?? Date.now();
	const basePresence = resolveDiscordPresenceUpdate(params.discordConfig);
	const availability = resolveAuthAvailability({
		store: params.authStore,
		now
	});
	const state = params.gatewayConnected ? availability.state : "degraded";
	const unavailableReason = params.gatewayConnected ? availability.unavailableReason : availability.unavailableReason ?? "unknown";
	return {
		state,
		unavailableReason,
		presence: {
			since: null,
			activities: resolvePresenceActivities({
				state,
				cfg: autoPresence,
				basePresence,
				unavailableReason
			}),
			status: resolvePresenceStatus(state),
			afk: false
		}
	};
}
function stablePresenceSignature(payload) {
	return JSON.stringify({
		status: payload.status,
		afk: payload.afk,
		since: payload.since,
		activities: payload.activities.map((activity) => ({
			type: activity.type,
			name: activity.name,
			state: activity.state,
			url: activity.url
		}))
	});
}
function createDiscordAutoPresenceController(params) {
	const autoCfg = resolveAutoPresenceConfig(params.discordConfig.autoPresence);
	if (!autoCfg.enabled) return {
		enabled: false,
		start: () => void 0,
		stop: () => void 0,
		refresh: () => void 0,
		runNow: () => void 0
	};
	const loadAuthStore = params.loadAuthStore ?? (() => ensureAuthProfileStore());
	const now = params.now ?? (() => Date.now());
	const setIntervalFn = params.setIntervalFn ?? setInterval;
	const clearIntervalFn = params.clearIntervalFn ?? clearInterval;
	let timer;
	let lastAppliedSignature = null;
	let lastAppliedAt = 0;
	const runEvaluation = (options) => {
		let decision = null;
		try {
			decision = resolveDiscordAutoPresenceDecision({
				discordConfig: params.discordConfig,
				authStore: loadAuthStore(),
				gatewayConnected: params.gateway.isConnected,
				now: now()
			});
		} catch (err) {
			params.log?.(warn(`discord: auto-presence evaluation failed for account ${params.accountId}: ${String(err)}`));
			return;
		}
		if (!decision || !params.gateway.isConnected) return;
		const forceApply = options?.force === true;
		const ts = now();
		const signature = stablePresenceSignature(decision.presence);
		if (!forceApply && signature === lastAppliedSignature) return;
		if (!forceApply && lastAppliedAt > 0 && ts - lastAppliedAt < autoCfg.minUpdateIntervalMs) return;
		params.gateway.updatePresence(decision.presence);
		lastAppliedSignature = signature;
		lastAppliedAt = ts;
	};
	return {
		enabled: true,
		runNow: () => runEvaluation(),
		refresh: () => runEvaluation({ force: true }),
		start: () => {
			if (timer) return;
			runEvaluation({ force: true });
			timer = setIntervalFn(() => runEvaluation(), autoCfg.intervalMs);
		},
		stop: () => {
			if (!timer) return;
			clearIntervalFn(timer);
			timer = void 0;
		}
	};
}
//#endregion
//#region extensions/discord/src/monitor/commands.ts
function resolveDiscordSlashCommandConfig(raw) {
	return { ephemeral: raw?.ephemeral !== false };
}
//#endregion
//#region extensions/discord/src/ui.ts
const DEFAULT_DISCORD_ACCENT_COLOR = "#5865F2";
function normalizeDiscordAccentColor(raw) {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return null;
	const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
	if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return null;
	return normalized.toUpperCase();
}
function resolveDiscordAccentColor(params) {
	return normalizeDiscordAccentColor(inspectDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).config.ui?.components?.accentColor) ?? DEFAULT_DISCORD_ACCENT_COLOR;
}
var DiscordUiContainer = class extends Container {
	constructor(params) {
		const accentColor = normalizeDiscordAccentColor(params.accentColor) ?? resolveDiscordAccentColor({
			cfg: params.cfg,
			accountId: params.accountId
		});
		super(params.components, {
			accentColor,
			spoiler: params.spoiler
		});
	}
};
//#endregion
//#region extensions/discord/src/monitor/exec-approvals.ts
init_session_key();
const EXEC_APPROVAL_KEY = "execapproval";
/** Extract Discord channel ID from a session key like "agent:main:discord:channel:123456789" */
function extractDiscordChannelId(sessionKey) {
	if (!sessionKey) return null;
	const match = sessionKey.match(/discord:(?:channel|group):(\d+)/);
	return match ? match[1] : null;
}
function buildDiscordApprovalDmRedirectNotice() {
	return { content: getExecApprovalApproverDmNoticeText() };
}
function encodeCustomIdValue(value) {
	return encodeURIComponent(value);
}
function decodeCustomIdValue(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
function buildExecApprovalCustomId(approvalId, action) {
	return [`${EXEC_APPROVAL_KEY}:id=${encodeCustomIdValue(approvalId)}`, `action=${action}`].join(";");
}
function parseExecApprovalData(data) {
	if (!data || typeof data !== "object") return null;
	const coerce = (value) => typeof value === "string" || typeof value === "number" ? String(value) : "";
	const rawId = coerce(data.id);
	const rawAction = coerce(data.action);
	if (!rawId || !rawAction) return null;
	const action = rawAction;
	if (action !== "allow-once" && action !== "allow-always" && action !== "deny") return null;
	return {
		approvalId: decodeCustomIdValue(rawId),
		action
	};
}
var ExecApprovalContainer = class extends DiscordUiContainer {
	constructor(params) {
		const components = [new TextDisplay(`## ${params.title}`)];
		if (params.description) components.push(new TextDisplay(params.description));
		components.push(new Separator({
			divider: true,
			spacing: "small"
		}));
		components.push(new TextDisplay(`### Command\n\`\`\`\n${params.commandPreview}\n\`\`\``));
		if (params.commandSecondaryPreview) components.push(new TextDisplay(`### Shell Preview\n\`\`\`\n${params.commandSecondaryPreview}\n\`\`\``));
		if (params.metadataLines?.length) components.push(new TextDisplay(params.metadataLines.join("\n")));
		if (params.actionRow) components.push(params.actionRow);
		if (params.footer) {
			components.push(new Separator({
				divider: false,
				spacing: "small"
			}));
			components.push(new TextDisplay(`-# ${params.footer}`));
		}
		super({
			cfg: params.cfg,
			accountId: params.accountId,
			components,
			accentColor: params.accentColor
		});
	}
};
var ExecApprovalActionButton = class extends Button {
	constructor(params) {
		super();
		this.customId = buildExecApprovalCustomId(params.approvalId, params.action);
		this.label = params.label;
		this.style = params.style;
	}
};
var ExecApprovalActionRow = class extends Row {
	constructor(approvalId) {
		super([
			new ExecApprovalActionButton({
				approvalId,
				action: "allow-once",
				label: "Allow once",
				style: ButtonStyle.Success
			}),
			new ExecApprovalActionButton({
				approvalId,
				action: "allow-always",
				label: "Always allow",
				style: ButtonStyle.Primary
			}),
			new ExecApprovalActionButton({
				approvalId,
				action: "deny",
				label: "Deny",
				style: ButtonStyle.Danger
			})
		]);
	}
};
function resolveExecApprovalAccountId(params) {
	const sessionKey = params.request.request.sessionKey?.trim();
	if (!sessionKey) return null;
	try {
		const agentId = resolveAgentIdFromSessionKey(sessionKey);
		const entry = loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId }))[sessionKey];
		const channel = normalizeMessageChannel(entry?.origin?.provider ?? entry?.lastChannel);
		if (channel && channel !== "discord") return null;
		return (entry?.origin?.accountId ?? entry?.lastAccountId)?.trim() || null;
	} catch {
		return null;
	}
}
function buildExecApprovalMetadataLines(request) {
	const lines = [];
	if (request.request.cwd) lines.push(`- Working Directory: ${request.request.cwd}`);
	if (request.request.host) lines.push(`- Host: ${request.request.host}`);
	if (Array.isArray(request.request.envKeys) && request.request.envKeys.length > 0) lines.push(`- Env Overrides: ${request.request.envKeys.join(", ")}`);
	if (request.request.agentId) lines.push(`- Agent: ${request.request.agentId}`);
	return lines;
}
function buildExecApprovalPayload(container) {
	return { components: [container] };
}
function formatCommandPreview(commandText, maxChars) {
	return (commandText.length > maxChars ? `${commandText.slice(0, maxChars)}...` : commandText).replace(/`/g, "​`");
}
function formatOptionalCommandPreview(commandText, maxChars) {
	if (!commandText) return null;
	return formatCommandPreview(commandText, maxChars);
}
function resolveExecApprovalPreviews(request, maxChars, secondaryMaxChars) {
	const { commandText, commandPreview: secondaryPreview } = resolveExecApprovalCommandDisplay(request);
	return {
		commandPreview: formatCommandPreview(commandText, maxChars),
		commandSecondaryPreview: formatOptionalCommandPreview(secondaryPreview, secondaryMaxChars)
	};
}
function createExecApprovalRequestContainer(params) {
	const { commandPreview, commandSecondaryPreview } = resolveExecApprovalPreviews(params.request.request, 1e3, 500);
	const expiresAtSeconds = Math.max(0, Math.floor(params.request.expiresAtMs / 1e3));
	return new ExecApprovalContainer({
		cfg: params.cfg,
		accountId: params.accountId,
		title: "Exec Approval Required",
		description: "A command needs your approval.",
		commandPreview,
		commandSecondaryPreview,
		metadataLines: buildExecApprovalMetadataLines(params.request),
		actionRow: params.actionRow,
		footer: `Expires <t:${expiresAtSeconds}:R> · ID: ${params.request.id}`,
		accentColor: "#FFA500"
	});
}
function createResolvedContainer(params) {
	const { commandPreview, commandSecondaryPreview } = resolveExecApprovalPreviews(params.request.request, 500, 300);
	const decisionLabel = params.decision === "allow-once" ? "Allowed (once)" : params.decision === "allow-always" ? "Allowed (always)" : "Denied";
	const accentColor = params.decision === "deny" ? "#ED4245" : params.decision === "allow-always" ? "#5865F2" : "#57F287";
	return new ExecApprovalContainer({
		cfg: params.cfg,
		accountId: params.accountId,
		title: `Exec Approval: ${decisionLabel}`,
		description: params.resolvedBy ? `Resolved by ${params.resolvedBy}` : "Resolved",
		commandPreview,
		commandSecondaryPreview,
		footer: `ID: ${params.request.id}`,
		accentColor
	});
}
function createExpiredContainer(params) {
	const { commandPreview, commandSecondaryPreview } = resolveExecApprovalPreviews(params.request.request, 500, 300);
	return new ExecApprovalContainer({
		cfg: params.cfg,
		accountId: params.accountId,
		title: "Exec Approval: Expired",
		description: "This approval request has expired.",
		commandPreview,
		commandSecondaryPreview,
		footer: `ID: ${params.request.id}`,
		accentColor: "#99AAB5"
	});
}
var DiscordExecApprovalHandler = class {
	constructor(opts) {
		this.gatewayClient = null;
		this.pending = /* @__PURE__ */ new Map();
		this.requestCache = /* @__PURE__ */ new Map();
		this.started = false;
		this.opts = opts;
	}
	shouldHandle(request) {
		const config = this.opts.config;
		if (!config.enabled) return false;
		if (!config.approvers || config.approvers.length === 0) return false;
		const requestAccountId = resolveExecApprovalAccountId({
			cfg: this.opts.cfg,
			request
		});
		if (requestAccountId) {
			const handlerAccountId = normalizeAccountId(this.opts.accountId);
			if (normalizeAccountId(requestAccountId) !== handlerAccountId) return false;
		}
		if (config.agentFilter?.length) {
			if (!request.request.agentId) return false;
			if (!config.agentFilter.includes(request.request.agentId)) return false;
		}
		if (config.sessionFilter?.length) {
			const session = request.request.sessionKey;
			if (!session) return false;
			if (!config.sessionFilter.some((p) => {
				if (session.includes(p)) return true;
				const regex = compileSafeRegex(p);
				return regex ? testRegexWithBoundedInput(regex, session) : false;
			})) return false;
		}
		return true;
	}
	async start() {
		if (this.started) return;
		this.started = true;
		const config = this.opts.config;
		if (!config.enabled) {
			logDebug("discord exec approvals: disabled");
			return;
		}
		if (!config.approvers || config.approvers.length === 0) {
			logDebug("discord exec approvals: no approvers configured");
			return;
		}
		logDebug("discord exec approvals: starting handler");
		this.gatewayClient = await createOperatorApprovalsGatewayClient({
			config: this.opts.cfg,
			gatewayUrl: this.opts.gatewayUrl,
			clientDisplayName: "Discord Exec Approvals",
			onEvent: (evt) => this.handleGatewayEvent(evt),
			onHelloOk: () => {
				logDebug("discord exec approvals: connected to gateway");
			},
			onConnectError: (err) => {
				logError(`discord exec approvals: connect error: ${err.message}`);
			},
			onClose: (code, reason) => {
				logDebug(`discord exec approvals: gateway closed: ${code} ${reason}`);
			}
		});
		this.gatewayClient.start();
	}
	async stop() {
		if (!this.started) return;
		this.started = false;
		for (const pending of this.pending.values()) clearTimeout(pending.timeoutId);
		this.pending.clear();
		this.requestCache.clear();
		this.gatewayClient?.stop();
		this.gatewayClient = null;
		logDebug("discord exec approvals: stopped");
	}
	handleGatewayEvent(evt) {
		if (evt.event === "exec.approval.requested") {
			const request = evt.payload;
			this.handleApprovalRequested(request);
		} else if (evt.event === "exec.approval.resolved") {
			const resolved = evt.payload;
			this.handleApprovalResolved(resolved);
		}
	}
	async handleApprovalRequested(request) {
		if (!this.shouldHandle(request)) return;
		logDebug(`discord exec approvals: received request ${request.id}`);
		this.requestCache.set(request.id, request);
		const { rest, request: discordRequest } = createDiscordClient({
			token: this.opts.token,
			accountId: this.opts.accountId
		}, this.opts.cfg);
		const actionRow = new ExecApprovalActionRow(request.id);
		const body = stripUndefinedFields(serializePayload(buildExecApprovalPayload(createExecApprovalRequestContainer({
			request,
			cfg: this.opts.cfg,
			accountId: this.opts.accountId,
			actionRow
		}))));
		const target = this.opts.config.target ?? "dm";
		const sendToDm = target === "dm" || target === "both";
		const sendToChannel = target === "channel" || target === "both";
		let fallbackToDm = false;
		const originatingChannelId = request.request.sessionKey && target === "dm" ? extractDiscordChannelId(request.request.sessionKey) : null;
		if (target === "dm" && originatingChannelId) try {
			await discordRequest(() => rest.post(Routes.channelMessages(originatingChannelId), { body: buildDiscordApprovalDmRedirectNotice() }), "send-approval-dm-redirect-notice");
		} catch (err) {
			logError(`discord exec approvals: failed to send DM redirect notice: ${String(err)}`);
		}
		if (sendToChannel) {
			const channelId = extractDiscordChannelId(request.request.sessionKey);
			if (channelId) try {
				const message = await discordRequest(() => rest.post(Routes.channelMessages(channelId), { body }), "send-approval-channel");
				if (message?.id) {
					const timeoutMs = Math.max(0, request.expiresAtMs - Date.now());
					const timeoutId = setTimeout(() => {
						this.handleApprovalTimeout(request.id, "channel");
					}, timeoutMs);
					this.pending.set(`${request.id}:channel`, {
						discordMessageId: message.id,
						discordChannelId: channelId,
						timeoutId
					});
					logDebug(`discord exec approvals: sent approval ${request.id} to channel ${channelId}`);
				}
			} catch (err) {
				logError(`discord exec approvals: failed to send to channel: ${String(err)}`);
			}
			else if (!sendToDm) {
				logError(`discord exec approvals: target is "channel" but could not extract channel id from session key "${request.request.sessionKey ?? "(none)"}" — falling back to DM delivery for approval ${request.id}`);
				fallbackToDm = true;
			} else logDebug("discord exec approvals: could not extract channel id from session key");
		}
		if (sendToDm || fallbackToDm) {
			const approvers = this.opts.config.approvers ?? [];
			for (const approver of approvers) {
				const userId = String(approver);
				try {
					const dmChannel = await discordRequest(() => rest.post(Routes.userChannels(), { body: { recipient_id: userId } }), "dm-channel");
					if (!dmChannel?.id) {
						logError(`discord exec approvals: failed to create DM for user ${userId}`);
						continue;
					}
					const message = await discordRequest(() => rest.post(Routes.channelMessages(dmChannel.id), { body }), "send-approval");
					if (!message?.id) {
						logError(`discord exec approvals: failed to send message to user ${userId}`);
						continue;
					}
					const existingDm = this.pending.get(`${request.id}:dm`);
					if (existingDm) clearTimeout(existingDm.timeoutId);
					const timeoutMs = Math.max(0, request.expiresAtMs - Date.now());
					const timeoutId = setTimeout(() => {
						this.handleApprovalTimeout(request.id, "dm");
					}, timeoutMs);
					this.pending.set(`${request.id}:dm`, {
						discordMessageId: message.id,
						discordChannelId: dmChannel.id,
						timeoutId
					});
					logDebug(`discord exec approvals: sent approval ${request.id} to user ${userId}`);
				} catch (err) {
					logError(`discord exec approvals: failed to notify user ${userId}: ${String(err)}`);
				}
			}
		}
	}
	async handleApprovalResolved(resolved) {
		const request = this.requestCache.get(resolved.id);
		this.requestCache.delete(resolved.id);
		if (!request) return;
		logDebug(`discord exec approvals: resolved ${resolved.id} with ${resolved.decision}`);
		const container = createResolvedContainer({
			request,
			decision: resolved.decision,
			resolvedBy: resolved.resolvedBy,
			cfg: this.opts.cfg,
			accountId: this.opts.accountId
		});
		for (const suffix of [
			":channel",
			":dm",
			""
		]) {
			const key = `${resolved.id}${suffix}`;
			const pending = this.pending.get(key);
			if (!pending) continue;
			clearTimeout(pending.timeoutId);
			this.pending.delete(key);
			await this.finalizeMessage(pending.discordChannelId, pending.discordMessageId, container);
		}
	}
	async handleApprovalTimeout(approvalId, source) {
		const key = source ? `${approvalId}:${source}` : approvalId;
		const pending = this.pending.get(key);
		if (!pending) return;
		this.pending.delete(key);
		const request = this.requestCache.get(approvalId);
		if (!(this.pending.has(`${approvalId}:channel`) || this.pending.has(`${approvalId}:dm`) || this.pending.has(approvalId))) this.requestCache.delete(approvalId);
		if (!request) return;
		logDebug(`discord exec approvals: timeout for ${approvalId} (${source ?? "default"})`);
		const container = createExpiredContainer({
			request,
			cfg: this.opts.cfg,
			accountId: this.opts.accountId
		});
		await this.finalizeMessage(pending.discordChannelId, pending.discordMessageId, container);
	}
	async finalizeMessage(channelId, messageId, container) {
		if (!this.opts.config.cleanupAfterResolve) {
			await this.updateMessage(channelId, messageId, container);
			return;
		}
		try {
			const { rest, request: discordRequest } = createDiscordClient({
				token: this.opts.token,
				accountId: this.opts.accountId
			}, this.opts.cfg);
			await discordRequest(() => rest.delete(Routes.channelMessage(channelId, messageId)), "delete-approval");
		} catch (err) {
			logError(`discord exec approvals: failed to delete message: ${String(err)}`);
			await this.updateMessage(channelId, messageId, container);
		}
	}
	async updateMessage(channelId, messageId, container) {
		try {
			const { rest, request: discordRequest } = createDiscordClient({
				token: this.opts.token,
				accountId: this.opts.accountId
			}, this.opts.cfg);
			const payload = buildExecApprovalPayload(container);
			await discordRequest(() => rest.patch(Routes.channelMessage(channelId, messageId), { body: stripUndefinedFields(serializePayload(payload)) }), "update-approval");
		} catch (err) {
			logError(`discord exec approvals: failed to update message: ${String(err)}`);
		}
	}
	async resolveApproval(approvalId, decision) {
		if (!this.gatewayClient) {
			logError("discord exec approvals: gateway client not connected");
			return false;
		}
		logDebug(`discord exec approvals: resolving ${approvalId} with ${decision}`);
		try {
			await this.gatewayClient.request("exec.approval.resolve", {
				id: approvalId,
				decision
			});
			logDebug(`discord exec approvals: resolved ${approvalId} successfully`);
			return true;
		} catch (err) {
			logError(`discord exec approvals: resolve failed: ${String(err)}`);
			return false;
		}
	}
	/** Return the list of configured approver IDs. */
	getApprovers() {
		return this.opts.config.approvers ?? [];
	}
};
var ExecApprovalButton = class extends Button {
	constructor(ctx) {
		super();
		this.label = "execapproval";
		this.customId = `${EXEC_APPROVAL_KEY}:seed=1`;
		this.style = ButtonStyle.Primary;
		this.ctx = ctx;
	}
	async run(interaction, data) {
		const parsed = parseExecApprovalData(data);
		if (!parsed) {
			try {
				await interaction.reply({
					content: "This approval is no longer valid.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		const approvers = this.ctx.handler.getApprovers();
		const userId = interaction.userId;
		if (!approvers.some((id) => String(id) === userId)) {
			try {
				await interaction.reply({
					content: "⛔ You are not authorized to approve exec requests.",
					ephemeral: true
				});
			} catch {}
			return;
		}
		const decisionLabel = parsed.action === "allow-once" ? "Allowed (once)" : parsed.action === "allow-always" ? "Allowed (always)" : "Denied";
		try {
			await interaction.acknowledge();
		} catch {}
		if (!await this.ctx.handler.resolveApproval(parsed.approvalId, parsed.action)) try {
			await interaction.followUp({
				content: `Failed to submit approval decision for **${decisionLabel}**. The request may have expired or already been resolved.`,
				ephemeral: true
			});
		} catch {}
	}
};
function createExecApprovalButton(ctx) {
	return new ExecApprovalButton(ctx);
}
//#endregion
//#region extensions/discord/src/monitor/gateway-error-guard.ts
function attachEarlyGatewayErrorGuard(client) {
	const pendingErrors = [];
	const emitter = getDiscordGatewayEmitter(client.getPlugin("gateway"));
	if (!emitter) return {
		pendingErrors,
		release: () => {}
	};
	let released = false;
	const onGatewayError = (err) => {
		pendingErrors.push(err);
	};
	emitter.on("error", onGatewayError);
	return {
		pendingErrors,
		release: () => {
			if (released) return;
			released = true;
			emitter.removeListener("error", onGatewayError);
		}
	};
}
//#endregion
//#region extensions/discord/src/monitor/gateway-plugin.ts
init_globals();
const DISCORD_GATEWAY_BOT_URL = "https://discord.com/api/v10/gateway/bot";
const DEFAULT_DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/";
function resolveDiscordGatewayIntents(intentsConfig) {
	let intents = GatewayIntents.Guilds | GatewayIntents.GuildMessages | GatewayIntents.MessageContent | GatewayIntents.DirectMessages | GatewayIntents.GuildMessageReactions | GatewayIntents.DirectMessageReactions | GatewayIntents.GuildVoiceStates;
	if (intentsConfig?.presence) intents |= GatewayIntents.GuildPresences;
	if (intentsConfig?.guildMembers) intents |= GatewayIntents.GuildMembers;
	return intents;
}
function summarizeGatewayResponseBody(body) {
	const normalized = body.trim().replace(/\s+/g, " ");
	if (!normalized) return "<empty>";
	return normalized.slice(0, 240);
}
function isTransientDiscordGatewayResponse(status, body) {
	if (status >= 500) return true;
	const normalized = body.toLowerCase();
	return normalized.includes("upstream connect error") || normalized.includes("disconnect/reset before headers") || normalized.includes("reset reason:");
}
function createGatewayMetadataError(params) {
	if (params.transient) return new Error("Failed to get gateway information from Discord: fetch failed", { cause: params.cause ?? new Error(params.detail) });
	return new Error(`Failed to get gateway information from Discord: ${params.detail}`, { cause: params.cause });
}
async function fetchDiscordGatewayInfo(params) {
	let response;
	try {
		response = await params.fetchImpl(DISCORD_GATEWAY_BOT_URL, {
			...params.fetchInit,
			headers: {
				...params.fetchInit?.headers,
				Authorization: `Bot ${params.token}`
			}
		});
	} catch (error) {
		throw createGatewayMetadataError({
			detail: error instanceof Error ? error.message : String(error),
			transient: true,
			cause: error
		});
	}
	let body;
	try {
		body = await response.text();
	} catch (error) {
		throw createGatewayMetadataError({
			detail: error instanceof Error ? error.message : String(error),
			transient: true,
			cause: error
		});
	}
	const summary = summarizeGatewayResponseBody(body);
	const transient = isTransientDiscordGatewayResponse(response.status, body);
	if (!response.ok) throw createGatewayMetadataError({
		detail: `Discord API /gateway/bot failed (${response.status}): ${summary}`,
		transient
	});
	try {
		const parsed = JSON.parse(body);
		return {
			...parsed,
			url: typeof parsed.url === "string" && parsed.url.trim() ? parsed.url : DEFAULT_DISCORD_GATEWAY_URL
		};
	} catch (error) {
		throw createGatewayMetadataError({
			detail: `Discord API /gateway/bot returned invalid JSON: ${summary}`,
			transient,
			cause: error
		});
	}
}
function createGatewayPlugin(params) {
	class SafeGatewayPlugin extends GatewayPlugin {
		constructor() {
			super(params.options);
		}
		async registerClient(client) {
			if (!this.gatewayInfo) this.gatewayInfo = await fetchDiscordGatewayInfo({
				token: client.options.token,
				fetchImpl: params.fetchImpl,
				fetchInit: params.fetchInit
			});
			return super.registerClient(client);
		}
		createWebSocket(url) {
			if (!params.wsAgent) return super.createWebSocket(url);
			return new WebSocket$1(url, { agent: params.wsAgent });
		}
	}
	return new SafeGatewayPlugin();
}
function createDiscordGatewayPlugin(params) {
	const intents = resolveDiscordGatewayIntents(params.discordConfig?.intents);
	const proxy = params.discordConfig?.proxy?.trim();
	const options = {
		reconnect: { maxAttempts: 50 },
		intents,
		autoInteractions: true
	};
	if (!proxy) return createGatewayPlugin({
		options,
		fetchImpl: (input, init) => fetch(input, init)
	});
	try {
		const wsAgent = new HttpsProxyAgent(proxy);
		const fetchAgent = new ProxyAgent(proxy);
		params.runtime.log?.("discord: gateway proxy enabled");
		return createGatewayPlugin({
			options,
			fetchImpl: (input, init) => fetch$1(input, init),
			fetchInit: { dispatcher: fetchAgent },
			wsAgent
		});
	} catch (err) {
		params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));
		return createGatewayPlugin({
			options,
			fetchImpl: (input, init) => fetch(input, init)
		});
	}
}
//#endregion
//#region extensions/discord/src/monitor/provider.allowlist.ts
function formatResolutionLogDetails(base, details) {
	const nonEmpty = details.map((value) => value?.trim()).filter((value) => Boolean(value));
	return nonEmpty.length > 0 ? `${base} (${nonEmpty.join("; ")})` : base;
}
function formatDiscordChannelResolved(entry) {
	const target = entry.channelId ? `${entry.guildId}/${entry.channelId}` : entry.guildId;
	return formatResolutionLogDetails(`${entry.input}→${target}`, [
		entry.guildName ? `guild:${entry.guildName}` : void 0,
		entry.channelName ? `channel:${entry.channelName}` : void 0,
		entry.note
	]);
}
function formatDiscordChannelUnresolved(entry) {
	return formatResolutionLogDetails(entry.input, [
		entry.guildName ? `guild:${entry.guildName}` : entry.guildId ? `guildId:${entry.guildId}` : void 0,
		entry.channelName ? `channel:${entry.channelName}` : entry.channelId ? `channelId:${entry.channelId}` : void 0,
		entry.note
	]);
}
function formatDiscordUserResolved(entry) {
	const displayName = entry.name?.trim();
	const target = displayName || entry.id;
	return formatResolutionLogDetails(`${entry.input}→${target}`, [
		displayName && entry.id ? `id:${entry.id}` : void 0,
		entry.guildName ? `guild:${entry.guildName}` : void 0,
		entry.note
	]);
}
function formatDiscordUserUnresolved(entry) {
	return formatResolutionLogDetails(entry.input, [
		entry.name ? `name:${entry.name}` : void 0,
		entry.guildName ? `guild:${entry.guildName}` : void 0,
		entry.note
	]);
}
function toGuildEntries(value) {
	if (!value || typeof value !== "object") return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!entry || typeof entry !== "object") continue;
		out[key] = entry;
	}
	return out;
}
function toAllowlistEntries(value) {
	if (!Array.isArray(value)) return;
	return value.map((entry) => String(entry).trim()).filter((entry) => Boolean(entry));
}
function hasGuildEntries(value) {
	return Object.keys(value).length > 0;
}
function collectChannelResolutionInputs(guildEntries) {
	const entries = [];
	for (const [guildKey, guildCfg] of Object.entries(guildEntries)) {
		if (guildKey === "*") continue;
		const channels = guildCfg?.channels ?? {};
		const channelKeys = Object.keys(channels).filter((key) => key !== "*");
		if (channelKeys.length === 0) {
			const input = /^\d+$/.test(guildKey) ? `guild:${guildKey}` : guildKey;
			entries.push({
				input,
				guildKey
			});
			continue;
		}
		for (const channelKey of channelKeys) entries.push({
			input: `${guildKey}/${channelKey}`,
			guildKey,
			channelKey
		});
	}
	return entries;
}
async function resolveGuildEntriesByChannelAllowlist(params) {
	const entries = collectChannelResolutionInputs(params.guildEntries);
	if (entries.length === 0) return params.guildEntries;
	try {
		const resolved = await resolveDiscordChannelAllowlist({
			token: params.token,
			entries: entries.map((entry) => entry.input),
			fetcher: params.fetcher
		});
		const sourceByInput = new Map(entries.map((entry) => [entry.input, entry]));
		const nextGuilds = { ...params.guildEntries };
		const mapping = [];
		const unresolved = [];
		for (const entry of resolved) {
			const source = sourceByInput.get(entry.input);
			if (!source) continue;
			const sourceGuild = params.guildEntries[source.guildKey] ?? {};
			if (!entry.resolved || !entry.guildId) {
				unresolved.push(formatDiscordChannelUnresolved(entry));
				continue;
			}
			mapping.push(formatDiscordChannelResolved(entry));
			const existing = nextGuilds[entry.guildId] ?? {};
			const mergedChannels = {
				...sourceGuild.channels,
				...existing.channels
			};
			const mergedGuild = {
				...sourceGuild,
				...existing,
				channels: mergedChannels
			};
			nextGuilds[entry.guildId] = mergedGuild;
			if (source.channelKey && entry.channelId) {
				const sourceChannel = sourceGuild.channels?.[source.channelKey];
				if (sourceChannel) nextGuilds[entry.guildId] = {
					...mergedGuild,
					channels: {
						...mergedChannels,
						[entry.channelId]: {
							...sourceChannel,
							...mergedChannels[entry.channelId]
						}
					}
				};
			}
		}
		summarizeMapping("discord channels", mapping, unresolved, params.runtime);
		return nextGuilds;
	} catch (err) {
		params.runtime.log?.(`discord channel resolve failed; using config entries. ${formatErrorMessage(err)}`);
		return params.guildEntries;
	}
}
async function resolveAllowFromByUserAllowlist(params) {
	const allowEntries = normalizeStringEntries(params.allowFrom).filter((entry) => entry !== "*");
	if (allowEntries.length === 0) return params.allowFrom;
	try {
		const { resolvedMap, mapping, unresolved } = buildAllowlistResolutionSummary(await resolveDiscordUserAllowlist({
			token: params.token,
			entries: allowEntries,
			fetcher: params.fetcher
		}), {
			formatResolved: formatDiscordUserResolved,
			formatUnresolved: formatDiscordUserUnresolved
		});
		const allowFrom = canonicalizeAllowlistWithResolvedIds({
			existing: params.allowFrom,
			resolvedMap
		});
		summarizeMapping("discord users", mapping, unresolved, params.runtime);
		return allowFrom;
	} catch (err) {
		params.runtime.log?.(`discord user resolve failed; using config entries. ${formatErrorMessage(err)}`);
		return params.allowFrom;
	}
}
function collectGuildUserEntries(guildEntries) {
	const userEntries = /* @__PURE__ */ new Set();
	for (const guild of Object.values(guildEntries)) {
		if (!guild || typeof guild !== "object") continue;
		addAllowlistUserEntriesFromConfigEntry(userEntries, guild);
		const channels = guild.channels ?? {};
		for (const channel of Object.values(channels)) addAllowlistUserEntriesFromConfigEntry(userEntries, channel);
	}
	return userEntries;
}
async function resolveGuildEntriesByUserAllowlist(params) {
	const userEntries = collectGuildUserEntries(params.guildEntries);
	if (userEntries.size === 0) return params.guildEntries;
	try {
		const { resolvedMap, mapping, unresolved } = buildAllowlistResolutionSummary(await resolveDiscordUserAllowlist({
			token: params.token,
			entries: Array.from(userEntries),
			fetcher: params.fetcher
		}), {
			formatResolved: formatDiscordUserResolved,
			formatUnresolved: formatDiscordUserUnresolved
		});
		const nextGuilds = { ...params.guildEntries };
		for (const [guildKey, guildConfig] of Object.entries(params.guildEntries)) {
			if (!guildConfig || typeof guildConfig !== "object") continue;
			const nextGuild = { ...guildConfig };
			const users = guildConfig.users;
			if (Array.isArray(users) && users.length > 0) nextGuild.users = canonicalizeAllowlistWithResolvedIds({
				existing: users,
				resolvedMap
			});
			const channels = guildConfig.channels ?? {};
			if (channels && typeof channels === "object") nextGuild.channels = patchAllowlistUsersInConfigEntries({
				entries: channels,
				resolvedMap,
				strategy: "canonicalize"
			});
			nextGuilds[guildKey] = nextGuild;
		}
		summarizeMapping("discord channel users", mapping, unresolved, params.runtime);
		return nextGuilds;
	} catch (err) {
		params.runtime.log?.(`discord channel user resolve failed; using config entries. ${formatErrorMessage(err)}`);
		return params.guildEntries;
	}
}
async function resolveDiscordAllowlistConfig(params) {
	let guildEntries = toGuildEntries(params.guildEntries);
	let allowFrom = toAllowlistEntries(params.allowFrom);
	if (hasGuildEntries(guildEntries)) guildEntries = await resolveGuildEntriesByChannelAllowlist({
		token: params.token,
		guildEntries,
		fetcher: params.fetcher,
		runtime: params.runtime
	});
	allowFrom = await resolveAllowFromByUserAllowlist({
		token: params.token,
		allowFrom,
		fetcher: params.fetcher,
		runtime: params.runtime
	});
	if (hasGuildEntries(guildEntries)) guildEntries = await resolveGuildEntriesByUserAllowlist({
		token: params.token,
		guildEntries,
		fetcher: params.fetcher,
		runtime: params.runtime
	});
	return {
		guildEntries: hasGuildEntries(guildEntries) ? guildEntries : void 0,
		allowFrom
	};
}
//#endregion
//#region src/channels/transport/stall-watchdog.ts
function createArmableStallWatchdog(params) {
	const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
	const checkIntervalMs = Math.max(100, Math.floor(params.checkIntervalMs ?? Math.min(5e3, Math.max(250, timeoutMs / 6))));
	let armed = false;
	let stopped = false;
	let lastActivityAt = Date.now();
	let timer = null;
	const clearTimer = () => {
		if (!timer) return;
		clearInterval(timer);
		timer = null;
	};
	const disarm = () => {
		armed = false;
	};
	const stop = () => {
		if (stopped) return;
		stopped = true;
		disarm();
		clearTimer();
		params.abortSignal?.removeEventListener("abort", stop);
	};
	const arm = (atMs) => {
		if (stopped) return;
		lastActivityAt = atMs ?? Date.now();
		armed = true;
	};
	const touch = (atMs) => {
		if (stopped) return;
		lastActivityAt = atMs ?? Date.now();
	};
	const check = () => {
		if (!armed || stopped) return;
		const idleMs = Date.now() - lastActivityAt;
		if (idleMs < timeoutMs) return;
		disarm();
		params.runtime?.error?.(`[${params.label}] transport watchdog timeout: idle ${Math.round(idleMs / 1e3)}s (limit ${Math.round(timeoutMs / 1e3)}s)`);
		params.onTimeout({
			idleMs,
			timeoutMs
		});
	};
	if (params.abortSignal?.aborted) stop();
	else {
		params.abortSignal?.addEventListener("abort", stop, { once: true });
		timer = setInterval(check, checkIntervalMs);
		timer.unref?.();
	}
	return {
		arm,
		touch,
		disarm,
		stop,
		isArmed: () => armed
	};
}
//#endregion
//#region extensions/discord/src/gateway-logging.ts
init_globals();
const INFO_DEBUG_MARKERS = [
	"WebSocket connection closed",
	"Reconnecting with backoff",
	"Attempting resume with backoff"
];
const shouldPromoteGatewayDebug = (message) => INFO_DEBUG_MARKERS.some((marker) => message.includes(marker));
const formatGatewayMetrics = (metrics) => {
	if (metrics === null || metrics === void 0) return String(metrics);
	if (typeof metrics === "string") return metrics;
	if (typeof metrics === "number" || typeof metrics === "boolean" || typeof metrics === "bigint") return String(metrics);
	try {
		return JSON.stringify(metrics);
	} catch {
		return "[unserializable metrics]";
	}
};
function attachDiscordGatewayLogging(params) {
	const { emitter, runtime } = params;
	if (!emitter) return () => {};
	const onGatewayDebug = (msg) => {
		const message = String(msg);
		logVerbose(`discord gateway: ${message}`);
		if (shouldPromoteGatewayDebug(message)) runtime.log?.(`discord gateway: ${message}`);
	};
	const onGatewayWarning = (warning) => {
		logVerbose(`discord gateway warning: ${String(warning)}`);
	};
	const onGatewayMetrics = (metrics) => {
		logVerbose(`discord gateway metrics: ${formatGatewayMetrics(metrics)}`);
	};
	emitter.on("debug", onGatewayDebug);
	emitter.on("warning", onGatewayWarning);
	emitter.on("metrics", onGatewayMetrics);
	return () => {
		emitter.removeListener("debug", onGatewayDebug);
		emitter.removeListener("warning", onGatewayWarning);
		emitter.removeListener("metrics", onGatewayMetrics);
	};
}
//#endregion
//#region extensions/discord/src/monitor/provider.lifecycle.ts
init_globals();
async function runDiscordGatewayLifecycle(params) {
	const HELLO_TIMEOUT_MS = 3e4;
	const HELLO_CONNECTED_POLL_MS = 250;
	const MAX_CONSECUTIVE_HELLO_STALLS = 3;
	const RECONNECT_STALL_TIMEOUT_MS = 5 * 6e4;
	const gateway = params.client.getPlugin("gateway");
	if (gateway) registerGateway(params.accountId, gateway);
	const gatewayEmitter = getDiscordGatewayEmitter(gateway);
	const stopGatewayLogging = attachDiscordGatewayLogging({
		emitter: gatewayEmitter,
		runtime: params.runtime
	});
	let lifecycleStopping = false;
	let forceStopHandler;
	let queuedForceStopError;
	const pushStatus = (patch) => {
		params.statusSink?.(patch);
	};
	const triggerForceStop = (err) => {
		if (forceStopHandler) {
			forceStopHandler(err);
			return;
		}
		queuedForceStopError = err;
	};
	const reconnectStallWatchdog = createArmableStallWatchdog({
		label: `discord:${params.accountId}:reconnect`,
		timeoutMs: RECONNECT_STALL_TIMEOUT_MS,
		abortSignal: params.abortSignal,
		runtime: params.runtime,
		onTimeout: () => {
			if (params.abortSignal?.aborted || lifecycleStopping) return;
			const at = Date.now();
			const error = /* @__PURE__ */ new Error(`discord reconnect watchdog timeout after ${RECONNECT_STALL_TIMEOUT_MS}ms`);
			pushStatus({
				connected: false,
				lastEventAt: at,
				lastDisconnect: {
					at,
					error: error.message
				},
				lastError: error.message
			});
			params.runtime.error?.(danger(`discord: reconnect watchdog timeout after ${RECONNECT_STALL_TIMEOUT_MS}ms; force-stopping monitor task`));
			triggerForceStop(error);
		}
	});
	const onAbort = () => {
		lifecycleStopping = true;
		reconnectStallWatchdog.disarm();
		pushStatus({
			connected: false,
			lastEventAt: Date.now()
		});
		if (!gateway) return;
		gatewayEmitter?.once("error", () => {});
		gateway.options.reconnect = { maxAttempts: 0 };
		gateway.disconnect();
	};
	if (params.abortSignal?.aborted) onAbort();
	else params.abortSignal?.addEventListener("abort", onAbort, { once: true });
	let helloTimeoutId;
	let helloConnectedPollId;
	let consecutiveHelloStalls = 0;
	const clearHelloWatch = () => {
		if (helloTimeoutId) {
			clearTimeout(helloTimeoutId);
			helloTimeoutId = void 0;
		}
		if (helloConnectedPollId) {
			clearInterval(helloConnectedPollId);
			helloConnectedPollId = void 0;
		}
	};
	const resetHelloStallCounter = () => {
		consecutiveHelloStalls = 0;
	};
	const parseGatewayCloseCode = (message) => {
		const match = /code\s+(\d{3,5})/i.exec(message);
		if (!match?.[1]) return;
		const code = Number.parseInt(match[1], 10);
		return Number.isFinite(code) ? code : void 0;
	};
	const clearResumeState = () => {
		const mutableGateway = gateway;
		if (!mutableGateway?.state) return;
		mutableGateway.state.sessionId = null;
		mutableGateway.state.resumeGatewayUrl = null;
		mutableGateway.state.sequence = null;
		mutableGateway.sequence = null;
	};
	const onGatewayDebug = (msg) => {
		const message = String(msg);
		const at = Date.now();
		pushStatus({ lastEventAt: at });
		if (message.includes("WebSocket connection closed")) {
			if (gateway?.isConnected) resetHelloStallCounter();
			reconnectStallWatchdog.arm(at);
			pushStatus({
				connected: false,
				lastDisconnect: {
					at,
					status: parseGatewayCloseCode(message)
				}
			});
			clearHelloWatch();
			return;
		}
		if (!message.includes("WebSocket connection opened")) return;
		reconnectStallWatchdog.disarm();
		clearHelloWatch();
		let sawConnected = gateway?.isConnected === true;
		if (sawConnected) pushStatus({
			...createConnectedChannelStatusPatch(at),
			lastDisconnect: null
		});
		helloConnectedPollId = setInterval(() => {
			if (!gateway?.isConnected) return;
			sawConnected = true;
			resetHelloStallCounter();
			const connectedAt = Date.now();
			reconnectStallWatchdog.disarm();
			pushStatus({
				...createConnectedChannelStatusPatch(connectedAt),
				lastDisconnect: null
			});
			if (helloConnectedPollId) {
				clearInterval(helloConnectedPollId);
				helloConnectedPollId = void 0;
			}
		}, HELLO_CONNECTED_POLL_MS);
		helloTimeoutId = setTimeout(() => {
			if (helloConnectedPollId) {
				clearInterval(helloConnectedPollId);
				helloConnectedPollId = void 0;
			}
			if (sawConnected || gateway?.isConnected) resetHelloStallCounter();
			else {
				consecutiveHelloStalls += 1;
				const forceFreshIdentify = consecutiveHelloStalls >= MAX_CONSECUTIVE_HELLO_STALLS;
				const stalledAt = Date.now();
				reconnectStallWatchdog.arm(stalledAt);
				pushStatus({
					connected: false,
					lastEventAt: stalledAt,
					lastDisconnect: {
						at: stalledAt,
						error: "hello-timeout"
					}
				});
				params.runtime.log?.(danger(forceFreshIdentify ? `connection stalled: no HELLO within ${HELLO_TIMEOUT_MS}ms (${consecutiveHelloStalls}/${MAX_CONSECUTIVE_HELLO_STALLS}); forcing fresh identify` : `connection stalled: no HELLO within ${HELLO_TIMEOUT_MS}ms (${consecutiveHelloStalls}/${MAX_CONSECUTIVE_HELLO_STALLS}); retrying resume`));
				if (forceFreshIdentify) {
					clearResumeState();
					resetHelloStallCounter();
				}
				gateway?.disconnect();
				gateway?.connect(!forceFreshIdentify);
			}
			helloTimeoutId = void 0;
		}, HELLO_TIMEOUT_MS);
	};
	gatewayEmitter?.on("debug", onGatewayDebug);
	if (gateway?.isConnected && !lifecycleStopping) pushStatus({
		...createConnectedChannelStatusPatch(Date.now()),
		lastDisconnect: null
	});
	let sawDisallowedIntents = false;
	const logGatewayError = (err) => {
		if (params.isDisallowedIntentsError(err)) {
			sawDisallowedIntents = true;
			params.runtime.error?.(danger("discord: gateway closed with code 4014 (missing privileged gateway intents). Enable the required intents in the Discord Developer Portal or disable them in config."));
			return;
		}
		params.runtime.error?.(danger(`discord gateway error: ${String(err)}`));
	};
	const shouldStopOnGatewayError = (err) => {
		const message = String(err);
		return message.includes("Max reconnect attempts") || message.includes("Fatal Gateway error") || params.isDisallowedIntentsError(err);
	};
	try {
		if (params.execApprovalsHandler) await params.execApprovalsHandler.start();
		const pendingGatewayErrors = params.pendingGatewayErrors ?? [];
		if (pendingGatewayErrors.length > 0) {
			const queuedErrors = [...pendingGatewayErrors];
			pendingGatewayErrors.length = 0;
			for (const err of queuedErrors) {
				logGatewayError(err);
				if (!shouldStopOnGatewayError(err)) continue;
				if (params.isDisallowedIntentsError(err)) return;
				throw err;
			}
		}
		await waitForDiscordGatewayStop({
			gateway: gateway ? {
				emitter: gatewayEmitter,
				disconnect: () => gateway.disconnect()
			} : void 0,
			abortSignal: params.abortSignal,
			onGatewayError: logGatewayError,
			shouldStopOnError: shouldStopOnGatewayError,
			registerForceStop: (forceStop) => {
				forceStopHandler = forceStop;
				if (queuedForceStopError !== void 0) {
					const queued = queuedForceStopError;
					queuedForceStopError = void 0;
					forceStop(queued);
				}
			}
		});
	} catch (err) {
		if (!sawDisallowedIntents && !params.isDisallowedIntentsError(err)) throw err;
	} finally {
		lifecycleStopping = true;
		params.releaseEarlyGatewayErrorGuard?.();
		unregisterGateway(params.accountId);
		stopGatewayLogging();
		reconnectStallWatchdog.stop();
		clearHelloWatch();
		gatewayEmitter?.removeListener("debug", onGatewayDebug);
		params.abortSignal?.removeEventListener("abort", onAbort);
		if (params.voiceManager) {
			await params.voiceManager.destroy();
			params.voiceManagerRef.current = null;
		}
		if (params.execApprovalsHandler) await params.execApprovalsHandler.stop();
		params.threadBindings.stop();
	}
}
//#endregion
//#region extensions/discord/src/monitor/rest-fetch.ts
init_globals();
init_fetch();
function resolveDiscordRestFetch(proxyUrl, runtime) {
	const proxy = proxyUrl?.trim();
	if (!proxy) return fetch;
	try {
		const agent = new ProxyAgent(proxy);
		const fetcher = ((input, init) => fetch$1(input, {
			...init,
			dispatcher: agent
		}));
		runtime.log?.("discord: rest proxy enabled");
		return wrapFetchWithAbortSignal(fetcher);
	} catch (err) {
		runtime.error?.(danger(`discord: invalid rest proxy: ${String(err)}`));
		return fetch;
	}
}
//#endregion
//#region extensions/discord/src/monitor/provider.ts
init_runtime_group_policy();
init_globals();
init_subsystem();
init_commands();
init_runtime();
init_accounts();
init_token();
let discordVoiceRuntimePromise;
async function loadDiscordVoiceRuntime() {
	discordVoiceRuntimePromise ??= import("./manager.runtime-BzUQLnZ8.js");
	return await discordVoiceRuntimePromise;
}
function formatThreadBindingDurationForConfigLabel(durationMs) {
	const label = formatThreadBindingDurationLabel(durationMs);
	return label === "disabled" ? "off" : label;
}
function appendPluginCommandSpecs(params) {
	const merged = [...params.commandSpecs];
	const existingNames = new Set(merged.map((spec) => spec.name.trim().toLowerCase()).filter(Boolean));
	for (const pluginCommand of getPluginCommandSpecs("discord")) {
		const normalizedName = pluginCommand.name.trim().toLowerCase();
		if (!normalizedName) continue;
		if (existingNames.has(normalizedName)) {
			params.runtime.error?.(danger(`discord: plugin command "/${normalizedName}" duplicates an existing native command. Skipping.`));
			continue;
		}
		existingNames.add(normalizedName);
		merged.push({
			name: pluginCommand.name,
			description: pluginCommand.description,
			acceptsArgs: pluginCommand.acceptsArgs
		});
	}
	return merged;
}
const DISCORD_ACP_STATUS_PROBE_TIMEOUT_MS = 8e3;
const DISCORD_ACP_STALE_RUNNING_ACTIVITY_MS = 120 * 1e3;
function isLegacyMissingSessionError(message) {
	return message.includes("Session is not ACP-enabled") || message.includes("ACP session metadata missing");
}
function classifyAcpStatusProbeError(params) {
	if (isAcpRuntimeError(params.error) && params.error.code === "ACP_SESSION_INIT_FAILED") return {
		status: "stale",
		reason: "session-init-failed"
	};
	if (isLegacyMissingSessionError(params.error instanceof Error ? params.error.message : String(params.error))) return {
		status: "stale",
		reason: "session-missing"
	};
	return params.isStaleRunning ? {
		status: "stale",
		reason: "status-error-running-stale"
	} : {
		status: "uncertain",
		reason: "status-error"
	};
}
async function probeDiscordAcpBindingHealth(params) {
	const manager = getAcpSessionManager();
	const statusProbeAbortController = new AbortController();
	const statusPromise = manager.getSessionStatus({
		cfg: params.cfg,
		sessionKey: params.sessionKey,
		signal: statusProbeAbortController.signal
	}).then((status) => ({
		kind: "status",
		status
	})).catch((error) => ({
		kind: "error",
		error
	}));
	let timeoutTimer = null;
	const timeoutPromise = new Promise((resolve) => {
		timeoutTimer = setTimeout(() => resolve({ kind: "timeout" }), DISCORD_ACP_STATUS_PROBE_TIMEOUT_MS);
		timeoutTimer.unref?.();
	});
	const result = await Promise.race([statusPromise, timeoutPromise]);
	if (timeoutTimer) clearTimeout(timeoutTimer);
	if (result.kind === "timeout") statusProbeAbortController.abort();
	const runningForMs = params.storedState === "running" && Number.isFinite(params.lastActivityAt) ? Date.now() - Math.max(0, Math.floor(params.lastActivityAt ?? 0)) : 0;
	const isStaleRunning = params.storedState === "running" && runningForMs >= DISCORD_ACP_STALE_RUNNING_ACTIVITY_MS;
	if (result.kind === "timeout") return isStaleRunning ? {
		status: "stale",
		reason: "status-timeout-running-stale"
	} : {
		status: "uncertain",
		reason: "status-timeout"
	};
	if (result.kind === "error") return classifyAcpStatusProbeError({
		error: result.error,
		isStaleRunning
	});
	if (result.status.state === "error") return {
		status: "uncertain",
		reason: "status-error-state"
	};
	return { status: "healthy" };
}
async function deployDiscordCommands(params) {
	if (!params.enabled) return;
	const startupStartedAt = params.startupStartedAt ?? Date.now();
	const accountId = params.accountId ?? "default";
	const maxAttempts = 3;
	const maxRetryDelayMs = 15e3;
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
	const isDailyCreateLimit = (err) => err instanceof RateLimitError && err.discordCode === 30034 && /daily application command creates/i.test(err.message);
	const restClient = params.client.rest;
	const originalPut = restClient.put.bind(restClient);
	const previousQueueRequests = restClient.options?.queueRequests;
	restClient.put = async (path, data, query) => {
		const startedAt = Date.now();
		const body = data && typeof data === "object" && "body" in data ? data.body : void 0;
		const commandCount = Array.isArray(body) ? body.length : void 0;
		const bodyBytes = body === void 0 ? void 0 : Buffer.byteLength(typeof body === "string" ? body : JSON.stringify(body), "utf8");
		if (shouldLogVerbose()) params.runtime.log?.(`discord startup [${accountId}] deploy-rest:put:start ${Math.max(0, Date.now() - startupStartedAt)}ms path=${path}${typeof commandCount === "number" ? ` commands=${commandCount}` : ""}${typeof bodyBytes === "number" ? ` bytes=${bodyBytes}` : ""}`);
		try {
			const result = await originalPut(path, data, query);
			if (shouldLogVerbose()) params.runtime.log?.(`discord startup [${accountId}] deploy-rest:put:done ${Math.max(0, Date.now() - startupStartedAt)}ms path=${path} requestMs=${Date.now() - startedAt}`);
			return result;
		} catch (err) {
			params.runtime.error?.(`discord startup [${accountId}] deploy-rest:put:error ${Math.max(0, Date.now() - startupStartedAt)}ms path=${path} requestMs=${Date.now() - startedAt} error=${formatErrorMessage(err)}`);
			throw err;
		}
	};
	try {
		if (restClient.options) restClient.options.queueRequests = false;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) try {
			await params.client.handleDeployRequest();
			return;
		} catch (err) {
			if (isDailyCreateLimit(err)) {
				params.runtime.log?.(warn(`discord: native command deploy skipped for ${accountId}; daily application command create limit reached. Existing slash commands stay active until Discord resets the quota.`));
				return;
			}
			if (!(err instanceof RateLimitError) || attempt >= maxAttempts) throw err;
			const retryAfterMs = Math.max(0, Math.ceil(err.retryAfter * 1e3));
			if (retryAfterMs > maxRetryDelayMs) {
				params.runtime.log?.(warn(`discord: native command deploy skipped for ${accountId}; retry_after=${retryAfterMs}ms exceeds startup budget. Existing slash commands stay active.`));
				return;
			}
			if (shouldLogVerbose()) params.runtime.log?.(`discord startup [${accountId}] deploy-retry ${Math.max(0, Date.now() - startupStartedAt)}ms attempt=${attempt}/${maxAttempts - 1} retryAfterMs=${retryAfterMs} scope=${err.scope ?? "unknown"} code=${err.discordCode ?? "unknown"}`);
			await sleep(retryAfterMs);
		}
	} catch (err) {
		const details = formatDiscordDeployErrorDetails(err);
		params.runtime.error?.(danger(`discord: failed to deploy native commands: ${formatErrorMessage(err)}${details}`));
	} finally {
		if (restClient.options) restClient.options.queueRequests = previousQueueRequests;
		restClient.put = originalPut;
	}
}
function formatDiscordStartupGatewayState(gateway) {
	if (!gateway) return "gateway=missing";
	const reconnectAttempts = gateway.reconnectAttempts;
	return `gatewayConnected=${gateway.isConnected ? "true" : "false"} reconnectAttempts=${typeof reconnectAttempts === "number" ? reconnectAttempts : "na"}`;
}
function logDiscordStartupPhase(params) {
	if (!isVerbose()) return;
	const elapsedMs = Math.max(0, Date.now() - params.startAt);
	const suffix = [params.details, formatDiscordStartupGatewayState(params.gateway)].filter((value) => Boolean(value)).join(" ");
	params.runtime.log?.(`discord startup [${params.accountId}] ${params.phase} ${elapsedMs}ms${suffix ? ` ${suffix}` : ""}`);
}
function formatDiscordDeployErrorDetails(err) {
	if (!err || typeof err !== "object") return "";
	const status = err.status;
	const discordCode = err.discordCode;
	const rawBody = err.rawBody;
	const details = [];
	if (typeof status === "number") details.push(`status=${status}`);
	if (typeof discordCode === "number" || typeof discordCode === "string") details.push(`code=${discordCode}`);
	if (rawBody !== void 0) {
		let bodyText = "";
		try {
			bodyText = JSON.stringify(rawBody);
		} catch {
			bodyText = typeof rawBody === "string" ? rawBody : inspect(rawBody, {
				depth: 3,
				breakLength: 120
			});
		}
		if (bodyText) {
			const maxLen = 800;
			const trimmed = bodyText.length > maxLen ? `${bodyText.slice(0, maxLen)}...` : bodyText;
			details.push(`body=${trimmed}`);
		}
	}
	return details.length > 0 ? ` (${details.join(", ")})` : "";
}
const DISCORD_DISALLOWED_INTENTS_CODE = GatewayCloseCodes.DisallowedIntents;
function isDiscordDisallowedIntentsError(err) {
	if (!err) return false;
	return formatErrorMessage(err).includes(String(DISCORD_DISALLOWED_INTENTS_CODE));
}
async function monitorDiscordProvider(opts = {}) {
	const startupStartedAt = Date.now();
	const cfg = opts.config ?? loadConfig();
	const account = resolveDiscordAccount({
		cfg,
		accountId: opts.accountId
	});
	const token = normalizeDiscordToken(opts.token ?? void 0, "channels.discord.token") ?? account.token;
	if (!token) throw new Error(`Discord bot token missing for account "${account.accountId}" (set discord.accounts.${account.accountId}.token or DISCORD_BOT_TOKEN for default).`);
	const runtime = opts.runtime ?? createNonExitingRuntime();
	const rawDiscordCfg = account.config;
	const discordRootThreadBindings = cfg.channels?.discord?.threadBindings;
	const discordAccountThreadBindings = cfg.channels?.discord?.accounts?.[account.accountId]?.threadBindings;
	const discordRestFetch = resolveDiscordRestFetch(rawDiscordCfg.proxy, runtime);
	const dmConfig = rawDiscordCfg.dm;
	let guildEntries = rawDiscordCfg.guilds;
	const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
	const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: cfg.channels?.discord !== void 0,
		groupPolicy: rawDiscordCfg.groupPolicy,
		defaultGroupPolicy
	});
	const discordCfg = rawDiscordCfg.groupPolicy === groupPolicy ? rawDiscordCfg : {
		...rawDiscordCfg,
		groupPolicy
	};
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "discord",
		accountId: account.accountId,
		blockedLabel: GROUP_POLICY_BLOCKED_LABEL.guild,
		log: (message) => runtime.log?.(warn(message))
	});
	let allowFrom = discordCfg.allowFrom ?? dmConfig?.allowFrom;
	const mediaMaxBytes = (opts.mediaMaxMb ?? discordCfg.mediaMaxMb ?? 8) * 1024 * 1024;
	const textLimit = resolveTextChunkLimit(cfg, "discord", account.accountId, { fallbackLimit: 2e3 });
	const historyLimit = Math.max(0, opts.historyLimit ?? discordCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 20);
	const replyToMode = opts.replyToMode ?? discordCfg.replyToMode ?? "off";
	const dmEnabled = dmConfig?.enabled ?? true;
	const dmPolicy = discordCfg.dmPolicy ?? dmConfig?.policy ?? "pairing";
	const threadBindingIdleTimeoutMs = resolveThreadBindingIdleTimeoutMs({
		channelIdleHoursRaw: discordAccountThreadBindings?.idleHours ?? discordRootThreadBindings?.idleHours,
		sessionIdleHoursRaw: cfg.session?.threadBindings?.idleHours
	});
	const threadBindingMaxAgeMs = resolveThreadBindingMaxAgeMs({
		channelMaxAgeHoursRaw: discordAccountThreadBindings?.maxAgeHours ?? discordRootThreadBindings?.maxAgeHours,
		sessionMaxAgeHoursRaw: cfg.session?.threadBindings?.maxAgeHours
	});
	const threadBindingsEnabled = resolveThreadBindingsEnabled({
		channelEnabledRaw: discordAccountThreadBindings?.enabled ?? discordRootThreadBindings?.enabled,
		sessionEnabledRaw: cfg.session?.threadBindings?.enabled
	});
	const groupDmEnabled = dmConfig?.groupEnabled ?? false;
	const groupDmChannels = dmConfig?.groupChannels;
	const nativeEnabled = resolveNativeCommandsEnabled({
		providerId: "discord",
		providerSetting: discordCfg.commands?.native,
		globalSetting: cfg.commands?.native
	});
	const nativeSkillsEnabled = resolveNativeSkillsEnabled({
		providerId: "discord",
		providerSetting: discordCfg.commands?.nativeSkills,
		globalSetting: cfg.commands?.nativeSkills
	});
	const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
		providerSetting: discordCfg.commands?.native,
		globalSetting: cfg.commands?.native
	});
	const useAccessGroups = cfg.commands?.useAccessGroups !== false;
	const slashCommand = resolveDiscordSlashCommandConfig(discordCfg.slashCommand);
	const sessionPrefix = "discord:slash";
	const ephemeralDefault = slashCommand.ephemeral;
	const voiceEnabled = discordCfg.voice?.enabled !== false;
	const allowlistResolved = await resolveDiscordAllowlistConfig({
		token,
		guildEntries,
		allowFrom,
		fetcher: discordRestFetch,
		runtime
	});
	guildEntries = allowlistResolved.guildEntries;
	allowFrom = allowlistResolved.allowFrom;
	if (shouldLogVerbose()) {
		const allowFromSummary = summarizeStringEntries({
			entries: allowFrom ?? [],
			limit: 4,
			emptyText: "any"
		});
		const groupDmChannelSummary = summarizeStringEntries({
			entries: groupDmChannels ?? [],
			limit: 4,
			emptyText: "any"
		});
		const guildSummary = summarizeStringEntries({
			entries: Object.keys(guildEntries ?? {}),
			limit: 4,
			emptyText: "any"
		});
		logVerbose(`discord: config dm=${dmEnabled ? "on" : "off"} dmPolicy=${dmPolicy} allowFrom=${allowFromSummary} groupDm=${groupDmEnabled ? "on" : "off"} groupDmChannels=${groupDmChannelSummary} groupPolicy=${groupPolicy} guilds=${guildSummary} historyLimit=${historyLimit} mediaMaxMb=${Math.round(mediaMaxBytes / (1024 * 1024))} native=${nativeEnabled ? "on" : "off"} nativeSkills=${nativeSkillsEnabled ? "on" : "off"} accessGroups=${useAccessGroups ? "on" : "off"} threadBindings=${threadBindingsEnabled ? "on" : "off"} threadIdleTimeout=${formatThreadBindingDurationForConfigLabel(threadBindingIdleTimeoutMs)} threadMaxAge=${formatThreadBindingDurationForConfigLabel(threadBindingMaxAgeMs)}`);
	}
	logDiscordStartupPhase({
		runtime,
		accountId: account.accountId,
		phase: "fetch-application-id:start",
		startAt: startupStartedAt
	});
	const applicationId = await fetchDiscordApplicationId(token, 4e3, discordRestFetch);
	if (!applicationId) throw new Error("Failed to resolve Discord application id");
	logDiscordStartupPhase({
		runtime,
		accountId: account.accountId,
		phase: "fetch-application-id:done",
		startAt: startupStartedAt,
		details: `applicationId=${applicationId}`
	});
	const maxDiscordCommands = 100;
	let skillCommands = nativeEnabled && nativeSkillsEnabled ? listSkillCommandsForAgents({ cfg }) : [];
	let commandSpecs = nativeEnabled ? listNativeCommandSpecsForConfig(cfg, {
		skillCommands,
		provider: "discord"
	}) : [];
	if (nativeEnabled) commandSpecs = appendPluginCommandSpecs({
		commandSpecs,
		runtime
	});
	const initialCommandCount = commandSpecs.length;
	if (nativeEnabled && nativeSkillsEnabled && commandSpecs.length > maxDiscordCommands) {
		skillCommands = [];
		commandSpecs = listNativeCommandSpecsForConfig(cfg, {
			skillCommands: [],
			provider: "discord"
		});
		commandSpecs = appendPluginCommandSpecs({
			commandSpecs,
			runtime
		});
		runtime.log?.(warn(`discord: ${initialCommandCount} commands exceeds limit; removing per-skill commands and keeping /skill.`));
	}
	if (nativeEnabled && commandSpecs.length > maxDiscordCommands) runtime.log?.(warn(`discord: ${commandSpecs.length} commands exceeds limit; some commands may fail to deploy.`));
	const voiceManagerRef = { current: null };
	const threadBindings = threadBindingsEnabled ? createThreadBindingManager({
		accountId: account.accountId,
		token,
		cfg,
		idleTimeoutMs: threadBindingIdleTimeoutMs,
		maxAgeMs: threadBindingMaxAgeMs
	}) : createNoopThreadBindingManager(account.accountId);
	if (threadBindingsEnabled) {
		const uncertainProbeKeys = /* @__PURE__ */ new Set();
		const reconciliation = await reconcileAcpThreadBindingsOnStartup({
			cfg,
			accountId: account.accountId,
			sendFarewell: false,
			healthProbe: async ({ sessionKey, session }) => {
				const probe = await probeDiscordAcpBindingHealth({
					cfg,
					sessionKey,
					storedState: session.acp?.state,
					lastActivityAt: session.acp?.lastActivityAt
				});
				if (probe.status === "uncertain") uncertainProbeKeys.add(`${sessionKey}${probe.reason ? ` (${probe.reason})` : ""}`);
				return probe;
			}
		});
		if (reconciliation.removed > 0) logVerbose(`discord: removed ${reconciliation.removed}/${reconciliation.checked} stale ACP thread bindings on startup for account ${account.accountId}: ${reconciliation.staleSessionKeys.join(", ")}`);
		if (uncertainProbeKeys.size > 0) logVerbose(`discord: ACP thread-binding health probe uncertain for account ${account.accountId}: ${[...uncertainProbeKeys].join(", ")}`);
	}
	let lifecycleStarted = false;
	let releaseEarlyGatewayErrorGuard = () => {};
	let deactivateMessageHandler;
	let autoPresenceController = null;
	let earlyGatewayEmitter;
	let onEarlyGatewayDebug;
	try {
		const commands = commandSpecs.map((spec) => createDiscordNativeCommand({
			command: spec,
			cfg,
			discordConfig: discordCfg,
			accountId: account.accountId,
			sessionPrefix,
			ephemeralDefault,
			threadBindings
		}));
		if (nativeEnabled && voiceEnabled) commands.push(createDiscordVoiceCommand({
			cfg,
			discordConfig: discordCfg,
			accountId: account.accountId,
			groupPolicy,
			useAccessGroups,
			getManager: () => voiceManagerRef.current,
			ephemeralDefault
		}));
		const execApprovalsConfig = discordCfg.execApprovals ?? {};
		const execApprovalsHandler = execApprovalsConfig.enabled ? new DiscordExecApprovalHandler({
			token,
			accountId: account.accountId,
			config: execApprovalsConfig,
			cfg,
			runtime
		}) : null;
		const agentComponentsEnabled = (discordCfg.agentComponents ?? {}).enabled ?? true;
		const components = [
			createDiscordCommandArgFallbackButton({
				cfg,
				discordConfig: discordCfg,
				accountId: account.accountId,
				sessionPrefix,
				threadBindings
			}),
			createDiscordModelPickerFallbackButton({
				cfg,
				discordConfig: discordCfg,
				accountId: account.accountId,
				sessionPrefix,
				threadBindings
			}),
			createDiscordModelPickerFallbackSelect({
				cfg,
				discordConfig: discordCfg,
				accountId: account.accountId,
				sessionPrefix,
				threadBindings
			})
		];
		const modals = [];
		if (execApprovalsHandler) components.push(createExecApprovalButton({ handler: execApprovalsHandler }));
		if (agentComponentsEnabled) {
			const componentContext = {
				cfg,
				discordConfig: discordCfg,
				accountId: account.accountId,
				guildEntries,
				allowFrom,
				dmPolicy,
				runtime,
				token
			};
			components.push(createAgentComponentButton(componentContext));
			components.push(createAgentSelectMenu(componentContext));
			components.push(createDiscordComponentButton(componentContext));
			components.push(createDiscordComponentStringSelect(componentContext));
			components.push(createDiscordComponentUserSelect(componentContext));
			components.push(createDiscordComponentRoleSelect(componentContext));
			components.push(createDiscordComponentMentionableSelect(componentContext));
			components.push(createDiscordComponentChannelSelect(componentContext));
			modals.push(createDiscordComponentModal(componentContext));
		}
		class DiscordStatusReadyListener extends ReadyListener {
			async handle(_data, client) {
				if (autoPresenceController?.enabled) {
					autoPresenceController.refresh();
					return;
				}
				const gateway = client.getPlugin("gateway");
				if (!gateway) return;
				const presence = resolveDiscordPresenceUpdate(discordCfg);
				if (!presence) return;
				gateway.updatePresence(presence);
			}
		}
		const clientPlugins = [createDiscordGatewayPlugin({
			discordConfig: discordCfg,
			runtime
		})];
		if (voiceEnabled) clientPlugins.push(new VoicePlugin());
		const eventQueueOpts = {
			listenerTimeout: 12e4,
			...discordCfg.eventQueue
		};
		const client = new Client({
			baseUrl: "http://localhost",
			deploySecret: "a",
			clientId: applicationId,
			publicKey: "a",
			token,
			autoDeploy: false,
			eventQueue: eventQueueOpts
		}, {
			commands,
			listeners: [new DiscordStatusReadyListener()],
			components,
			modals
		}, clientPlugins);
		const earlyGatewayErrorGuard = attachEarlyGatewayErrorGuard(client);
		releaseEarlyGatewayErrorGuard = earlyGatewayErrorGuard.release;
		const lifecycleGateway = client.getPlugin("gateway");
		earlyGatewayEmitter = getDiscordGatewayEmitter(lifecycleGateway);
		onEarlyGatewayDebug = (msg) => {
			if (!isVerbose()) return;
			runtime.log?.(`discord startup [${account.accountId}] gateway-debug ${Math.max(0, Date.now() - startupStartedAt)}ms ${String(msg)}`);
		};
		earlyGatewayEmitter?.on("debug", onEarlyGatewayDebug);
		if (lifecycleGateway) {
			autoPresenceController = createDiscordAutoPresenceController({
				accountId: account.accountId,
				discordConfig: discordCfg,
				gateway: lifecycleGateway,
				log: (message) => runtime.log?.(message)
			});
			autoPresenceController.start();
		}
		logDiscordStartupPhase({
			runtime,
			accountId: account.accountId,
			phase: "deploy-commands:start",
			startAt: startupStartedAt,
			gateway: lifecycleGateway,
			details: `native=${nativeEnabled ? "on" : "off"} commandCount=${commands.length}`
		});
		await deployDiscordCommands({
			client,
			runtime,
			enabled: nativeEnabled,
			accountId: account.accountId,
			startupStartedAt
		});
		logDiscordStartupPhase({
			runtime,
			accountId: account.accountId,
			phase: "deploy-commands:done",
			startAt: startupStartedAt,
			gateway: lifecycleGateway
		});
		const logger = createSubsystemLogger("discord/monitor");
		const guildHistories = /* @__PURE__ */ new Map();
		let botUserId;
		let botUserName;
		let voiceManager = null;
		if (nativeDisabledExplicit) {
			logDiscordStartupPhase({
				runtime,
				accountId: account.accountId,
				phase: "clear-native-commands:start",
				startAt: startupStartedAt,
				gateway: lifecycleGateway
			});
			await clearDiscordNativeCommands({
				client,
				applicationId,
				runtime
			});
			logDiscordStartupPhase({
				runtime,
				accountId: account.accountId,
				phase: "clear-native-commands:done",
				startAt: startupStartedAt,
				gateway: lifecycleGateway
			});
		}
		logDiscordStartupPhase({
			runtime,
			accountId: account.accountId,
			phase: "fetch-bot-identity:start",
			startAt: startupStartedAt,
			gateway: lifecycleGateway
		});
		try {
			const botUser = await client.fetchUser("@me");
			botUserId = botUser?.id;
			botUserName = botUser?.username?.trim() || botUser?.globalName?.trim() || void 0;
			logDiscordStartupPhase({
				runtime,
				accountId: account.accountId,
				phase: "fetch-bot-identity:done",
				startAt: startupStartedAt,
				gateway: lifecycleGateway,
				details: `botUserId=${botUserId ?? "<missing>"} botUserName=${botUserName ?? "<missing>"}`
			});
		} catch (err) {
			runtime.error?.(danger(`discord: failed to fetch bot identity: ${String(err)}`));
			logDiscordStartupPhase({
				runtime,
				accountId: account.accountId,
				phase: "fetch-bot-identity:error",
				startAt: startupStartedAt,
				gateway: lifecycleGateway,
				details: String(err)
			});
		}
		if (voiceEnabled) {
			const { DiscordVoiceManager, DiscordVoiceReadyListener } = await loadDiscordVoiceRuntime();
			voiceManager = new DiscordVoiceManager({
				client,
				cfg,
				discordConfig: discordCfg,
				accountId: account.accountId,
				runtime,
				botUserId
			});
			voiceManagerRef.current = voiceManager;
			registerDiscordListener(client.listeners, new DiscordVoiceReadyListener(voiceManager));
		}
		const messageHandler = createDiscordMessageHandler({
			cfg,
			discordConfig: discordCfg,
			accountId: account.accountId,
			token,
			runtime,
			setStatus: opts.setStatus,
			abortSignal: opts.abortSignal,
			workerRunTimeoutMs: discordCfg.inboundWorker?.runTimeoutMs,
			botUserId,
			guildHistories,
			historyLimit,
			mediaMaxBytes,
			textLimit,
			replyToMode,
			dmEnabled,
			groupDmEnabled,
			groupDmChannels,
			allowFrom,
			guildEntries,
			threadBindings,
			discordRestFetch
		});
		deactivateMessageHandler = messageHandler.deactivate;
		const trackInboundEvent = opts.setStatus ? () => {
			const at = Date.now();
			opts.setStatus?.({
				lastEventAt: at,
				lastInboundAt: at
			});
		} : void 0;
		registerDiscordListener(client.listeners, new DiscordMessageListener(messageHandler, logger, trackInboundEvent, { timeoutMs: eventQueueOpts.listenerTimeout }));
		const reactionListenerOptions = {
			cfg,
			accountId: account.accountId,
			runtime,
			botUserId,
			dmEnabled,
			groupDmEnabled,
			groupDmChannels: groupDmChannels ?? [],
			dmPolicy,
			allowFrom: allowFrom ?? [],
			groupPolicy,
			allowNameMatching: isDangerousNameMatchingEnabled(discordCfg),
			guildEntries,
			logger,
			onEvent: trackInboundEvent
		};
		registerDiscordListener(client.listeners, new DiscordReactionListener(reactionListenerOptions));
		registerDiscordListener(client.listeners, new DiscordReactionRemoveListener(reactionListenerOptions));
		registerDiscordListener(client.listeners, new DiscordThreadUpdateListener(cfg, account.accountId, logger));
		if (discordCfg.intents?.presence) {
			registerDiscordListener(client.listeners, new DiscordPresenceListener({
				logger,
				accountId: account.accountId
			}));
			runtime.log?.("discord: GuildPresences intent enabled — presence listener registered");
		}
		const botIdentity = botUserId && botUserName ? `${botUserId} (${botUserName})` : botUserId ?? botUserName ?? "";
		runtime.log?.(`logged in to discord${botIdentity ? ` as ${botIdentity}` : ""}`);
		if (lifecycleGateway?.isConnected) opts.setStatus?.(createConnectedChannelStatusPatch());
		lifecycleStarted = true;
		earlyGatewayEmitter?.removeListener("debug", onEarlyGatewayDebug);
		onEarlyGatewayDebug = void 0;
		await runDiscordGatewayLifecycle({
			accountId: account.accountId,
			client,
			runtime,
			abortSignal: opts.abortSignal,
			statusSink: opts.setStatus,
			isDisallowedIntentsError: isDiscordDisallowedIntentsError,
			voiceManager,
			voiceManagerRef,
			execApprovalsHandler,
			threadBindings,
			pendingGatewayErrors: earlyGatewayErrorGuard.pendingErrors,
			releaseEarlyGatewayErrorGuard
		});
	} finally {
		deactivateMessageHandler?.();
		autoPresenceController?.stop();
		opts.setStatus?.({ connected: false });
		if (onEarlyGatewayDebug) earlyGatewayEmitter?.removeListener("debug", onEarlyGatewayDebug);
		releaseEarlyGatewayErrorGuard();
		if (!lifecycleStarted) threadBindings.stop();
	}
}
async function clearDiscordNativeCommands(params) {
	try {
		await params.client.rest.put(Routes.applicationCommands(params.applicationId), { body: [] });
		logVerbose("discord: cleared native commands (commands.native=false)");
	} catch (err) {
		params.runtime.error?.(danger(`discord: failed to clear native commands: ${String(err)}`));
	}
}
//#endregion
export { auditDiscordChannelPermissions, createThreadDiscord, deleteMessageDiscord, editChannelDiscord, editMessageDiscord, listDiscordDirectoryGroupsLive, listDiscordDirectoryPeersLive, monitorDiscordProvider, pinMessageDiscord, probeDiscord, resolveDiscordChannelAllowlist, resolveDiscordUserAllowlist, sendDiscordComponentMessage, sendMessageDiscord, sendPollDiscord, sendTypingDiscord, unpinMessageDiscord };
