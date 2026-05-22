import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, l as normalizeOptionalStringifiedId } from "./string-coerce-Bje8XVt9.js";
import { n as normalizePollInput } from "./polls-CXU6j-rl.js";
import { n as isAutoLinkedFileRef } from "./auto-linked-file-ref-Ch-g-5Da.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-BDAD-n-2.js";
import { t as loadOutboundMediaFromUrl } from "./outbound-media-ggFx4c0j.js";
import "./string-coerce-runtime-BMQDVfjj.js";
import "./text-autolink-runtime-fBg92li4.js";
import { r as normalizeMatrixResolvableTarget, t as isMatrixQualifiedUserId } from "./target-ids-C8KQ4eae.js";
import { a as resolveMatrixAccountConfig } from "./account-config-DPwuBgNJ.js";
import { t as getMatrixRuntime } from "./runtime-DUC28Ljq.js";
import { r as buildMatrixReactionContent } from "./reaction-common-CAW2jmh4.js";
import { a as EventType, c as MsgType, l as RelationType, n as persistMatrixDirectRoomMapping, s as MSC4357_LIVE_KEY, t as inspectMatrixDirectRooms } from "./direct-management-qCzzxGMp.js";
import { r as parseBuffer } from "./lib-etXXlJEP.js";
import { i as isStrictDirectRoom } from "./direct-room-mEc4SD-G.js";
import MarkdownIt from "markdown-it";
//#region extensions/matrix/src/matrix/poll-types.ts
/**
* Matrix Poll Types (MSC3381)
*
* Defines types for Matrix poll events:
* - m.poll.start - Creates a new poll
* - m.poll.response - Records a vote
* - m.poll.end - Closes a poll
*/
const M_POLL_START = "m.poll.start";
const M_POLL_RESPONSE = "m.poll.response";
const M_POLL_END = "m.poll.end";
const ORG_POLL_START = "org.matrix.msc3381.poll.start";
const ORG_POLL_RESPONSE = "org.matrix.msc3381.poll.response";
const ORG_POLL_END = "org.matrix.msc3381.poll.end";
const POLL_EVENT_TYPES = [
	M_POLL_START,
	M_POLL_RESPONSE,
	M_POLL_END,
	ORG_POLL_START,
	ORG_POLL_RESPONSE,
	ORG_POLL_END
];
const POLL_START_TYPES = [M_POLL_START, ORG_POLL_START];
const POLL_RESPONSE_TYPES = [M_POLL_RESPONSE, ORG_POLL_RESPONSE];
const POLL_END_TYPES = [M_POLL_END, ORG_POLL_END];
function isPollStartType(eventType) {
	return POLL_START_TYPES.includes(eventType);
}
function isPollResponseType(eventType) {
	return POLL_RESPONSE_TYPES.includes(eventType);
}
function isPollEndType(eventType) {
	return POLL_END_TYPES.includes(eventType);
}
function isPollEventType(eventType) {
	return POLL_EVENT_TYPES.includes(eventType);
}
function getTextContent(text) {
	if (!text) return "";
	return text["m.text"] ?? text["org.matrix.msc1767.text"] ?? text.body ?? "";
}
function parsePollStart(content) {
	const poll = content["m.poll.start"] ?? content[ORG_POLL_START] ?? content["m.poll"];
	if (!poll) return null;
	const question = getTextContent(poll.question).trim();
	if (!question) return null;
	const answers = poll.answers.map((answer) => ({
		id: answer.id,
		text: getTextContent(answer).trim()
	})).filter((answer) => answer.id.trim().length > 0 && answer.text.length > 0);
	if (answers.length === 0) return null;
	const maxSelectionsRaw = poll.max_selections;
	const maxSelections = typeof maxSelectionsRaw === "number" && Number.isFinite(maxSelectionsRaw) ? Math.floor(maxSelectionsRaw) : 1;
	return {
		question,
		answers,
		kind: poll.kind ?? "m.poll.disclosed",
		maxSelections: Math.min(Math.max(maxSelections, 1), answers.length)
	};
}
function parsePollStartContent(content) {
	const parsed = parsePollStart(content);
	if (!parsed) return null;
	return {
		eventId: "",
		roomId: "",
		sender: "",
		senderName: "",
		question: parsed.question,
		answers: parsed.answers.map((answer) => answer.text),
		kind: parsed.kind,
		maxSelections: parsed.maxSelections
	};
}
function formatPollAsText(summary) {
	return [
		"[Poll]",
		summary.question,
		"",
		...summary.answers.map((answer, idx) => `${idx + 1}. ${answer}`)
	].join("\n");
}
function resolvePollReferenceEventId(content) {
	if (!content || typeof content !== "object") return null;
	const relates = content["m.relates_to"];
	if (!relates || typeof relates.event_id !== "string") return null;
	const eventId = relates.event_id.trim();
	return eventId.length > 0 ? eventId : null;
}
function parsePollResponseAnswerIds(content) {
	if (!content || typeof content !== "object") return null;
	const response = content[M_POLL_RESPONSE] ?? content[ORG_POLL_RESPONSE];
	if (!response || !Array.isArray(response.answers)) return null;
	return response.answers.filter((answer) => typeof answer === "string");
}
function buildPollResultsSummary(params) {
	const parsed = parsePollStart(params.content);
	if (!parsed) return null;
	let pollClosedAt = Number.POSITIVE_INFINITY;
	for (const event of params.relationEvents) {
		if (event.unsigned?.redacted_because) continue;
		if (!isPollEndType(typeof event.type === "string" ? event.type : "")) continue;
		if (event.sender !== params.sender) continue;
		const ts = typeof event.origin_server_ts === "number" && Number.isFinite(event.origin_server_ts) ? event.origin_server_ts : Number.POSITIVE_INFINITY;
		if (ts < pollClosedAt) pollClosedAt = ts;
	}
	const answerIds = new Set(parsed.answers.map((answer) => answer.id));
	const latestVoteBySender = /* @__PURE__ */ new Map();
	const orderedRelationEvents = [...params.relationEvents].toSorted((left, right) => {
		const leftTs = typeof left.origin_server_ts === "number" && Number.isFinite(left.origin_server_ts) ? left.origin_server_ts : Number.POSITIVE_INFINITY;
		const rightTs = typeof right.origin_server_ts === "number" && Number.isFinite(right.origin_server_ts) ? right.origin_server_ts : Number.POSITIVE_INFINITY;
		if (leftTs !== rightTs) return leftTs - rightTs;
		return (left.event_id ?? "").localeCompare(right.event_id ?? "");
	});
	for (const event of orderedRelationEvents) {
		if (event.unsigned?.redacted_because) continue;
		if (!isPollResponseType(typeof event.type === "string" ? event.type : "")) continue;
		const senderId = normalizeOptionalString(event.sender) ?? "";
		if (!senderId) continue;
		const eventTs = typeof event.origin_server_ts === "number" && Number.isFinite(event.origin_server_ts) ? event.origin_server_ts : Number.POSITIVE_INFINITY;
		if (eventTs > pollClosedAt) continue;
		const rawAnswers = parsePollResponseAnswerIds(event.content) ?? [];
		const normalizedAnswers = Array.from(new Set(rawAnswers.map((answerId) => normalizeOptionalString(answerId) ?? "").filter((answerId) => answerIds.has(answerId)).slice(0, parsed.maxSelections)));
		latestVoteBySender.set(senderId, {
			ts: eventTs,
			eventId: typeof event.event_id === "string" ? event.event_id : "",
			answerIds: normalizedAnswers
		});
	}
	const voteCounts = new Map(parsed.answers.map((answer) => [answer.id, 0]));
	let totalVotes = 0;
	for (const latestVote of latestVoteBySender.values()) {
		if (latestVote.answerIds.length === 0) continue;
		totalVotes += 1;
		for (const answerId of latestVote.answerIds) voteCounts.set(answerId, (voteCounts.get(answerId) ?? 0) + 1);
	}
	return {
		eventId: params.pollEventId,
		roomId: params.roomId,
		sender: params.sender,
		senderName: params.senderName,
		question: parsed.question,
		answers: parsed.answers.map((answer) => answer.text),
		kind: parsed.kind,
		maxSelections: parsed.maxSelections,
		entries: parsed.answers.map((answer) => ({
			id: answer.id,
			text: answer.text,
			votes: voteCounts.get(answer.id) ?? 0
		})),
		totalVotes,
		closed: Number.isFinite(pollClosedAt)
	};
}
function formatPollResultsAsText(summary) {
	const lines = [
		summary.closed ? "[Poll closed]" : "[Poll]",
		summary.question,
		""
	];
	const revealResults = summary.kind === "m.poll.disclosed" || summary.closed;
	for (const [index, entry] of summary.entries.entries()) {
		if (!revealResults) {
			lines.push(`${index + 1}. ${entry.text}`);
			continue;
		}
		lines.push(`${index + 1}. ${entry.text} (${entry.votes} vote${entry.votes === 1 ? "" : "s"})`);
	}
	lines.push("");
	if (!revealResults) lines.push("Responses are hidden until the poll closes.");
	else lines.push(`Total voters: ${summary.totalVotes}`);
	return lines.join("\n");
}
function buildTextContent$1(body) {
	return {
		"m.text": body,
		"org.matrix.msc1767.text": body
	};
}
function buildPollFallbackText(question, answers) {
	if (answers.length === 0) return question;
	return `${question}\n${answers.map((answer, idx) => `${idx + 1}. ${answer}`).join("\n")}`;
}
function buildPollStartContent(poll) {
	const normalized = normalizePollInput(poll);
	const answers = normalized.options.map((option, idx) => ({
		id: `answer${idx + 1}`,
		...buildTextContent$1(option)
	}));
	const isMultiple = normalized.maxSelections > 1;
	const fallbackText = buildPollFallbackText(normalized.question, answers.map((answer) => getTextContent(answer)));
	return {
		[M_POLL_START]: {
			question: buildTextContent$1(normalized.question),
			kind: isMultiple ? "m.poll.undisclosed" : "m.poll.disclosed",
			max_selections: normalized.maxSelections,
			answers
		},
		"m.text": fallbackText,
		"org.matrix.msc1767.text": fallbackText
	};
}
function buildPollResponseContent(pollEventId, answerIds) {
	return {
		[M_POLL_RESPONSE]: { answers: answerIds },
		[ORG_POLL_RESPONSE]: { answers: answerIds },
		"m.relates_to": {
			rel_type: "m.reference",
			event_id: pollEventId
		}
	};
}
//#endregion
//#region extensions/matrix/src/matrix/send/client.ts
let matrixSendClientRuntimePromise = null;
async function loadMatrixSendClientRuntime() {
	matrixSendClientRuntimePromise ??= import("./client-bootstrap-B7O9hc84.js");
	return await matrixSendClientRuntimePromise;
}
function resolveMediaMaxBytes(accountId, cfg) {
	if (!cfg) throw new Error("Matrix media limits requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.");
	const matrixCfg = resolveMatrixAccountConfig({
		cfg: requireRuntimeConfig(cfg, "Matrix media limits"),
		accountId
	});
	const mediaMaxMb = typeof matrixCfg.mediaMaxMb === "number" ? matrixCfg.mediaMaxMb : void 0;
	if (typeof mediaMaxMb === "number") return mediaMaxMb * 1024 * 1024;
}
async function withResolvedMatrixSendClient(opts, run) {
	return await withResolvedMatrixClient({
		...opts,
		readiness: "started"
	}, run, "persist");
}
async function withResolvedMatrixControlClient(opts, run) {
	return await withResolvedMatrixClient({
		...opts,
		readiness: "none"
	}, run);
}
async function withResolvedMatrixClient(opts, run, shutdownBehavior) {
	if (opts.client) return await run(opts.client);
	const { withResolvedRuntimeMatrixClient } = await loadMatrixSendClientRuntime();
	return await withResolvedRuntimeMatrixClient(opts, run, shutdownBehavior);
}
//#endregion
//#region extensions/matrix/src/matrix/format.ts
const md = new MarkdownIt({
	html: false,
	linkify: true,
	breaks: true,
	typographer: false
});
md.enable("strikethrough");
const { escapeHtml } = md.utils;
const ESCAPED_MENTION_SENTINEL = "";
const MENTION_PATTERN = /@[A-Za-z0-9._=+\-/:[\]]+/g;
const MATRIX_MENTION_USER_ID_PATTERN = /^@[A-Za-z0-9._=+\-/]+:(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d+)?$/;
const TRIMMABLE_MENTION_SUFFIX = /[),.!?:;\]]/;
function shouldSuppressAutoLink(tokens, idx) {
	const token = tokens[idx];
	if (token?.type !== "link_open" || token.info !== "auto") return false;
	const href = token.attrGet("href") ?? "";
	const label = tokens[idx + 1]?.type === "text" ? tokens[idx + 1]?.content ?? "" : "";
	return Boolean(href && label && isAutoLinkedFileRef(href, label));
}
md.renderer.rules.image = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");
md.renderer.rules.html_block = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");
md.renderer.rules.html_inline = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");
md.renderer.rules.link_open = (tokens, idx, _options, _env, self) => shouldSuppressAutoLink(tokens, idx) ? "" : self.renderToken(tokens, idx, _options);
md.renderer.rules.link_close = (tokens, idx, _options, _env, self) => {
	const openIdx = idx - 2;
	if (openIdx >= 0 && shouldSuppressAutoLink(tokens, openIdx)) return "";
	return self.renderToken(tokens, idx, _options);
};
function maskEscapedMentions(markdown) {
	let masked = "";
	let idx = 0;
	let codeFenceLength = 0;
	while (idx < markdown.length) {
		if (markdown[idx] === "`" && !isMarkdownEscaped(markdown, idx)) {
			let runLength = 1;
			while (markdown[idx + runLength] === "`") runLength += 1;
			if (codeFenceLength === 0) codeFenceLength = runLength;
			else if (runLength === codeFenceLength) codeFenceLength = 0;
			masked += markdown.slice(idx, idx + runLength);
			idx += runLength;
			continue;
		}
		if (codeFenceLength === 0 && markdown[idx] === "\\" && markdown[idx + 1] === "@") {
			masked += ESCAPED_MENTION_SENTINEL;
			idx += 2;
			continue;
		}
		masked += markdown[idx] ?? "";
		idx += 1;
	}
	return masked;
}
function isMarkdownEscaped(markdown, idx) {
	let slashCount = 0;
	let cursor = idx - 1;
	while (cursor >= 0 && markdown[cursor] === "\\") {
		slashCount += 1;
		cursor -= 1;
	}
	return slashCount % 2 === 1;
}
function restoreEscapedMentions(text) {
	return text.replaceAll(ESCAPED_MENTION_SENTINEL, "@");
}
function restoreEscapedMentionsInCode(text) {
	return text.replaceAll(ESCAPED_MENTION_SENTINEL, "\\@");
}
function restoreEscapedMentionsInBlockTokens(tokens) {
	for (const token of tokens) if ((token.type === "fence" || token.type === "code_block") && token.content) token.content = restoreEscapedMentionsInCode(token.content);
}
function isMentionStartBoundary(charBefore) {
	return !charBefore || !/[A-Za-z0-9_]/.test(charBefore);
}
function trimMentionSuffix(raw, end) {
	while (raw.length > 1 && TRIMMABLE_MENTION_SUFFIX.test(raw.at(-1) ?? "")) {
		if (raw.at(-1) === "]" && /\[[0-9A-Fa-f:.]+\](?::\d+)?$/i.test(raw)) break;
		raw = raw.slice(0, -1);
		end -= 1;
	}
	if (!raw.startsWith("@") || raw === "@") return null;
	return {
		raw,
		end
	};
}
function isMatrixMentionUserId(raw) {
	return isMatrixQualifiedUserId(raw) && MATRIX_MENTION_USER_ID_PATTERN.test(raw);
}
function buildMentionCandidate(raw, start) {
	const normalized = trimMentionSuffix(raw, start + raw.length);
	if (!normalized) return null;
	const kind = normalizeLowercaseStringOrEmpty(normalized.raw) === "@room" ? "room" : "user";
	const base = {
		raw: normalized.raw,
		start,
		end: normalized.end,
		kind
	};
	if (kind === "room") return base;
	const userCandidate = isMatrixMentionUserId(normalized.raw) ? {
		...base,
		userId: normalized.raw
	} : null;
	if (!userCandidate) return null;
	return userCandidate;
}
function collectMentionCandidates(text) {
	const mentions = [];
	for (const match of text.matchAll(MENTION_PATTERN)) {
		const raw = match[0];
		const start = match.index ?? -1;
		if (start < 0 || !raw) continue;
		if (!isMentionStartBoundary(text[start - 1])) continue;
		const candidate = buildMentionCandidate(raw, start);
		if (!candidate) continue;
		mentions.push(candidate);
	}
	return mentions;
}
function createToken(sample, type, tag, nesting) {
	const TokenCtor = sample.constructor;
	return new TokenCtor(type, tag, nesting);
}
function createTextToken(sample, content) {
	const token = createToken(sample, "text", "", 0);
	token.content = content;
	return token;
}
function createMentionLinkTokens(params) {
	const open = createToken(params.sample, "link_open", "a", 1);
	open.attrSet("href", params.href);
	return [
		open,
		createTextToken(params.sample, params.label),
		createToken(params.sample, "link_close", "a", -1)
	];
}
function resolveMentionUserId(match) {
	if (match.kind !== "user") return null;
	return match.userId ?? null;
}
async function resolveMatrixSelfUserId(client) {
	const getUserId = client.getUserId;
	if (typeof getUserId !== "function") return null;
	return await Promise.resolve(getUserId.call(client)).catch(() => null);
}
function mutateInlineTokensWithMentions(params) {
	const nextChildren = [];
	let roomMentioned = false;
	let insideLinkDepth = 0;
	for (const child of params.children) {
		if (child.type === "link_open") {
			insideLinkDepth += 1;
			nextChildren.push(child);
			continue;
		}
		if (child.type === "link_close") {
			insideLinkDepth = Math.max(0, insideLinkDepth - 1);
			nextChildren.push(child);
			continue;
		}
		if (child.type !== "text" || !child.content) {
			nextChildren.push(child);
			continue;
		}
		const visibleContent = restoreEscapedMentions(child.content);
		if (insideLinkDepth > 0) {
			nextChildren.push(createTextToken(child, visibleContent));
			continue;
		}
		const matches = collectMentionCandidates(child.content);
		if (matches.length === 0) {
			nextChildren.push(createTextToken(child, visibleContent));
			continue;
		}
		let cursor = 0;
		for (const match of matches) {
			if (match.start > cursor) nextChildren.push(createTextToken(child, restoreEscapedMentions(child.content.slice(cursor, match.start))));
			cursor = match.end;
			if (match.kind === "room") {
				roomMentioned = true;
				nextChildren.push(createTextToken(child, match.raw));
				continue;
			}
			const resolvedUserId = resolveMentionUserId(match);
			if (!resolvedUserId || resolvedUserId === params.selfUserId) {
				nextChildren.push(createTextToken(child, match.raw));
				continue;
			}
			if (!params.seenUserIds.has(resolvedUserId)) {
				params.seenUserIds.add(resolvedUserId);
				params.userIds.push(resolvedUserId);
			}
			nextChildren.push(...createMentionLinkTokens({
				sample: child,
				href: `https://matrix.to/#/${encodeURIComponent(resolvedUserId)}`,
				label: match.raw
			}));
		}
		if (cursor < child.content.length) nextChildren.push(createTextToken(child, restoreEscapedMentions(child.content.slice(cursor))));
	}
	return {
		children: nextChildren,
		roomMentioned
	};
}
function compactLooseListTokens(tokens) {
	const listItemStack = [];
	for (const [index, token] of tokens.entries()) {
		if (token.type === "list_item_open") {
			listItemStack.push({
				level: token.level,
				immediateParagraphOpenIndexes: [],
				immediateParagraphCloseIndexes: []
			});
			continue;
		}
		if (token.type === "list_item_close") {
			const item = listItemStack.pop();
			if (item && item.immediateParagraphOpenIndexes.length === 1 && item.immediateParagraphCloseIndexes.length === 1) {
				tokens[item.immediateParagraphOpenIndexes[0]].hidden = true;
				tokens[item.immediateParagraphCloseIndexes[0]].hidden = true;
			}
			continue;
		}
		const currentItem = listItemStack.at(-1);
		if (!currentItem || token.level !== currentItem.level + 1) continue;
		if (token.type === "paragraph_open") currentItem.immediateParagraphOpenIndexes.push(index);
		else if (token.type === "paragraph_close") currentItem.immediateParagraphCloseIndexes.push(index);
	}
}
function markdownToMatrixHtml(markdown) {
	const tokens = md.parse(markdown ?? "", {});
	compactLooseListTokens(tokens);
	return md.renderer.render(tokens, md.options, {}).trimEnd();
}
async function resolveMarkdownMentionState(params) {
	const markdown = maskEscapedMentions(params.markdown ?? "");
	const tokens = md.parse(markdown, {});
	restoreEscapedMentionsInBlockTokens(tokens);
	const selfUserId = await resolveMatrixSelfUserId(params.client);
	const userIds = [];
	const seenUserIds = /* @__PURE__ */ new Set();
	let roomMentioned = false;
	for (const token of tokens) {
		if (!token.children?.length) continue;
		const mutated = mutateInlineTokensWithMentions({
			children: token.children,
			userIds,
			seenUserIds,
			selfUserId
		});
		token.children = mutated.children;
		roomMentioned ||= mutated.roomMentioned;
	}
	const mentions = {};
	if (userIds.length > 0) mentions.user_ids = userIds;
	if (roomMentioned) mentions.room = true;
	return {
		tokens,
		mentions
	};
}
async function resolveMatrixMentionsInMarkdown(params) {
	return (await resolveMarkdownMentionState(params)).mentions;
}
async function renderMarkdownToMatrixHtmlWithMentions(params) {
	const state = await resolveMarkdownMentionState(params);
	compactLooseListTokens(state.tokens);
	return {
		html: md.renderer.render(state.tokens, md.options, {}).trimEnd() || void 0,
		mentions: state.mentions
	};
}
//#endregion
//#region extensions/matrix/src/matrix/send/formatting.ts
const getCore$2 = () => getMatrixRuntime();
async function renderMatrixFormattedContent(params) {
	const markdown = params.markdown ?? "";
	if (params.includeMentions === false) return { html: markdownToMatrixHtml(markdown).trimEnd() || void 0 };
	const { html, mentions } = await renderMarkdownToMatrixHtmlWithMentions({
		markdown,
		client: params.client
	});
	return {
		html,
		mentions
	};
}
function buildTextContent(body, relation, opts = {}) {
	const msgtype = opts.msgtype ?? MsgType.Text;
	return relation ? {
		msgtype,
		body,
		"m.relates_to": relation
	} : {
		msgtype,
		body
	};
}
async function enrichMatrixFormattedContent(params) {
	const { html, mentions } = await renderMatrixFormattedContent({
		client: params.client,
		markdown: params.markdown,
		includeMentions: params.includeMentions
	});
	if (mentions) params.content["m.mentions"] = mentions;
	else delete params.content["m.mentions"];
	if (!html) {
		delete params.content.format;
		delete params.content.formatted_body;
		return;
	}
	params.content.format = "org.matrix.custom.html";
	params.content.formatted_body = html;
}
async function resolveMatrixMentionsForBody(params) {
	return await resolveMatrixMentionsInMarkdown({
		markdown: params.body ?? "",
		client: params.client
	});
}
function normalizeMentionUserIds(value) {
	return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.trim().length > 0) : [];
}
function extractMatrixMentions(content) {
	const rawMentions = content?.["m.mentions"];
	if (!rawMentions || typeof rawMentions !== "object") return {};
	const mentions = rawMentions;
	const normalized = {};
	const userIds = normalizeMentionUserIds(mentions.user_ids);
	if (userIds.length > 0) normalized.user_ids = userIds;
	if (mentions.room === true) normalized.room = true;
	return normalized;
}
function diffMatrixMentions(current, previous) {
	const previousUserIds = new Set(previous.user_ids ?? []);
	const newUserIds = (current.user_ids ?? []).filter((userId) => !previousUserIds.has(userId));
	const delta = {};
	if (newUserIds.length > 0) delta.user_ids = newUserIds;
	if (current.room && !previous.room) delta.room = true;
	return delta;
}
function buildReplyRelation(replyToId) {
	const trimmed = replyToId?.trim();
	if (!trimmed) return;
	return { "m.in_reply_to": { event_id: trimmed } };
}
function buildThreadRelation(threadId, replyToId) {
	const trimmed = threadId.trim();
	return {
		rel_type: RelationType.Thread,
		event_id: trimmed,
		is_falling_back: true,
		"m.in_reply_to": { event_id: replyToId?.trim() || trimmed }
	};
}
function resolveMatrixMsgType(contentType, _fileName) {
	switch (getCore$2().media.mediaKindFromMime(contentType ?? "")) {
		case "image": return MsgType.Image;
		case "audio": return MsgType.Audio;
		case "video": return MsgType.Video;
		default: return MsgType.File;
	}
}
function resolveMatrixVoiceDecision(opts) {
	if (!opts.wantsVoice) return { useVoice: false };
	if (isMatrixVoiceCompatibleAudio(opts)) return { useVoice: true };
	return { useVoice: false };
}
function isMatrixVoiceCompatibleAudio(opts) {
	return getCore$2().media.isVoiceCompatibleAudio({
		contentType: opts.contentType,
		fileName: opts.fileName
	});
}
//#endregion
//#region extensions/matrix/src/matrix/send/media.ts
const getCore$1 = () => getMatrixRuntime();
function buildMatrixMediaInfo(params) {
	const base = {};
	if (Number.isFinite(params.size)) base.size = params.size;
	if (params.mimetype) base.mimetype = params.mimetype;
	if (params.imageInfo) {
		const dimensional = {
			...base,
			...params.imageInfo
		};
		if (typeof params.durationMs === "number") return {
			...dimensional,
			duration: params.durationMs
		};
		return dimensional;
	}
	if (typeof params.durationMs === "number") return {
		...base,
		duration: params.durationMs
	};
	if (Object.keys(base).length === 0) return;
	return base;
}
function buildMediaContent(params) {
	const info = buildMatrixMediaInfo({
		size: params.size,
		mimetype: params.mimetype,
		durationMs: params.durationMs,
		imageInfo: params.imageInfo
	});
	const base = {
		msgtype: params.msgtype,
		body: params.body,
		filename: params.filename,
		info: info ?? void 0
	};
	if (!params.file && params.url) base.url = params.url;
	if (params.file) base.file = params.file;
	if (params.isVoice) {
		base["org.matrix.msc3245.voice"] = {};
		if (typeof params.durationMs === "number") base["org.matrix.msc1767.audio"] = { duration: params.durationMs };
	}
	if (params.relation) base["m.relates_to"] = params.relation;
	return base;
}
const THUMBNAIL_MAX_SIDE = 800;
const THUMBNAIL_QUALITY = 80;
async function prepareImageInfo(params) {
	const meta = await getCore$1().media.getImageMetadata(params.buffer).catch(() => null);
	if (!meta) return;
	const imageInfo = {
		w: meta.width,
		h: meta.height
	};
	if (Math.max(meta.width, meta.height) > THUMBNAIL_MAX_SIDE) try {
		const thumbBuffer = await getCore$1().media.resizeToJpeg({
			buffer: params.buffer,
			maxSide: THUMBNAIL_MAX_SIDE,
			quality: THUMBNAIL_QUALITY,
			withoutEnlargement: true
		});
		const thumbMeta = await getCore$1().media.getImageMetadata(thumbBuffer).catch(() => null);
		const result = await uploadMediaWithEncryption(params.client, thumbBuffer, {
			contentType: "image/jpeg",
			filename: "thumbnail.jpg",
			encrypted: params.encrypted === true
		});
		if (result.file) imageInfo.thumbnail_file = result.file;
		else imageInfo.thumbnail_url = result.url;
		if (thumbMeta) imageInfo.thumbnail_info = {
			w: thumbMeta.width,
			h: thumbMeta.height,
			mimetype: "image/jpeg",
			size: thumbBuffer.byteLength
		};
	} catch {}
	return imageInfo;
}
async function resolveMediaDurationMs(params) {
	if (params.kind !== "audio" && params.kind !== "video") return;
	try {
		const fileInfo = params.contentType || params.fileName ? {
			mimeType: params.contentType,
			size: params.buffer.byteLength,
			path: params.fileName
		} : void 0;
		const durationSeconds = (await parseBuffer(params.buffer, fileInfo, {
			duration: true,
			skipCovers: true
		})).format.duration;
		if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) return Math.max(0, Math.round(durationSeconds * 1e3));
	} catch {}
}
async function uploadFile(client, file, params) {
	return await client.uploadContent(file, params.contentType, params.filename);
}
async function uploadMediaWithEncryption(client, buffer, params) {
	if (params.encrypted && client.crypto) {
		const encrypted = await client.crypto.encryptMedia(buffer);
		const mxc = await client.uploadContent(encrypted.buffer, params.contentType, params.filename);
		return {
			url: mxc,
			file: {
				url: mxc,
				...encrypted.file
			}
		};
	}
	return { url: await uploadFile(client, buffer, params) };
}
/**
* Upload media with optional encryption for E2EE rooms.
*/
async function uploadMediaMaybeEncrypted(client, roomId, buffer, params) {
	const isEncrypted = Boolean(client.crypto && await client.crypto.isRoomEncrypted(roomId));
	return await uploadMediaWithEncryption(client, buffer, {
		...params,
		encrypted: isEncrypted
	});
}
//#endregion
//#region extensions/matrix/src/matrix/send/targets.ts
function normalizeTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("Matrix target is required (room:<id> or #alias)");
	return trimmed;
}
function normalizeThreadId(raw) {
	return normalizeOptionalStringifiedId(raw) ?? null;
}
const MAX_DIRECT_ROOM_CACHE_SIZE = 1024;
const directRoomCacheByClient = /* @__PURE__ */ new WeakMap();
function resolveDirectRoomCache(client) {
	const existing = directRoomCacheByClient.get(client);
	if (existing) return existing;
	const created = /* @__PURE__ */ new Map();
	directRoomCacheByClient.set(client, created);
	return created;
}
function setDirectRoomCached(client, key, value) {
	const directRoomCache = resolveDirectRoomCache(client);
	directRoomCache.set(key, value);
	if (directRoomCache.size > MAX_DIRECT_ROOM_CACHE_SIZE) {
		const oldest = directRoomCache.keys().next().value;
		if (oldest !== void 0) directRoomCache.delete(oldest);
	}
}
async function resolveDirectRoomId(client, userId) {
	const trimmed = userId.trim();
	if (!isMatrixQualifiedUserId(trimmed)) throw new Error(`Matrix user IDs must be fully qualified (got "${trimmed}")`);
	const selfUserId = (await client.getUserId().catch(() => null))?.trim() || null;
	const directRoomCache = resolveDirectRoomCache(client);
	const cached = directRoomCache.get(trimmed);
	if (cached && await isStrictDirectRoom({
		client,
		roomId: cached,
		remoteUserId: trimmed,
		selfUserId
	})) return cached;
	if (cached) directRoomCache.delete(trimmed);
	const inspection = await inspectMatrixDirectRooms({
		client,
		remoteUserId: trimmed
	});
	if (inspection.activeRoomId) {
		setDirectRoomCached(client, trimmed, inspection.activeRoomId);
		if (inspection.mappedRoomIds[0] !== inspection.activeRoomId) await persistMatrixDirectRoomMapping({
			client,
			remoteUserId: trimmed,
			roomId: inspection.activeRoomId
		}).catch(() => {});
		return inspection.activeRoomId;
	}
	throw new Error(`No direct room found for ${trimmed} (m.direct missing)`);
}
async function resolveMatrixRoomId(client, raw) {
	const target = normalizeMatrixResolvableTarget(normalizeTarget(raw));
	if (normalizeLowercaseStringOrEmpty(target).startsWith("user:")) return await resolveDirectRoomId(client, target.slice(5));
	if (isMatrixQualifiedUserId(target)) return await resolveDirectRoomId(client, target);
	if (target.startsWith("#")) {
		const resolved = await client.resolveRoom(target);
		if (!resolved) throw new Error(`Matrix alias ${target} could not be resolved`);
		return resolved;
	}
	return target;
}
//#endregion
//#region extensions/matrix/src/matrix/send.ts
const MATRIX_TEXT_LIMIT = 4e3;
const getCore = () => getMatrixRuntime();
function isMatrixClient(value) {
	return typeof value.sendEvent === "function";
}
function normalizeMatrixClientResolveOpts(opts) {
	if (!opts) return {};
	if (isMatrixClient(opts)) return { client: opts };
	return {
		client: opts.client,
		cfg: opts.cfg,
		timeoutMs: opts.timeoutMs,
		accountId: opts.accountId
	};
}
function resolvePreviousEditContent(previousEvent) {
	if (!previousEvent || typeof previousEvent !== "object") return;
	const eventRecord = previousEvent;
	if (!eventRecord.content || typeof eventRecord.content !== "object") return;
	const content = eventRecord.content;
	const newContent = content["m.new_content"];
	return newContent && typeof newContent === "object" ? newContent : content;
}
function hasMatrixMentionsMetadata(content) {
	return Boolean(content && Object.hasOwn(content, "m.mentions"));
}
function withMatrixExtraContentFields(content, extraContent) {
	if (!extraContent) return content;
	return {
		...content,
		...extraContent
	};
}
async function resolvePreviousEditMentions(params) {
	if (hasMatrixMentionsMetadata(params.content)) return extractMatrixMentions(params.content);
	const body = typeof params.content?.body === "string" ? params.content.body : "";
	if (!body) return {};
	return await resolveMatrixMentionsForBody({
		client: params.client,
		body
	});
}
function prepareMatrixSingleText(text, opts) {
	const trimmedText = text.trim();
	const cfg = requireRuntimeConfig(opts.cfg, "Matrix text preparation");
	const tableMode = opts.tableMode ?? getCore().channel.text.resolveMarkdownTableMode({
		cfg,
		channel: "matrix",
		accountId: opts.accountId
	});
	const convertedText = getCore().channel.text.convertMarkdownTables(trimmedText, tableMode);
	const singleEventLimit = Math.min(getCore().channel.text.resolveTextChunkLimit(cfg, "matrix", opts.accountId), MATRIX_TEXT_LIMIT);
	return {
		trimmedText,
		convertedText,
		singleEventLimit,
		fitsInSingleEvent: convertedText.length <= singleEventLimit
	};
}
function chunkMatrixText(text, opts) {
	const preparedText = prepareMatrixSingleText(text, opts);
	const cfg = requireRuntimeConfig(opts.cfg, "Matrix text chunking");
	const chunkMode = getCore().channel.text.resolveChunkMode(cfg, "matrix", opts.accountId);
	return {
		...preparedText,
		chunks: getCore().channel.text.chunkMarkdownTextWithMode(preparedText.convertedText, preparedText.singleEventLimit, chunkMode)
	};
}
async function sendMessageMatrix(to, message, opts) {
	const trimmedMessage = message?.trim() ?? "";
	if (!trimmedMessage && !opts.mediaUrl) throw new Error("Matrix send requires text or media");
	return await withResolvedMatrixSendClient({
		client: opts.client,
		cfg: opts.cfg,
		timeoutMs: opts.timeoutMs,
		accountId: opts.accountId
	}, async (client) => {
		const roomId = await resolveMatrixRoomId(client, to);
		const cfg = requireRuntimeConfig(opts.cfg, "Matrix send");
		const { chunks } = chunkMatrixText(trimmedMessage, {
			cfg,
			accountId: opts.accountId
		});
		const threadId = normalizeThreadId(opts.threadId);
		const relation = threadId ? buildThreadRelation(threadId, opts.replyToId) : buildReplyRelation(opts.replyToId);
		let pendingExtraContent = opts.extraContent;
		const sendContent = async (content) => {
			const contentWithExtra = withMatrixExtraContentFields(content, pendingExtraContent);
			pendingExtraContent = void 0;
			return await client.sendMessage(roomId, contentWithExtra);
		};
		const messageIds = [];
		let lastMessageId = "";
		if (opts.mediaUrl) {
			const maxBytes = resolveMediaMaxBytes(opts.accountId, cfg);
			const media = await loadOutboundMediaFromUrl(opts.mediaUrl, {
				maxBytes,
				mediaAccess: opts.mediaAccess,
				mediaLocalRoots: opts.mediaLocalRoots,
				mediaReadFile: opts.mediaReadFile
			});
			const uploaded = await uploadMediaMaybeEncrypted(client, roomId, media.buffer, {
				contentType: media.contentType,
				filename: media.fileName
			});
			const durationMs = await resolveMediaDurationMs({
				buffer: media.buffer,
				contentType: media.contentType,
				fileName: media.fileName,
				kind: media.kind ?? "unknown"
			});
			const baseMsgType = resolveMatrixMsgType(media.contentType, media.fileName);
			const { useVoice } = resolveMatrixVoiceDecision({
				wantsVoice: opts.audioAsVoice === true,
				contentType: media.contentType,
				fileName: media.fileName
			});
			const msgtype = useVoice ? MsgType.Audio : baseMsgType;
			const imageInfo = msgtype === MsgType.Image ? await prepareImageInfo({
				buffer: media.buffer,
				client,
				encrypted: Boolean(uploaded.file)
			}) : void 0;
			const [firstChunk, ...rest] = chunks;
			const captionMarkdown = useVoice ? "" : firstChunk ?? "";
			const content = buildMediaContent({
				msgtype,
				body: useVoice ? "Voice message" : captionMarkdown || media.fileName || "(file)",
				url: uploaded.url,
				file: uploaded.file,
				filename: media.fileName,
				mimetype: media.contentType,
				size: media.buffer.byteLength,
				durationMs,
				relation,
				isVoice: useVoice,
				imageInfo
			});
			await enrichMatrixFormattedContent({
				client,
				content,
				markdown: captionMarkdown
			});
			const eventId = await sendContent(content);
			lastMessageId = eventId ?? lastMessageId;
			if (eventId) messageIds.push(eventId);
			const textChunks = useVoice ? chunks : rest;
			const followupRelation = useVoice || threadId ? relation : void 0;
			for (const chunk of textChunks) {
				const text = chunk.trim();
				if (!text) continue;
				const followup = buildTextContent(text, followupRelation);
				await enrichMatrixFormattedContent({
					client,
					content: followup,
					markdown: text
				});
				const followupEventId = await sendContent(followup);
				lastMessageId = followupEventId ?? lastMessageId;
				if (followupEventId) messageIds.push(followupEventId);
			}
		} else for (const chunk of chunks.length ? chunks : [""]) {
			const text = chunk.trim();
			if (!text) continue;
			const content = buildTextContent(text, relation);
			await enrichMatrixFormattedContent({
				client,
				content,
				markdown: text
			});
			const eventId = await sendContent(content);
			lastMessageId = eventId ?? lastMessageId;
			if (eventId) messageIds.push(eventId);
		}
		return {
			messageId: lastMessageId || "unknown",
			roomId,
			primaryMessageId: messageIds[0] ?? (lastMessageId || "unknown"),
			messageIds
		};
	});
}
async function sendPollMatrix(to, poll, opts) {
	if (!poll.question?.trim()) throw new Error("Matrix poll requires a question");
	if (!poll.options?.length) throw new Error("Matrix poll requires options");
	return await withResolvedMatrixSendClient({
		client: opts.client,
		cfg: opts.cfg,
		timeoutMs: opts.timeoutMs,
		accountId: opts.accountId
	}, async (client) => {
		const roomId = await resolveMatrixRoomId(client, to);
		const pollContent = buildPollStartContent(poll);
		const mentions = await resolveMatrixMentionsForBody({
			client,
			body: pollContent["m.text"] ?? pollContent["org.matrix.msc1767.text"] ?? poll.question ?? ""
		});
		const threadId = normalizeThreadId(opts.threadId);
		const pollPayload = threadId ? {
			...pollContent,
			"m.relates_to": buildThreadRelation(threadId)
		} : { ...pollContent };
		pollPayload["m.mentions"] = mentions;
		return {
			eventId: await client.sendEvent(roomId, "m.poll.start", pollPayload) ?? "unknown",
			roomId
		};
	});
}
async function sendTypingMatrix(roomId, typing, optsOrTimeoutMs, client) {
	const opts = typeof optsOrTimeoutMs === "number" ? {
		timeoutMs: optsOrTimeoutMs,
		...client ? { client } : {}
	} : {
		...normalizeMatrixClientResolveOpts(optsOrTimeoutMs),
		...client ? { client } : {}
	};
	await withResolvedMatrixControlClient({
		client: opts.client,
		cfg: opts.cfg,
		timeoutMs: opts.timeoutMs,
		accountId: opts.accountId
	}, async (resolved) => {
		const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
		const resolvedTimeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 3e4;
		await resolved.setTyping(resolvedRoom, typing, resolvedTimeoutMs);
	});
}
async function sendReadReceiptMatrix(roomId, eventId, client) {
	if (!eventId?.trim()) return;
	await withResolvedMatrixControlClient({ client }, async (resolved) => {
		const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
		await resolved.sendReadReceipt(resolvedRoom, eventId.trim());
	});
}
async function sendSingleTextMessageMatrix(roomId, text, opts) {
	const { trimmedText, convertedText, singleEventLimit, fitsInSingleEvent } = prepareMatrixSingleText(text, {
		cfg: opts.cfg,
		accountId: opts.accountId
	});
	if (!trimmedText) throw new Error("Matrix single-message send requires text");
	if (!fitsInSingleEvent) throw new Error(`Matrix single-message text exceeds limit (${convertedText.length} > ${singleEventLimit})`);
	return await withResolvedMatrixSendClient({
		client: opts.client,
		cfg: opts.cfg,
		accountId: opts.accountId
	}, async (client) => {
		const resolvedRoom = await resolveMatrixRoomId(client, roomId);
		const normalizedThreadId = normalizeThreadId(opts.threadId);
		const content = withMatrixExtraContentFields(buildTextContent(convertedText, normalizedThreadId ? buildThreadRelation(normalizedThreadId, opts.replyToId) : buildReplyRelation(opts.replyToId), { msgtype: opts.msgtype }), opts.extraContent);
		await enrichMatrixFormattedContent({
			client,
			content,
			markdown: convertedText,
			includeMentions: opts.includeMentions
		});
		if (opts.live) content[MSC4357_LIVE_KEY] = {};
		const eventId = await client.sendMessage(resolvedRoom, content);
		return {
			messageId: eventId ?? "unknown",
			roomId: resolvedRoom,
			primaryMessageId: eventId ?? "unknown",
			messageIds: eventId ? [eventId] : []
		};
	});
}
async function getPreviousMatrixEvent(client, roomId, eventId) {
	const getEvent = client.getEvent;
	if (typeof getEvent !== "function") return null;
	return await Promise.resolve(getEvent.call(client, roomId, eventId)).catch(() => null);
}
async function editMessageMatrix(roomId, originalEventId, newText, opts) {
	return await withResolvedMatrixSendClient({
		client: opts.client,
		cfg: opts.cfg,
		accountId: opts.accountId,
		timeoutMs: opts.timeoutMs
	}, async (client) => {
		const resolvedRoom = await resolveMatrixRoomId(client, roomId);
		const cfg = requireRuntimeConfig(opts.cfg, "Matrix message edit");
		const tableMode = getCore().channel.text.resolveMarkdownTableMode({
			cfg,
			channel: "matrix",
			accountId: opts.accountId
		});
		const convertedText = getCore().channel.text.convertMarkdownTables(newText, tableMode);
		const newContent = withMatrixExtraContentFields(buildTextContent(convertedText, void 0, { msgtype: opts.msgtype }), opts.extraContent);
		await enrichMatrixFormattedContent({
			client,
			content: newContent,
			markdown: convertedText,
			includeMentions: opts.includeMentions
		});
		const replaceMentions = opts.includeMentions === false ? void 0 : diffMatrixMentions(extractMatrixMentions(newContent), await resolvePreviousEditMentions({
			client,
			content: resolvePreviousEditContent(await getPreviousMatrixEvent(client, resolvedRoom, originalEventId))
		}));
		const replaceRelation = {
			rel_type: RelationType.Replace,
			event_id: originalEventId
		};
		const threadId = normalizeThreadId(opts.threadId);
		if (threadId) replaceRelation["m.in_reply_to"] = { event_id: threadId };
		const content = {
			...newContent,
			body: `* ${convertedText}`,
			...typeof newContent.formatted_body === "string" ? { formatted_body: `* ${newContent.formatted_body}` } : {},
			"m.new_content": newContent,
			"m.relates_to": replaceRelation
		};
		if (replaceMentions !== void 0) content["m.mentions"] = replaceMentions;
		if (opts.live) {
			content[MSC4357_LIVE_KEY] = {};
			content["m.new_content"][MSC4357_LIVE_KEY] = {};
		}
		return await client.sendMessage(resolvedRoom, content) ?? "";
	});
}
async function reactMatrixMessage(roomId, messageId, emoji, opts) {
	const clientOpts = normalizeMatrixClientResolveOpts(opts);
	await withResolvedMatrixSendClient({
		client: clientOpts.client,
		cfg: clientOpts.cfg,
		timeoutMs: clientOpts.timeoutMs,
		accountId: clientOpts.accountId ?? void 0
	}, async (resolved) => {
		const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
		const reaction = buildMatrixReactionContent(messageId, emoji);
		await resolved.sendEvent(resolvedRoom, EventType.Reaction, reaction);
	});
}
//#endregion
export { parsePollStart as _, sendMessageMatrix as a, sendSingleTextMessageMatrix as c, buildPollResponseContent as d, buildPollResultsSummary as f, isPollStartType as g, isPollEventType as h, reactMatrixMessage as i, sendTypingMatrix as l, formatPollResultsAsText as m, editMessageMatrix as n, sendPollMatrix as o, formatPollAsText as p, prepareMatrixSingleText as r, sendReadReceiptMatrix as s, chunkMatrixText as t, resolveMatrixRoomId as u, parsePollStartContent as v, resolvePollReferenceEventId as y };
