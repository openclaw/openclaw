import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { M as logVerbose } from "./utils-BKDT474X.js";
import { zt as loadConfig } from "./model-selection-DILdVnl8.js";
import { h as resolveSlackAccount, v as resolveSlackBotToken } from "./plugins-B9xwwhdE.js";
import { a as requireTargetKind, i as parseTargetPrefixes, n as ensureTargetId, r as parseTargetMention, t as buildMessagingTarget } from "./targets-UT6aMhwS.js";
import { i as isSilentReplyText } from "./tokens-LFopHMoh.js";
import { c as resolveChunkMode, i as chunkMarkdownTextWithMode, l as resolveTextChunkLimit } from "./chunk-Dnv6wXws.js";
import { n as resolveMarkdownTableMode } from "./markdown-tables-ncF_g1sJ.js";
import { a as loadWebMedia, n as markdownToIR, t as chunkMarkdownIR } from "./ir-DvzfoshW.js";
import { t as renderMarkdownWithMarkers } from "./render-CAaBsF7l.js";
import { WebClient } from "@slack/web-api";

//#region src/slack/targets.ts
function parseSlackTarget(raw, options = {}) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	const mentionTarget = parseTargetMention({
		raw: trimmed,
		mentionPattern: /^<@([A-Z0-9]+)>$/i,
		kind: "user"
	});
	if (mentionTarget) return mentionTarget;
	const prefixedTarget = parseTargetPrefixes({
		raw: trimmed,
		prefixes: [
			{
				prefix: "user:",
				kind: "user"
			},
			{
				prefix: "channel:",
				kind: "channel"
			},
			{
				prefix: "slack:",
				kind: "user"
			}
		]
	});
	if (prefixedTarget) return prefixedTarget;
	if (trimmed.startsWith("@")) return buildMessagingTarget("user", ensureTargetId({
		candidate: trimmed.slice(1).trim(),
		pattern: /^[A-Z0-9]+$/i,
		errorMessage: "Slack DMs require a user id (use user:<id> or <@id>)"
	}), trimmed);
	if (trimmed.startsWith("#")) return buildMessagingTarget("channel", ensureTargetId({
		candidate: trimmed.slice(1).trim(),
		pattern: /^[A-Z0-9]+$/i,
		errorMessage: "Slack channels require a channel id (use channel:<id>)"
	}), trimmed);
	if (options.defaultKind) return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
	return buildMessagingTarget("channel", trimmed, trimmed);
}
function resolveSlackChannelId(raw) {
	return requireTargetKind({
		platform: "Slack",
		target: parseSlackTarget(raw, { defaultKind: "channel" }),
		kind: "channel"
	});
}

//#endregion
//#region src/slack/client.ts
const SLACK_DEFAULT_RETRY_OPTIONS = {
	retries: 2,
	factor: 2,
	minTimeout: 500,
	maxTimeout: 3e3,
	randomize: true
};
function resolveSlackWebClientOptions(options = {}) {
	return {
		...options,
		retryConfig: options.retryConfig ?? SLACK_DEFAULT_RETRY_OPTIONS
	};
}
function createSlackWebClient(token, options = {}) {
	return new WebClient(token, resolveSlackWebClientOptions(options));
}

//#endregion
//#region src/slack/blocks-fallback.ts
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
//#region src/slack/blocks-input.ts
const SLACK_MAX_BLOCKS = 50;
function parseBlocksJson(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error("blocks must be valid JSON");
	}
}
function assertBlocksArray(raw) {
	if (!Array.isArray(raw)) throw new Error("blocks must be an array");
	if (raw.length === 0) throw new Error("blocks must contain at least one block");
	if (raw.length > SLACK_MAX_BLOCKS) throw new Error(`blocks cannot exceed ${SLACK_MAX_BLOCKS} items`);
	for (const block of raw) {
		if (!block || typeof block !== "object" || Array.isArray(block)) throw new Error("each block must be an object");
		const type = block.type;
		if (typeof type !== "string" || type.trim().length === 0) throw new Error("each block must include a non-empty string type");
	}
}
function validateSlackBlocksArray(raw) {
	assertBlocksArray(raw);
	return raw;
}
function parseSlackBlocksInput(raw) {
	if (raw == null) return;
	return validateSlackBlocksArray(typeof raw === "string" ? parseBlocksJson(raw) : raw);
}

//#endregion
//#region src/slack/format.ts
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
function markdownToSlackMrkdwnChunks(markdown, limit, options = {}) {
	const chunks = chunkMarkdownIR(markdownToIR(markdown ?? "", {
		linkify: false,
		autolink: false,
		headingStyle: "bold",
		blockquotePrefix: "> ",
		tableMode: options.tableMode
	}), limit);
	const renderOptions = buildSlackRenderOptions();
	return chunks.map((chunk) => renderMarkdownWithMarkers(chunk, renderOptions));
}

