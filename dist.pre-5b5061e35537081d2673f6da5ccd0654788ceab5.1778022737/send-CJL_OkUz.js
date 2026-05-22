import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { r as logVerbose } from "./globals-C7I_COwU.js";
import { a as isSilentReplyText } from "./tokens-B5LCdh_k.js";
import { a as withTrustedEnvProxyGuardedFetchMode, n as fetchWithSsrFGuard } from "./fetch-guard-C2Af5kcY.js";
import { h as resolveTextChunksWithFallback } from "./reply-payload-B61Gbdzt.js";
import { c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, s as resolveChunkMode } from "./chunk-D2H_19Xb.js";
import { i as markdownToIR, n as renderMarkdownWithMarkers } from "./tables-Da_CoTmG.js";
import { i as renderMarkdownIRChunksWithinLimit } from "./text-runtime-icMZVCaq.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DOmSgsqv.js";
import "./runtime-env-BBcuHj0d.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-27YfIt4P.js";
import "./reply-chunking-CRxdpUGk.js";
import { t as loadOutboundMediaFromUrl } from "./outbound-media-BpXQc5ok.js";
import "./ssrf-runtime-B3HHI4NS.js";
import "./markdown-table-runtime-BCQyeDEk.js";
import "./fetch-runtime-DPrxmB2M.js";
import { a as resolveSlackAccount, d as resolveSlackBotToken } from "./accounts-CXQhiynx.js";
import { r as parseSlackTarget } from "./target-parsing-Bidd6d-v.js";
import { n as truncateSlackText, t as SLACK_TEXT_LIMIT } from "./limits-rCZdSRsJ.js";
import { a as getSlackWriteClient, n as createSlackTokenCacheKey } from "./client-uPyx8gHb.js";
import { r as validateSlackBlocksArray } from "./blocks-input-DxgIu7O0.js";
import "./runtime-api-DHu6O824.js";
//#region extensions/slack/src/blocks-fallback.ts
function cleanCandidate(value) {
	if (typeof value !== "string") return;
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 0 ? normalized : void 0;
}
function readSectionText(block) {
	return cleanCandidate(block.text?.text);
}
function readHeaderText(block) {
	return cleanCandidate(block.text?.text);
}
function readImageText(block) {
	return cleanCandidate(block.alt_text) ?? cleanCandidate(block.title?.text);
}
function readVideoText(block) {
	return cleanCandidate(block.title?.text) ?? cleanCandidate(block.alt_text);
}
function readContextText(block) {
	if (!Array.isArray(block.elements)) return;
	const textParts = block.elements.map((element) => cleanCandidate(element.text)).filter((value) => Boolean(value));
	return textParts.length > 0 ? textParts.join(" ") : void 0;
}
function buildSlackBlocksFallbackText(blocks) {
	for (const raw of blocks) {
		const block = raw;
		switch (block.type) {
			case "header": {
				const text = readHeaderText(block);
				if (text) return text;
				break;
			}
			case "section": {
				const text = readSectionText(block);
				if (text) return text;
				break;
			}
			case "image": {
				const text = readImageText(block);
				if (text) return text;
				return "Shared an image";
			}
			case "video": {
				const text = readVideoText(block);
				if (text) return text;
				return "Shared a video";
			}
			case "file": return "Shared a file";
			case "context": {
				const text = readContextText(block);
				if (text) return text;
				break;
			}
			default: break;
		}
	}
	return "Shared a Block Kit message";
}
//#endregion
//#region extensions/slack/src/format.ts
function escapeSlackMrkdwnSegment(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g;
function isAllowedSlackAngleToken(token) {
	if (!token.startsWith("<") || !token.endsWith(">")) return false;
	const inner = token.slice(1, -1);
	return inner.startsWith("@") || inner.startsWith("#") || inner.startsWith("!") || inner.startsWith("mailto:") || inner.startsWith("tel:") || inner.startsWith("http://") || inner.startsWith("https://") || inner.startsWith("slack://");
}
function escapeSlackMrkdwnContent(text) {
	if (!text) return "";
	if (!text.includes("&") && !text.includes("<") && !text.includes(">")) return text;
	SLACK_ANGLE_TOKEN_RE.lastIndex = 0;
	const out = [];
	let lastIndex = 0;
	for (let match = SLACK_ANGLE_TOKEN_RE.exec(text); match; match = SLACK_ANGLE_TOKEN_RE.exec(text)) {
		const matchIndex = match.index ?? 0;
		out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex, matchIndex)));
		const token = match[0] ?? "";
		out.push(isAllowedSlackAngleToken(token) ? token : escapeSlackMrkdwnSegment(token));
		lastIndex = matchIndex + token.length;
	}
	out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex)));
	return out.join("");
}
function escapeSlackMrkdwnText(text) {
	if (!text) return "";
	if (!text.includes("&") && !text.includes("<") && !text.includes(">")) return text;
	return text.split("\n").map((line) => {
		if (line.startsWith("> ")) return `> ${escapeSlackMrkdwnContent(line.slice(2))}`;
		return escapeSlackMrkdwnContent(line);
	}).join("\n");
}
function buildSlackLink(link, text) {
	const href = link.href.trim();
	if (!href) return null;
	const trimmedLabel = text.slice(link.start, link.end).trim();
	const comparableHref = href.startsWith("mailto:") ? href.slice(7) : href;
	if (!(trimmedLabel.length > 0 && trimmedLabel !== href && trimmedLabel !== comparableHref)) return null;
	const safeHref = escapeSlackMrkdwnSegment(href);
	return {
		start: link.start,
		end: link.end,
		open: `<${safeHref}|`,
		close: ">"
	};
}
function buildSlackRenderOptions() {
	return {
		styleMarkers: {
			bold: {
				open: "*",
				close: "*"
			},
			italic: {
				open: "_",
				close: "_"
			},
			strikethrough: {
				open: "~",
				close: "~"
			},
			code: {
				open: "`",
				close: "`"
			},
			code_block: {
				open: "```\n",
				close: "```"
			}
		},
		escapeText: escapeSlackMrkdwnText,
		buildLink: buildSlackLink
	};
}
function markdownToSlackMrkdwn(markdown, options = {}) {
	return renderMarkdownWithMarkers(markdownToIR(markdown ?? "", {
		linkify: false,
		autolink: false,
		headingStyle: "bold",
		blockquotePrefix: "> ",
		tableMode: options.tableMode
	}), buildSlackRenderOptions());
}
function normalizeSlackOutboundText(markdown) {
	return markdownToSlackMrkdwn(markdown ?? "");
}
function markdownToSlackMrkdwnChunks(markdown, limit, options = {}) {
	const ir = markdownToIR(markdown ?? "", {
		linkify: false,
		autolink: false,
		headingStyle: "bold",
		blockquotePrefix: "> ",
		tableMode: options.tableMode
	});
	const renderOptions = buildSlackRenderOptions();
	return renderMarkdownIRChunksWithinLimit({
		ir,
		limit,
		renderChunk: (chunk) => renderMarkdownWithMarkers(chunk, renderOptions),
		measureRendered: (rendered) => rendered.length
	}).map(({ rendered }) => rendered);
}
//#endregion
//#region extensions/slack/src/send.ts
const SLACK_UPLOAD_SSRF_POLICY = {
	allowedHostnames: [
		"*.slack.com",
		"*.slack-edge.com",
		"*.slack-files.com"
	],
	allowRfc2544BenchmarkRange: true
};
const SLACK_DM_CHANNEL_CACHE_MAX = 1024;
const SLACK_DNS_RETRY_CODES = new Set([
	"EAI_AGAIN",
	"ENOTFOUND",
	"UND_ERR_DNS_RESOLVE_FAILED"
]);
const SLACK_DNS_RETRY_ATTEMPTS = 2;
const SLACK_DNS_RETRY_BASE_DELAY_MS = 250;
const slackDmChannelCache = /* @__PURE__ */ new Map();
const slackSendQueues = /* @__PURE__ */ new Map();
function hasCustomIdentity(identity) {
	return Boolean(identity?.username || identity?.iconUrl || identity?.iconEmoji);
}
function normalizeSlackApiString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function normalizeSlackScopeList(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((scope) => {
		const normalized = normalizeSlackApiString(scope);
		return normalized ? [normalized] : [];
	});
}
function getSlackWebApiErrorData(err) {
	if (!(err instanceof Error)) return;
	const data = err.data;
	if (!data || typeof data !== "object") return;
	return data;
}
function formatSlackWebApiErrorMessage(err) {
	if (!(err instanceof Error)) return;
	const data = getSlackWebApiErrorData(err);
	const code = normalizeSlackApiString(data?.error);
	if (!code) return;
	const details = [];
	const needed = normalizeSlackApiString(data?.needed);
	if (needed) details.push(`needed: ${needed}`);
	const scopes = normalizeSlackScopeList(data?.response_metadata?.scopes);
	if (scopes.length) details.push(`granted: ${scopes.join(", ")}`);
	const acceptedScopes = normalizeSlackScopeList(data?.response_metadata?.acceptedScopes);
	if (acceptedScopes.length) details.push(`accepted: ${acceptedScopes.join(", ")}`);
	return `${err.message || `An API error occurred: ${code}`}${details.length ? ` (${details.join("; ")})` : ""}`;
}
function enrichSlackWebApiError(err) {
	const message = formatSlackWebApiErrorMessage(err);
	if (!message || !(err instanceof Error) || message === err.message) return err;
	return new Error(message);
}
function readSlackRequestErrorCode(value) {
	if (!value || typeof value !== "object") return;
	const code = value.code;
	return typeof code === "string" ? code.toUpperCase() : void 0;
}
function readSlackRequestErrorMessage(value) {
	if (value instanceof Error) return value.message;
	return typeof value === "string" ? value : "";
}
function hasSlackDnsRequestSignal(err) {
	let current = err;
	const seen = /* @__PURE__ */ new Set();
	for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
		if (seen.has(current)) return false;
		seen.add(current);
		const code = readSlackRequestErrorCode(current);
		if (code && SLACK_DNS_RETRY_CODES.has(code)) return true;
		const message = readSlackRequestErrorMessage(current);
		if (/\b(EAI_AGAIN|ENOTFOUND|UND_ERR_DNS_RESOLVE_FAILED)\b/i.test(message)) return true;
		current = current.original ?? current.cause;
	}
	return false;
}
function delaySlackDnsRetry(attempt) {
	return new Promise((resolve) => setTimeout(resolve, SLACK_DNS_RETRY_BASE_DELAY_MS * Math.max(1, attempt)));
}
async function withSlackDnsRequestRetry(operation, fn) {
	for (let attempt = 0;; attempt += 1) try {
		return await fn();
	} catch (err) {
		if (attempt >= SLACK_DNS_RETRY_ATTEMPTS || !hasSlackDnsRequestSignal(err)) throw err;
		logVerbose(`slack send: retrying ${operation} after transient DNS request error (${attempt + 1}/${SLACK_DNS_RETRY_ATTEMPTS})`);
		await delaySlackDnsRetry(attempt + 1);
	}
}
function isSlackCustomizeScopeError(err) {
	const data = getSlackWebApiErrorData(err);
	if (normalizeLowercaseStringOrEmpty(normalizeSlackApiString(data?.error)) !== "missing_scope") return false;
	if (normalizeLowercaseStringOrEmpty(normalizeSlackApiString(data?.needed))?.includes("chat:write.customize")) return true;
	return [...normalizeSlackScopeList(data?.response_metadata?.scopes), ...normalizeSlackScopeList(data?.response_metadata?.acceptedScopes)].map((scope) => normalizeLowercaseStringOrEmpty(scope)).includes("chat:write.customize");
}
async function postSlackMessageBestEffort(params) {
	const basePayload = {
		channel: params.channelId,
		text: params.text,
		thread_ts: params.threadTs,
		...params.blocks?.length ? { blocks: params.blocks } : {}
	};
	const postChatMessage = params.client.chat.postMessage.bind(params.client.chat);
	try {
		const identity = params.identity;
		if (identity?.iconUrl) return await withSlackDnsRequestRetry("chat.postMessage", () => postChatMessage({
			...basePayload,
			...identity.username ? { username: identity.username } : {},
			icon_url: identity.iconUrl
		}));
		if (identity?.iconEmoji) return await withSlackDnsRequestRetry("chat.postMessage", () => postChatMessage({
			...basePayload,
			...identity.username ? { username: identity.username } : {},
			icon_emoji: identity.iconEmoji
		}));
		return await withSlackDnsRequestRetry("chat.postMessage", () => postChatMessage({
			...basePayload,
			...identity?.username ? { username: identity.username } : {}
		}));
	} catch (err) {
		if (!hasCustomIdentity(params.identity) || !isSlackCustomizeScopeError(err)) throw err;
		logVerbose("slack send: missing chat:write.customize, retrying without custom identity");
		return withSlackDnsRequestRetry("chat.postMessage", () => postChatMessage(basePayload));
	}
}
function resolveToken(params) {
	const explicit = resolveSlackBotToken(params.explicit);
	if (explicit) return explicit;
	const fallback = resolveSlackBotToken(params.fallbackToken);
	if (!fallback) {
		logVerbose(`slack send: missing bot token for account=${params.accountId} explicit=${Boolean(params.explicit)} source=${params.fallbackSource ?? "unknown"}`);
		throw new Error(`Slack bot token missing for account "${params.accountId}" (set channels.slack.accounts.${params.accountId}.botToken or SLACK_BOT_TOKEN for default).`);
	}
	return fallback;
}
function parseRecipient(raw) {
	const target = parseSlackTarget(raw);
	if (!target) throw new Error("Recipient is required for Slack sends");
	return {
		kind: target.kind,
		id: target.id
	};
}
function createSlackSendQueueKey(params) {
	const recipientKey = `${params.recipient.kind === "user" || /^U[A-Z0-9]+$/i.test(params.recipient.id) ? "user" : params.recipient.kind}:${params.recipient.id}`;
	return `${params.accountId}:${createSlackTokenCacheKey(params.token)}:${recipientKey}:${params.threadTs ?? ""}`;
}
async function runQueuedSlackSend(key, task) {
	const previous = slackSendQueues.get(key) ?? Promise.resolve();
	let releaseCurrent;
	const current = new Promise((resolve) => {
		releaseCurrent = resolve;
	});
	const queuedCurrent = previous.catch(() => void 0).then(() => current);
	slackSendQueues.set(key, queuedCurrent);
	await previous.catch(() => void 0);
	try {
		return await task();
	} finally {
		releaseCurrent();
		if (slackSendQueues.get(key) === queuedCurrent) slackSendQueues.delete(key);
	}
}
function createSlackDmCacheKey(params) {
	return `${params.accountId ?? "default"}:${createSlackTokenCacheKey(params.token)}:${params.recipientId}`;
}
function setSlackDmChannelCache(key, channelId) {
	if (slackDmChannelCache.has(key)) slackDmChannelCache.delete(key);
	else if (slackDmChannelCache.size >= SLACK_DM_CHANNEL_CACHE_MAX) {
		const oldest = slackDmChannelCache.keys().next().value;
		if (oldest) slackDmChannelCache.delete(oldest);
	}
	slackDmChannelCache.set(key, channelId);
}
function isSlackUserRecipient(recipient) {
	return recipient.kind === "user" || /^U[A-Z0-9]+$/i.test(recipient.id);
}
function resolveDirectUserPostChannelId(params) {
	if (!isSlackUserRecipient(params.recipient) || params.hasMedia || params.threadTs) return;
	return params.recipient.id;
}
async function resolveChannelId(client, recipient, params) {
	if (!isSlackUserRecipient(recipient)) return { channelId: recipient.id };
	const cacheKey = createSlackDmCacheKey({
		accountId: params.accountId,
		token: params.token,
		recipientId: recipient.id
	});
	const cachedChannelId = slackDmChannelCache.get(cacheKey);
	if (cachedChannelId) return {
		channelId: cachedChannelId,
		isDm: true,
		cacheHit: true
	};
	const channelId = (await withSlackDnsRequestRetry("conversations.open", () => client.conversations.open({ users: recipient.id }))).channel?.id;
	if (!channelId) throw new Error("Failed to open Slack DM channel");
	setSlackDmChannelCache(cacheKey, channelId);
	return {
		channelId,
		isDm: true,
		cacheHit: false
	};
}
async function uploadSlackFile(params) {
	const { buffer, contentType, fileName } = await loadOutboundMediaFromUrl(params.mediaUrl, {
		maxBytes: params.maxBytes,
		mediaAccess: params.mediaAccess,
		mediaLocalRoots: params.mediaLocalRoots,
		mediaReadFile: params.mediaReadFile
	});
	const uploadFileName = params.uploadFileName ?? fileName ?? "upload";
	const uploadTitle = params.uploadTitle ?? uploadFileName;
	const uploadUrlResp = await withSlackDnsRequestRetry("files.getUploadURLExternal", () => params.client.files.getUploadURLExternal({
		filename: uploadFileName,
		length: buffer.length
	}));
	if (!uploadUrlResp.ok || !uploadUrlResp.upload_url || !uploadUrlResp.file_id) throw new Error(`Failed to get upload URL: ${uploadUrlResp.error ?? "unknown error"}`);
	const uploadFileId = uploadUrlResp.file_id;
	const uploadBody = new Uint8Array(buffer);
	const { response: uploadResp, release } = await fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({
		url: uploadUrlResp.upload_url,
		init: {
			method: "POST",
			...contentType ? { headers: { "Content-Type": contentType } } : {},
			body: uploadBody
		},
		policy: SLACK_UPLOAD_SSRF_POLICY,
		auditContext: "slack-upload-file"
	}));
	try {
		if (!uploadResp.ok) throw new Error(`Failed to upload file: HTTP ${uploadResp.status}`);
	} finally {
		await release();
	}
	const completeResp = await withSlackDnsRequestRetry("files.completeUploadExternal", () => params.client.files.completeUploadExternal({
		files: [{
			id: uploadFileId,
			title: uploadTitle
		}],
		channel_id: params.channelId,
		...params.caption ? { initial_comment: params.caption } : {},
		...params.threadTs ? { thread_ts: params.threadTs } : {}
	}));
	if (!completeResp.ok) throw new Error(`Failed to complete upload: ${completeResp.error ?? "unknown error"}`);
	return uploadFileId;
}
async function sendMessageSlack(to, message, opts) {
	const trimmedMessage = normalizeOptionalString(message) ?? "";
	if (isSilentReplyText(trimmedMessage) && !opts.mediaUrl && !opts.blocks) {
		logVerbose("slack send: suppressed NO_REPLY token before API call");
		return {
			messageId: "suppressed",
			channelId: ""
		};
	}
	const blocks = opts.blocks == null ? void 0 : validateSlackBlocksArray(opts.blocks);
	if (!trimmedMessage && !opts.mediaUrl && !blocks) throw new Error("Slack send requires text, blocks, or media");
	const cfg = requireRuntimeConfig(opts.cfg, "Slack send");
	const account = resolveSlackAccount({
		cfg,
		accountId: opts.accountId
	});
	const token = resolveToken({
		explicit: opts.token,
		accountId: account.accountId,
		fallbackToken: account.botToken,
		fallbackSource: account.botTokenSource
	});
	const recipient = parseRecipient(to);
	return await runQueuedSlackSend(createSlackSendQueueKey({
		accountId: account.accountId,
		token,
		recipient,
		threadTs: opts.threadTs
	}), () => sendMessageSlackQueued({
		trimmedMessage,
		opts,
		cfg,
		account,
		token,
		recipient,
		blocks
	}));
}
async function sendMessageSlackQueued(params) {
	try {
		return await sendMessageSlackQueuedInner(params);
	} catch (err) {
		throw enrichSlackWebApiError(err);
	}
}
async function sendMessageSlackQueuedInner(params) {
	const { opts, cfg, account, token, recipient, blocks, trimmedMessage } = params;
	const client = opts.client ?? getSlackWriteClient(token);
	const directUserPostChannelId = resolveDirectUserPostChannelId({
		recipient,
		hasMedia: Boolean(opts.mediaUrl),
		...opts.threadTs ? { threadTs: opts.threadTs } : {}
	});
	const { channelId } = directUserPostChannelId ? { channelId: directUserPostChannelId } : await resolveChannelId(client, recipient, {
		accountId: account.accountId,
		token
	});
	if (blocks) {
		if (opts.mediaUrl) throw new Error("Slack send does not support blocks with mediaUrl");
		return {
			messageId: (await postSlackMessageBestEffort({
				client,
				channelId,
				text: truncateSlackText(trimmedMessage || buildSlackBlocksFallbackText(blocks), 8e3),
				threadTs: opts.threadTs,
				identity: opts.identity,
				blocks
			})).ts ?? "unknown",
			channelId
		};
	}
	const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId, { fallbackLimit: SLACK_TEXT_LIMIT });
	const chunkLimit = Math.min(textLimit, SLACK_TEXT_LIMIT);
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "slack",
		accountId: account.accountId
	});
	const chunkMode = resolveChunkMode(cfg, "slack", account.accountId);
	const resolvedChunks = resolveTextChunksWithFallback(trimmedMessage, (chunkMode === "newline" ? chunkMarkdownTextWithMode(trimmedMessage, chunkLimit, chunkMode) : [trimmedMessage]).flatMap((markdown) => markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode })));
	const mediaMaxBytes = typeof account.config.mediaMaxMb === "number" ? account.config.mediaMaxMb * 1024 * 1024 : void 0;
	let lastMessageId = "";
	if (opts.mediaUrl) {
		const [firstChunk, ...rest] = resolvedChunks;
		lastMessageId = await uploadSlackFile({
			client,
			channelId,
			mediaUrl: opts.mediaUrl,
			mediaAccess: opts.mediaAccess,
			uploadFileName: opts.uploadFileName,
			uploadTitle: opts.uploadTitle,
			mediaLocalRoots: opts.mediaLocalRoots,
			mediaReadFile: opts.mediaReadFile,
			caption: firstChunk,
			threadTs: opts.threadTs,
			maxBytes: mediaMaxBytes
		});
		for (const chunk of rest) lastMessageId = (await postSlackMessageBestEffort({
			client,
			channelId,
			text: chunk,
			threadTs: opts.threadTs,
			identity: opts.identity
		})).ts ?? lastMessageId;
	} else for (const chunk of resolvedChunks.length ? resolvedChunks : [""]) lastMessageId = (await postSlackMessageBestEffort({
		client,
		channelId,
		text: chunk,
		threadTs: opts.threadTs,
		identity: opts.identity
	})).ts ?? lastMessageId;
	return {
		messageId: lastMessageId || "unknown",
		channelId
	};
}
//#endregion
export { buildSlackBlocksFallbackText as i, markdownToSlackMrkdwnChunks as n, normalizeSlackOutboundText as r, sendMessageSlack as t };