//#endregion
//#region src/slack/send.ts
var send_exports = /* @__PURE__ */ __exportAll({ sendMessageSlack: () => sendMessageSlack });
const SLACK_TEXT_LIMIT = 4e3;
function hasCustomIdentity(identity) {
	return Boolean(identity?.username || identity?.iconUrl || identity?.iconEmoji);
}
function isSlackCustomizeScopeError(err) {
	if (!(err instanceof Error)) return false;
	const maybeData = err;
	if (maybeData.data?.error?.toLowerCase() !== "missing_scope") return false;
	if ((maybeData.data?.needed?.toLowerCase())?.includes("chat:write.customize")) return true;
	return [...maybeData.data?.response_metadata?.scopes ?? [], ...maybeData.data?.response_metadata?.acceptedScopes ?? []].map((scope) => scope.toLowerCase()).includes("chat:write.customize");
}
async function postSlackMessageBestEffort(params) {
	const basePayload = {
		channel: params.channelId,
		text: params.text,
		thread_ts: params.threadTs,
		...params.blocks?.length ? { blocks: params.blocks } : {}
	};
	try {
		if (params.identity?.iconUrl) return await params.client.chat.postMessage({
			...basePayload,
			...params.identity.username ? { username: params.identity.username } : {},
			icon_url: params.identity.iconUrl
		});
		if (params.identity?.iconEmoji) return await params.client.chat.postMessage({
			...basePayload,
			...params.identity.username ? { username: params.identity.username } : {},
			icon_emoji: params.identity.iconEmoji
		});
		return await params.client.chat.postMessage({
			...basePayload,
			...params.identity?.username ? { username: params.identity.username } : {}
		});
	} catch (err) {
		if (!hasCustomIdentity(params.identity) || !isSlackCustomizeScopeError(err)) throw err;
		logVerbose("slack send: missing chat:write.customize, retrying without custom identity");
		return params.client.chat.postMessage(basePayload);
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
async function resolveChannelId(client, recipient) {
	if (!(recipient.kind === "user" || /^U[A-Z0-9]+$/i.test(recipient.id))) return { channelId: recipient.id };
	const channelId = (await client.conversations.open({ users: recipient.id })).channel?.id;
	if (!channelId) throw new Error("Failed to open Slack DM channel");
	return {
		channelId,
		isDm: true
	};
}
async function uploadSlackFile(params) {
	const { buffer, contentType: _contentType, fileName } = await loadWebMedia(params.mediaUrl, {
		maxBytes: params.maxBytes,
		localRoots: params.mediaLocalRoots
	});
	const basePayload = {
		channel_id: params.channelId,
		file: buffer,
		filename: fileName,
		...params.caption ? { initial_comment: params.caption } : {}
	};
	const payload = params.threadTs ? {
		...basePayload,
		thread_ts: params.threadTs
	} : basePayload;
	const parsed = await params.client.files.uploadV2(payload);
	return parsed.files?.[0]?.id ?? parsed.file?.id ?? parsed.files?.[0]?.name ?? parsed.file?.name ?? "unknown";
}
async function sendMessageSlack(to, message, opts = {}) {
	const trimmedMessage = message?.trim() ?? "";
	if (isSilentReplyText(trimmedMessage) && !opts.mediaUrl && !opts.blocks) {
		logVerbose("slack send: suppressed NO_REPLY token before API call");
		return {
			messageId: "suppressed",
			channelId: ""
		};
	}
	const blocks = opts.blocks == null ? void 0 : validateSlackBlocksArray(opts.blocks);
	if (!trimmedMessage && !opts.mediaUrl && !blocks) throw new Error("Slack send requires text, blocks, or media");
	const cfg = loadConfig();
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
	const client = opts.client ?? createSlackWebClient(token);
	const { channelId } = await resolveChannelId(client, parseRecipient(to));
	if (blocks) {
		if (opts.mediaUrl) throw new Error("Slack send does not support blocks with mediaUrl");
		return {
			messageId: (await postSlackMessageBestEffort({
				client,
				channelId,
				text: trimmedMessage || buildSlackBlocksFallbackText(blocks),
				threadTs: opts.threadTs,
				identity: opts.identity,
				blocks
			})).ts ?? "unknown",
			channelId
		};
	}
	const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId);
	const chunkLimit = Math.min(textLimit, SLACK_TEXT_LIMIT);
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "slack",
		accountId: account.accountId
	});
	const chunkMode = resolveChunkMode(cfg, "slack", account.accountId);
	const chunks = (chunkMode === "newline" ? chunkMarkdownTextWithMode(trimmedMessage, chunkLimit, chunkMode) : [trimmedMessage]).flatMap((markdown) => markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode }));
	if (!chunks.length && trimmedMessage) chunks.push(trimmedMessage);
	const mediaMaxBytes = typeof account.config.mediaMaxMb === "number" ? account.config.mediaMaxMb * 1024 * 1024 : void 0;
	let lastMessageId = "";
	if (opts.mediaUrl) {
		const [firstChunk, ...rest] = chunks;
		lastMessageId = await uploadSlackFile({
			client,
			channelId,
			mediaUrl: opts.mediaUrl,
			mediaLocalRoots: opts.mediaLocalRoots,
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
	} else for (const chunk of chunks.length ? chunks : [""]) lastMessageId = (await postSlackMessageBestEffort({
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
export { validateSlackBlocksArray as a, resolveSlackWebClientOptions as c, parseSlackBlocksInput as i, parseSlackTarget as l, send_exports as n, buildSlackBlocksFallbackText as o, markdownToSlackMrkdwnChunks as r, createSlackWebClient as s, sendMessageSlack as t, resolveSlackChannelId as u };