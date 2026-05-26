import { o as __toESM, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, l as normalizeOptionalStringifiedId } from "./string-coerce-DyL154ka.js";
import { t as createMessageReceiptFromOutboundResults } from "./receipt-vrVTwZtS.js";
import { n as normalizePollInput } from "./polls-C-v11_tu.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-DWa7yCpn.js";
import { t as loadOutboundMediaFromUrl } from "./outbound-media-BwaTbAKd.js";
import { n as isAutoLinkedFileRef } from "./auto-linked-file-ref-kqLj-Euu.js";
import "./channel-message-DMGbyII_.js";
import "./text-autolink-runtime-Bpgookkt.js";
import { t as require_src } from "./src-BbQYZdr4.js";
import { r as normalizeMatrixResolvableTarget, t as isMatrixQualifiedUserId } from "./target-ids-CPjRklwl.js";
import { a as resolveMatrixAccountConfig } from "./account-config-C6EZ3oG4.js";
import { t as getMatrixRuntime } from "./runtime-Bzh7h5rJ.js";
import { r as buildMatrixReactionContent } from "./reaction-common-BjAtJ4Dp.js";
import { a as EventType, c as MsgType, l as RelationType, n as persistMatrixDirectRoomMapping, s as MSC4357_LIVE_KEY, t as inspectMatrixDirectRooms } from "./direct-management-WVUkEVTK.js";
import { t as fromBuffer } from "./lib-X3TAZBh2.js";
import { n as TrackType, r as TrackTypeValueToKeyMap } from "./types-Dw42w_cH.js";
import { O as textDecode, S as UINT32_LE, a as UnsupportedFileTypeError, i as InternalParserError, n as CouldNotDetermineFileTypeError } from "./BasicParser-CSYy5xVJ.js";
import { l as toRatio, n as decodeString } from "./Util--vOO_7DL.js";
import { c as TimestampFormat, i as LyricsContentType } from "./ID3v2Token-Vj5Brwlp.js";
import { t as APEv2Parser } from "./APEv2Parser-xR0EXf9d.js";
import { r as hasID3v1Header } from "./ID3v1Parser-ykUEySxw.js";
import { i as isStrictDirectRoom } from "./direct-room-BifRU7rS.js";
import MarkdownIt from "markdown-it";
import { fileTypeFromBuffer } from "file-type";
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
	matrixSendClientRuntimePromise ??= import("./client-bootstrap-LVbxC1Cf.js");
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
//#region node_modules/content-type/index.js
/*!
* content-type
* Copyright(c) 2015 Douglas Christopher Wilson
* MIT Licensed
*/
var require_content_type = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* RegExp to match *( ";" parameter ) in RFC 7231 sec 3.1.1.1
	*
	* parameter     = token "=" ( token / quoted-string )
	* token         = 1*tchar
	* tchar         = "!" / "#" / "$" / "%" / "&" / "'" / "*"
	*               / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~"
	*               / DIGIT / ALPHA
	*               ; any VCHAR, except delimiters
	* quoted-string = DQUOTE *( qdtext / quoted-pair ) DQUOTE
	* qdtext        = HTAB / SP / %x21 / %x23-5B / %x5D-7E / obs-text
	* obs-text      = %x80-FF
	* quoted-pair   = "\" ( HTAB / SP / VCHAR / obs-text )
	*/
	var PARAM_REGEXP = /; *([!#$%&'*+.^_`|~0-9A-Za-z-]+) *= *("(?:[\u000b\u0020\u0021\u0023-\u005b\u005d-\u007e\u0080-\u00ff]|\\[\u000b\u0020-\u00ff])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+) */g;
	/**
	* RegExp to match quoted-pair in RFC 7230 sec 3.2.6
	*
	* quoted-pair = "\" ( HTAB / SP / VCHAR / obs-text )
	* obs-text    = %x80-FF
	*/
	var QESC_REGEXP = /\\([\u000b\u0020-\u00ff])/g;
	/**
	* RegExp to match type in RFC 7231 sec 3.1.1.1
	*
	* media-type = type "/" subtype
	* type       = token
	* subtype    = token
	*/
	var TYPE_REGEXP = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
	exports.parse = parse;
	/**
	* Parse media type to object.
	*
	* @param {string|object} string
	* @return {Object}
	* @public
	*/
	function parse(string) {
		if (!string) throw new TypeError("argument string is required");
		var header = typeof string === "object" ? getcontenttype(string) : string;
		if (typeof header !== "string") throw new TypeError("argument string is required to be a string");
		var index = header.indexOf(";");
		var type = index !== -1 ? header.slice(0, index).trim() : header.trim();
		if (!TYPE_REGEXP.test(type)) throw new TypeError("invalid media type");
		var obj = new ContentType(type.toLowerCase());
		if (index !== -1) {
			var key;
			var match;
			var value;
			PARAM_REGEXP.lastIndex = index;
			while (match = PARAM_REGEXP.exec(header)) {
				if (match.index !== index) throw new TypeError("invalid parameter format");
				index += match[0].length;
				key = match[1].toLowerCase();
				value = match[2];
				if (value.charCodeAt(0) === 34) {
					value = value.slice(1, -1);
					if (value.indexOf("\\") !== -1) value = value.replace(QESC_REGEXP, "$1");
				}
				obj.parameters[key] = value;
			}
			if (index !== header.length) throw new TypeError("invalid parameter format");
		}
		return obj;
	}
	/**
	* Get content-type from req/res objects.
	*
	* @param {object}
	* @return {Object}
	* @private
	*/
	function getcontenttype(obj) {
		var header;
		if (typeof obj.getHeader === "function") header = obj.getHeader("content-type");
		else if (typeof obj.headers === "object") header = obj.headers && obj.headers["content-type"];
		if (typeof header !== "string") throw new TypeError("content-type header is missing from object");
		return header;
	}
	/**
	* Class to represent a content type.
	* @private
	*/
	function ContentType(type) {
		this.parameters = Object.create(null);
		this.type = type;
	}
}));
//#endregion
//#region node_modules/media-typer/index.js
/*!
* media-typer
* Copyright(c) 2014-2017 Douglas Christopher Wilson
* MIT Licensed
*/
var require_media_typer = /* @__PURE__ */ __commonJSMin(((exports) => {
	var TYPE_REGEXP = /^ *([A-Za-z0-9][A-Za-z0-9!#$&^_-]{0,126})\/([A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}) *$/;
	exports.parse = parse;
	/**
	* Parse media type to object.
	*
	* @param {string} string
	* @return {object}
	* @public
	*/
	function parse(string) {
		if (!string) throw new TypeError("argument string is required");
		if (typeof string !== "string") throw new TypeError("argument string is required to be a string");
		var match = TYPE_REGEXP.exec(string.toLowerCase());
		if (!match) throw new TypeError("invalid media type");
		var type = match[1];
		var subtype = match[2];
		var suffix;
		var index = subtype.lastIndexOf("+");
		if (index !== -1) {
			suffix = subtype.substr(index + 1);
			subtype = subtype.substr(0, index);
		}
		return new MediaType(type, subtype, suffix);
	}
	/**
	* Class for MediaType object.
	* @public
	*/
	function MediaType(type, subtype, suffix) {
		this.type = type;
		this.subtype = subtype;
		this.suffix = suffix;
	}
}));
//#endregion
//#region node_modules/music-metadata/lib/common/GenericTagTypes.js
const defaultTagInfo = { multiple: false };
const commonTags = {
	year: defaultTagInfo,
	track: defaultTagInfo,
	disk: defaultTagInfo,
	title: defaultTagInfo,
	artist: defaultTagInfo,
	artists: {
		multiple: true,
		unique: true
	},
	albumartist: defaultTagInfo,
	albumartists: {
		multiple: true,
		unique: true
	},
	album: defaultTagInfo,
	date: defaultTagInfo,
	originaldate: defaultTagInfo,
	originalyear: defaultTagInfo,
	releasedate: defaultTagInfo,
	comment: {
		multiple: true,
		unique: false
	},
	genre: {
		multiple: true,
		unique: true
	},
	picture: {
		multiple: true,
		unique: true
	},
	composer: {
		multiple: true,
		unique: true
	},
	lyrics: {
		multiple: true,
		unique: false
	},
	albumsort: {
		multiple: false,
		unique: true
	},
	titlesort: {
		multiple: false,
		unique: true
	},
	work: {
		multiple: false,
		unique: true
	},
	artistsort: {
		multiple: false,
		unique: true
	},
	albumartistsort: {
		multiple: false,
		unique: true
	},
	composersort: {
		multiple: false,
		unique: true
	},
	lyricist: {
		multiple: true,
		unique: true
	},
	writer: {
		multiple: true,
		unique: true
	},
	conductor: {
		multiple: true,
		unique: true
	},
	remixer: {
		multiple: true,
		unique: true
	},
	arranger: {
		multiple: true,
		unique: true
	},
	engineer: {
		multiple: true,
		unique: true
	},
	producer: {
		multiple: true,
		unique: true
	},
	technician: {
		multiple: true,
		unique: true
	},
	djmixer: {
		multiple: true,
		unique: true
	},
	mixer: {
		multiple: true,
		unique: true
	},
	label: {
		multiple: true,
		unique: true
	},
	grouping: defaultTagInfo,
	subtitle: { multiple: true },
	discsubtitle: defaultTagInfo,
	totaltracks: defaultTagInfo,
	totaldiscs: defaultTagInfo,
	compilation: defaultTagInfo,
	rating: { multiple: true },
	bpm: defaultTagInfo,
	mood: defaultTagInfo,
	media: defaultTagInfo,
	catalognumber: {
		multiple: true,
		unique: true
	},
	tvShow: defaultTagInfo,
	tvShowSort: defaultTagInfo,
	tvSeason: defaultTagInfo,
	tvEpisode: defaultTagInfo,
	tvEpisodeId: defaultTagInfo,
	tvNetwork: defaultTagInfo,
	podcast: defaultTagInfo,
	podcasturl: defaultTagInfo,
	releasestatus: defaultTagInfo,
	releasetype: { multiple: true },
	releasecountry: defaultTagInfo,
	script: defaultTagInfo,
	language: defaultTagInfo,
	copyright: defaultTagInfo,
	license: defaultTagInfo,
	encodedby: defaultTagInfo,
	encodersettings: defaultTagInfo,
	gapless: defaultTagInfo,
	barcode: defaultTagInfo,
	isrc: { multiple: true },
	asin: defaultTagInfo,
	musicbrainz_recordingid: defaultTagInfo,
	musicbrainz_trackid: defaultTagInfo,
	musicbrainz_albumid: defaultTagInfo,
	musicbrainz_artistid: { multiple: true },
	musicbrainz_albumartistid: { multiple: true },
	musicbrainz_releasegroupid: defaultTagInfo,
	musicbrainz_workid: defaultTagInfo,
	musicbrainz_trmid: defaultTagInfo,
	musicbrainz_discid: defaultTagInfo,
	acoustid_id: defaultTagInfo,
	acoustid_fingerprint: defaultTagInfo,
	musicip_puid: defaultTagInfo,
	musicip_fingerprint: defaultTagInfo,
	website: defaultTagInfo,
	"performer:instrument": {
		multiple: true,
		unique: true
	},
	averageLevel: defaultTagInfo,
	peakLevel: defaultTagInfo,
	notes: {
		multiple: true,
		unique: false
	},
	key: defaultTagInfo,
	originalalbum: defaultTagInfo,
	originalartist: defaultTagInfo,
	discogs_artist_id: {
		multiple: true,
		unique: true
	},
	discogs_release_id: defaultTagInfo,
	discogs_label_id: defaultTagInfo,
	discogs_master_release_id: defaultTagInfo,
	discogs_votes: defaultTagInfo,
	discogs_rating: defaultTagInfo,
	replaygain_track_peak: defaultTagInfo,
	replaygain_track_gain: defaultTagInfo,
	replaygain_album_peak: defaultTagInfo,
	replaygain_album_gain: defaultTagInfo,
	replaygain_track_minmax: defaultTagInfo,
	replaygain_album_minmax: defaultTagInfo,
	replaygain_undo: defaultTagInfo,
	description: { multiple: true },
	longDescription: defaultTagInfo,
	category: { multiple: true },
	hdVideo: defaultTagInfo,
	keywords: { multiple: true },
	movement: defaultTagInfo,
	movementIndex: defaultTagInfo,
	movementTotal: defaultTagInfo,
	podcastId: defaultTagInfo,
	showMovement: defaultTagInfo,
	stik: defaultTagInfo,
	playCounter: defaultTagInfo
};
/**
* @param alias Name of common tag
* @returns {boolean|*} true if given alias is mapped as a singleton', otherwise false
*/
function isSingleton(alias) {
	return commonTags[alias] && !commonTags[alias].multiple;
}
/**
* @param alias Common (generic) tag
* @returns {boolean|*} true if given alias is a singleton or explicitly marked as unique
*/
function isUnique(alias) {
	return !commonTags[alias].multiple || commonTags[alias].unique || false;
}
//#endregion
//#region node_modules/music-metadata/lib/common/GenericTagMapper.js
var CommonTagMapper = class {
	static toIntOrNull(str) {
		const cleaned = Number.parseInt(str, 10);
		return Number.isNaN(cleaned) ? null : cleaned;
	}
	static normalizeTrack(origVal) {
		const split = origVal.toString().split("/");
		return {
			no: Number.parseInt(split[0], 10) || null,
			of: Number.parseInt(split[1], 10) || null
		};
	}
	constructor(tagTypes, tagMap) {
		this.tagTypes = tagTypes;
		this.tagMap = tagMap;
	}
	/**
	* Process and set common tags
	* write common tags to
	* @param tag Native tag
	* @param warnings Register warnings
	* @return common name
	*/
	mapGenericTag(tag, warnings) {
		tag = {
			id: tag.id,
			value: tag.value
		};
		this.postMap(tag, warnings);
		const id = this.getCommonName(tag.id);
		return id ? {
			id,
			value: tag.value
		} : null;
	}
	/**
	* Convert native tag key to common tag key
	* @param tag Native header tag
	* @return common tag name (alias)
	*/
	getCommonName(tag) {
		return this.tagMap[tag];
	}
	/**
	* Handle post mapping exceptions / correction
	* @param tag Tag e.g. {"©alb", "Buena Vista Social Club")
	* @param warnings Used to register warnings
	*/
	postMap(_tag, _warnings) {}
};
CommonTagMapper.maxRatingScore = 1;
//#endregion
//#region node_modules/music-metadata/lib/id3v1/ID3v1TagMap.js
/**
* ID3v1 tag mappings
*/
const id3v1TagMap = {
	title: "title",
	artist: "artist",
	album: "album",
	year: "year",
	comment: "comment",
	track: "track",
	genre: "genre"
};
var ID3v1TagMapper = class extends CommonTagMapper {
	constructor() {
		super(["ID3v1"], id3v1TagMap);
	}
};
//#endregion
//#region node_modules/music-metadata/lib/common/CaseInsensitiveTagMap.js
var CaseInsensitiveTagMap = class extends CommonTagMapper {
	constructor(tagTypes, tagMap) {
		const upperCaseMap = {};
		for (const tag of Object.keys(tagMap)) upperCaseMap[tag.toUpperCase()] = tagMap[tag];
		super(tagTypes, upperCaseMap);
	}
	/**
	* @tag  Native header tag
	* @return common tag name (alias)
	*/
	getCommonName(tag) {
		return this.tagMap[tag.toUpperCase()];
	}
};
//#endregion
//#region node_modules/music-metadata/lib/id3v2/ID3v24TagMapper.js
/**
* ID3v2.3/ID3v2.4 tag mappings
*/
const id3v24TagMap = {
	TIT2: "title",
	TPE1: "artist",
	"TXXX:Artists": "artists",
	TPE2: "albumartist",
	TALB: "album",
	TDRV: "date",
	/**
	* Original release year
	*/
	TORY: "originalyear",
	TPOS: "disk",
	TCON: "genre",
	APIC: "picture",
	TCOM: "composer",
	USLT: "lyrics",
	TSOA: "albumsort",
	TSOT: "titlesort",
	TOAL: "originalalbum",
	TSOP: "artistsort",
	TSO2: "albumartistsort",
	TSOC: "composersort",
	TEXT: "lyricist",
	"TXXX:Writer": "writer",
	TPE3: "conductor",
	TPE4: "remixer",
	"IPLS:arranger": "arranger",
	"IPLS:engineer": "engineer",
	"IPLS:producer": "producer",
	"IPLS:DJ-mix": "djmixer",
	"IPLS:mix": "mixer",
	TPUB: "label",
	TIT1: "grouping",
	TIT3: "subtitle",
	TRCK: "track",
	TCMP: "compilation",
	POPM: "rating",
	TBPM: "bpm",
	TMED: "media",
	"TXXX:CATALOGNUMBER": "catalognumber",
	"TXXX:MusicBrainz Album Status": "releasestatus",
	"TXXX:MusicBrainz Album Type": "releasetype",
	/**
	* Release country as documented: https://picard.musicbrainz.org/docs/mappings/#cite_note-0
	*/
	"TXXX:MusicBrainz Album Release Country": "releasecountry",
	/**
	* Release country as implemented // ToDo: report
	*/
	"TXXX:RELEASECOUNTRY": "releasecountry",
	"TXXX:SCRIPT": "script",
	TLAN: "language",
	TCOP: "copyright",
	WCOP: "license",
	TENC: "encodedby",
	TSSE: "encodersettings",
	"TXXX:BARCODE": "barcode",
	"TXXX:ISRC": "isrc",
	TSRC: "isrc",
	"TXXX:ASIN": "asin",
	"TXXX:originalyear": "originalyear",
	"UFID:http://musicbrainz.org": "musicbrainz_recordingid",
	"TXXX:MusicBrainz Release Track Id": "musicbrainz_trackid",
	"TXXX:MusicBrainz Album Id": "musicbrainz_albumid",
	"TXXX:MusicBrainz Artist Id": "musicbrainz_artistid",
	"TXXX:MusicBrainz Album Artist Id": "musicbrainz_albumartistid",
	"TXXX:MusicBrainz Release Group Id": "musicbrainz_releasegroupid",
	"TXXX:MusicBrainz Work Id": "musicbrainz_workid",
	"TXXX:MusicBrainz TRM Id": "musicbrainz_trmid",
	"TXXX:MusicBrainz Disc Id": "musicbrainz_discid",
	"TXXX:ACOUSTID_ID": "acoustid_id",
	"TXXX:Acoustid Id": "acoustid_id",
	"TXXX:Acoustid Fingerprint": "acoustid_fingerprint",
	"TXXX:MusicIP PUID": "musicip_puid",
	"TXXX:MusicMagic Fingerprint": "musicip_fingerprint",
	WOAR: "website",
	TDRC: "date",
	TYER: "year",
	TDOR: "originaldate",
	"TIPL:arranger": "arranger",
	"TIPL:engineer": "engineer",
	"TIPL:producer": "producer",
	"TIPL:DJ-mix": "djmixer",
	"TIPL:mix": "mixer",
	TMOO: "mood",
	SYLT: "lyrics",
	TSST: "discsubtitle",
	TKEY: "key",
	COMM: "comment",
	TOPE: "originalartist",
	"PRIV:AverageLevel": "averageLevel",
	"PRIV:PeakLevel": "peakLevel",
	"TXXX:DISCOGS_ARTIST_ID": "discogs_artist_id",
	"TXXX:DISCOGS_ARTISTS": "artists",
	"TXXX:DISCOGS_ARTIST_NAME": "artists",
	"TXXX:DISCOGS_ALBUM_ARTISTS": "albumartist",
	"TXXX:DISCOGS_CATALOG": "catalognumber",
	"TXXX:DISCOGS_COUNTRY": "releasecountry",
	"TXXX:DISCOGS_DATE": "originaldate",
	"TXXX:DISCOGS_LABEL": "label",
	"TXXX:DISCOGS_LABEL_ID": "discogs_label_id",
	"TXXX:DISCOGS_MASTER_RELEASE_ID": "discogs_master_release_id",
	"TXXX:DISCOGS_RATING": "discogs_rating",
	"TXXX:DISCOGS_RELEASED": "date",
	"TXXX:DISCOGS_RELEASE_ID": "discogs_release_id",
	"TXXX:DISCOGS_VOTES": "discogs_votes",
	"TXXX:CATALOGID": "catalognumber",
	"TXXX:STYLE": "genre",
	"TXXX:REPLAYGAIN_TRACK_PEAK": "replaygain_track_peak",
	"TXXX:REPLAYGAIN_TRACK_GAIN": "replaygain_track_gain",
	"TXXX:REPLAYGAIN_ALBUM_PEAK": "replaygain_album_peak",
	"TXXX:REPLAYGAIN_ALBUM_GAIN": "replaygain_album_gain",
	"TXXX:MP3GAIN_MINMAX": "replaygain_track_minmax",
	"TXXX:MP3GAIN_ALBUM_MINMAX": "replaygain_album_minmax",
	"TXXX:MP3GAIN_UNDO": "replaygain_undo",
	MVNM: "movement",
	MVIN: "movementIndex",
	PCST: "podcast",
	TCAT: "category",
	TDES: "description",
	TDRL: "releasedate",
	TGID: "podcastId",
	TKWD: "keywords",
	WFED: "podcasturl",
	GRP1: "grouping",
	PCNT: "playCounter"
};
var ID3v24TagMapper = class ID3v24TagMapper extends CaseInsensitiveTagMap {
	static toRating(popm) {
		return {
			source: popm.email,
			rating: popm.rating > 0 ? (popm.rating - 1) / 254 * CommonTagMapper.maxRatingScore : void 0
		};
	}
	constructor() {
		super(["ID3v2.3", "ID3v2.4"], id3v24TagMap);
	}
	/**
	* Handle post mapping exceptions / correction
	* @param tag to post map
	* @param warnings Wil be used to register (collect) warnings
	*/
	postMap(tag, warnings) {
		switch (tag.id) {
			case "UFID":
				{
					const idTag = tag.value;
					if (idTag.owner_identifier === "http://musicbrainz.org") {
						tag.id += `:${idTag.owner_identifier}`;
						tag.value = decodeString(idTag.identifier, "latin1");
					}
				}
				break;
			case "PRIV":
				{
					const customTag = tag.value;
					switch (customTag.owner_identifier) {
						case "AverageLevel":
						case "PeakValue":
							tag.id += `:${customTag.owner_identifier}`;
							tag.value = customTag.data.length === 4 ? UINT32_LE.get(customTag.data, 0) : null;
							if (tag.value === null) warnings.addWarning("Failed to parse PRIV:PeakValue");
							break;
						default: warnings.addWarning(`Unknown PRIV owner-identifier: ${customTag.data}`);
					}
				}
				break;
			case "POPM":
				tag.value = ID3v24TagMapper.toRating(tag.value);
				break;
			default: break;
		}
	}
};
//#endregion
//#region node_modules/music-metadata/lib/asf/AsfTagMapper.js
/**
* ASF Metadata tag mappings.
* See http://msdn.microsoft.com/en-us/library/ms867702.aspx
*/
const asfTagMap = {
	Title: "title",
	Author: "artist",
	"WM/AlbumArtist": "albumartist",
	"WM/AlbumTitle": "album",
	"WM/Year": "date",
	"WM/OriginalReleaseTime": "originaldate",
	"WM/OriginalReleaseYear": "originalyear",
	Description: "comment",
	"WM/TrackNumber": "track",
	"WM/PartOfSet": "disk",
	"WM/Genre": "genre",
	"WM/Composer": "composer",
	"WM/Lyrics": "lyrics",
	"WM/AlbumSortOrder": "albumsort",
	"WM/TitleSortOrder": "titlesort",
	"WM/ArtistSortOrder": "artistsort",
	"WM/AlbumArtistSortOrder": "albumartistsort",
	"WM/ComposerSortOrder": "composersort",
	"WM/Writer": "lyricist",
	"WM/Conductor": "conductor",
	"WM/ModifiedBy": "remixer",
	"WM/Engineer": "engineer",
	"WM/Producer": "producer",
	"WM/DJMixer": "djmixer",
	"WM/Mixer": "mixer",
	"WM/Publisher": "label",
	"WM/ContentGroupDescription": "grouping",
	"WM/SubTitle": "subtitle",
	"WM/SetSubTitle": "discsubtitle",
	"WM/IsCompilation": "compilation",
	"WM/SharedUserRating": "rating",
	"WM/BeatsPerMinute": "bpm",
	"WM/Mood": "mood",
	"WM/Media": "media",
	"WM/CatalogNo": "catalognumber",
	"MusicBrainz/Album Status": "releasestatus",
	"MusicBrainz/Album Type": "releasetype",
	"MusicBrainz/Album Release Country": "releasecountry",
	"WM/Script": "script",
	"WM/Language": "language",
	Copyright: "copyright",
	LICENSE: "license",
	"WM/EncodedBy": "encodedby",
	"WM/EncodingSettings": "encodersettings",
	"WM/Barcode": "barcode",
	"WM/ISRC": "isrc",
	"MusicBrainz/Track Id": "musicbrainz_recordingid",
	"MusicBrainz/Release Track Id": "musicbrainz_trackid",
	"MusicBrainz/Album Id": "musicbrainz_albumid",
	"MusicBrainz/Artist Id": "musicbrainz_artistid",
	"MusicBrainz/Album Artist Id": "musicbrainz_albumartistid",
	"MusicBrainz/Release Group Id": "musicbrainz_releasegroupid",
	"MusicBrainz/Work Id": "musicbrainz_workid",
	"MusicBrainz/TRM Id": "musicbrainz_trmid",
	"MusicBrainz/Disc Id": "musicbrainz_discid",
	"Acoustid/Id": "acoustid_id",
	"Acoustid/Fingerprint": "acoustid_fingerprint",
	"MusicIP/PUID": "musicip_puid",
	"WM/ARTISTS": "artists",
	"WM/InitialKey": "key",
	ASIN: "asin",
	"WM/Work": "work",
	"WM/AuthorURL": "website",
	"WM/Picture": "picture"
};
var AsfTagMapper = class AsfTagMapper extends CommonTagMapper {
	static toRating(rating) {
		return { rating: Number.parseFloat(rating + 1) / 5 };
	}
	constructor() {
		super(["asf"], asfTagMap);
	}
	postMap(tag) {
		switch (tag.id) {
			case "WM/SharedUserRating": {
				const keys = tag.id.split(":");
				tag.value = AsfTagMapper.toRating(tag.value);
				tag.id = keys[0];
				break;
			}
		}
	}
};
//#endregion
//#region node_modules/music-metadata/lib/id3v2/ID3v22TagMapper.js
/**
* ID3v2.2 tag mappings
*/
const id3v22TagMap = {
	TT2: "title",
	TP1: "artist",
	TP2: "albumartist",
	TAL: "album",
	TYE: "year",
	COM: "comment",
	TRK: "track",
	TPA: "disk",
	TCO: "genre",
	PIC: "picture",
	TCM: "composer",
	TOR: "originaldate",
	TOT: "originalalbum",
	TXT: "lyricist",
	TP3: "conductor",
	TPB: "label",
	TT1: "grouping",
	TT3: "subtitle",
	TLA: "language",
	TCR: "copyright",
	WCP: "license",
	TEN: "encodedby",
	TSS: "encodersettings",
	WAR: "website",
	PCS: "podcast",
	TCP: "compilation",
	TDR: "date",
	TS2: "albumartistsort",
	TSA: "albumsort",
	TSC: "composersort",
	TSP: "artistsort",
	TST: "titlesort",
	WFD: "podcasturl",
	TBP: "bpm",
	GP1: "grouping"
};
var ID3v22TagMapper = class extends CaseInsensitiveTagMap {
	constructor() {
		super(["ID3v2.2"], id3v22TagMap);
	}
};
//#endregion
//#region node_modules/music-metadata/lib/apev2/APEv2TagMapper.js
/**
* ID3v2.2 tag mappings
*/
const apev2TagMap = {
	Title: "title",
	Artist: "artist",
	Artists: "artists",
	"Album Artist": "albumartist",
	Album: "album",
	Year: "date",
	Originalyear: "originalyear",
	Originaldate: "originaldate",
	Releasedate: "releasedate",
	Comment: "comment",
	Track: "track",
	Disc: "disk",
	DISCNUMBER: "disk",
	Genre: "genre",
	"Cover Art (Front)": "picture",
	"Cover Art (Back)": "picture",
	Composer: "composer",
	Lyrics: "lyrics",
	ALBUMSORT: "albumsort",
	TITLESORT: "titlesort",
	WORK: "work",
	ARTISTSORT: "artistsort",
	ALBUMARTISTSORT: "albumartistsort",
	COMPOSERSORT: "composersort",
	Lyricist: "lyricist",
	Writer: "writer",
	Conductor: "conductor",
	MixArtist: "remixer",
	Arranger: "arranger",
	Engineer: "engineer",
	Producer: "producer",
	DJMixer: "djmixer",
	Mixer: "mixer",
	Label: "label",
	Grouping: "grouping",
	Subtitle: "subtitle",
	DiscSubtitle: "discsubtitle",
	Compilation: "compilation",
	BPM: "bpm",
	Mood: "mood",
	Media: "media",
	CatalogNumber: "catalognumber",
	MUSICBRAINZ_ALBUMSTATUS: "releasestatus",
	MUSICBRAINZ_ALBUMTYPE: "releasetype",
	RELEASECOUNTRY: "releasecountry",
	Script: "script",
	Language: "language",
	Copyright: "copyright",
	LICENSE: "license",
	EncodedBy: "encodedby",
	EncoderSettings: "encodersettings",
	Barcode: "barcode",
	ISRC: "isrc",
	ASIN: "asin",
	musicbrainz_trackid: "musicbrainz_recordingid",
	musicbrainz_releasetrackid: "musicbrainz_trackid",
	MUSICBRAINZ_ALBUMID: "musicbrainz_albumid",
	MUSICBRAINZ_ARTISTID: "musicbrainz_artistid",
	MUSICBRAINZ_ALBUMARTISTID: "musicbrainz_albumartistid",
	MUSICBRAINZ_RELEASEGROUPID: "musicbrainz_releasegroupid",
	MUSICBRAINZ_WORKID: "musicbrainz_workid",
	MUSICBRAINZ_TRMID: "musicbrainz_trmid",
	MUSICBRAINZ_DISCID: "musicbrainz_discid",
	Acoustid_Id: "acoustid_id",
	ACOUSTID_FINGERPRINT: "acoustid_fingerprint",
	MUSICIP_PUID: "musicip_puid",
	Weblink: "website",
	REPLAYGAIN_TRACK_GAIN: "replaygain_track_gain",
	REPLAYGAIN_TRACK_PEAK: "replaygain_track_peak",
	MP3GAIN_MINMAX: "replaygain_track_minmax",
	MP3GAIN_UNDO: "replaygain_undo"
};
var APEv2TagMapper = class extends CaseInsensitiveTagMap {
	constructor() {
		super(["APEv2"], apev2TagMap);
	}
};
//#endregion
//#region node_modules/music-metadata/lib/mp4/MP4TagMapper.js
/**
* Ref: https://github.com/sergiomb2/libmp4v2/wiki/iTunesMetadata
*/
const mp4TagMap = {
	"©nam": "title",
	"©ART": "artist",
	aART: "albumartist",
	/**
	* ToDo: Album artist seems to be stored here while Picard documentation says: aART
	*/
	"----:com.apple.iTunes:Band": "albumartist",
	"©alb": "album",
	"©day": "date",
	"©cmt": "comment",
	"©com": "comment",
	trkn: "track",
	disk: "disk",
	"©gen": "genre",
	covr: "picture",
	"©wrt": "composer",
	"©lyr": "lyrics",
	soal: "albumsort",
	sonm: "titlesort",
	soar: "artistsort",
	soaa: "albumartistsort",
	soco: "composersort",
	"----:com.apple.iTunes:LYRICIST": "lyricist",
	"----:com.apple.iTunes:CONDUCTOR": "conductor",
	"----:com.apple.iTunes:REMIXER": "remixer",
	"----:com.apple.iTunes:ENGINEER": "engineer",
	"----:com.apple.iTunes:PRODUCER": "producer",
	"----:com.apple.iTunes:DJMIXER": "djmixer",
	"----:com.apple.iTunes:MIXER": "mixer",
	"----:com.apple.iTunes:LABEL": "label",
	"©grp": "grouping",
	"----:com.apple.iTunes:SUBTITLE": "subtitle",
	"----:com.apple.iTunes:DISCSUBTITLE": "discsubtitle",
	cpil: "compilation",
	tmpo: "bpm",
	"----:com.apple.iTunes:MOOD": "mood",
	"----:com.apple.iTunes:MEDIA": "media",
	"----:com.apple.iTunes:CATALOGNUMBER": "catalognumber",
	tvsh: "tvShow",
	tvsn: "tvSeason",
	tves: "tvEpisode",
	sosn: "tvShowSort",
	tven: "tvEpisodeId",
	tvnn: "tvNetwork",
	pcst: "podcast",
	purl: "podcasturl",
	"----:com.apple.iTunes:MusicBrainz Album Status": "releasestatus",
	"----:com.apple.iTunes:MusicBrainz Album Type": "releasetype",
	"----:com.apple.iTunes:MusicBrainz Album Release Country": "releasecountry",
	"----:com.apple.iTunes:SCRIPT": "script",
	"----:com.apple.iTunes:LANGUAGE": "language",
	cprt: "copyright",
	"©cpy": "copyright",
	"----:com.apple.iTunes:LICENSE": "license",
	"©too": "encodedby",
	pgap: "gapless",
	"----:com.apple.iTunes:BARCODE": "barcode",
	"----:com.apple.iTunes:ISRC": "isrc",
	"----:com.apple.iTunes:ASIN": "asin",
	"----:com.apple.iTunes:NOTES": "comment",
	"----:com.apple.iTunes:MusicBrainz Track Id": "musicbrainz_recordingid",
	"----:com.apple.iTunes:MusicBrainz Release Track Id": "musicbrainz_trackid",
	"----:com.apple.iTunes:MusicBrainz Album Id": "musicbrainz_albumid",
	"----:com.apple.iTunes:MusicBrainz Artist Id": "musicbrainz_artistid",
	"----:com.apple.iTunes:MusicBrainz Album Artist Id": "musicbrainz_albumartistid",
	"----:com.apple.iTunes:MusicBrainz Release Group Id": "musicbrainz_releasegroupid",
	"----:com.apple.iTunes:MusicBrainz Work Id": "musicbrainz_workid",
	"----:com.apple.iTunes:MusicBrainz TRM Id": "musicbrainz_trmid",
	"----:com.apple.iTunes:MusicBrainz Disc Id": "musicbrainz_discid",
	"----:com.apple.iTunes:Acoustid Id": "acoustid_id",
	"----:com.apple.iTunes:Acoustid Fingerprint": "acoustid_fingerprint",
	"----:com.apple.iTunes:MusicIP PUID": "musicip_puid",
	"----:com.apple.iTunes:fingerprint": "musicip_fingerprint",
	"----:com.apple.iTunes:replaygain_track_gain": "replaygain_track_gain",
	"----:com.apple.iTunes:replaygain_track_peak": "replaygain_track_peak",
	"----:com.apple.iTunes:replaygain_album_gain": "replaygain_album_gain",
	"----:com.apple.iTunes:replaygain_album_peak": "replaygain_album_peak",
	"----:com.apple.iTunes:replaygain_track_minmax": "replaygain_track_minmax",
	"----:com.apple.iTunes:replaygain_album_minmax": "replaygain_album_minmax",
	"----:com.apple.iTunes:replaygain_undo": "replaygain_undo",
	gnre: "genre",
	"----:com.apple.iTunes:ALBUMARTISTSORT": "albumartistsort",
	"----:com.apple.iTunes:ARTISTS": "artists",
	"----:com.apple.iTunes:ORIGINALDATE": "originaldate",
	"----:com.apple.iTunes:ORIGINALYEAR": "originalyear",
	"----:com.apple.iTunes:RELEASEDATE": "releasedate",
	desc: "description",
	ldes: "longDescription",
	"©mvn": "movement",
	"©mvi": "movementIndex",
	"©mvc": "movementTotal",
	"©wrk": "work",
	catg: "category",
	egid: "podcastId",
	hdvd: "hdVideo",
	keyw: "keywords",
	shwm: "showMovement",
	stik: "stik",
	rate: "rating"
};
const tagType = "iTunes";
var MP4TagMapper = class extends CaseInsensitiveTagMap {
	constructor() {
		super([tagType], mp4TagMap);
	}
	postMap(tag, _warnings) {
		switch (tag.id) {
			case "rate":
				tag.value = {
					source: void 0,
					rating: Number.parseFloat(tag.value) / 100
				};
				break;
		}
	}
};
//#endregion
//#region node_modules/music-metadata/lib/ogg/vorbis/VorbisTagMapper.js
/**
* Vorbis tag mappings
*
* Mapping from native header format to one or possibly more 'common' entries
* The common entries aim to read the same information from different media files
* independent of the underlying format
*/
const vorbisTagMap = {
	TITLE: "title",
	ARTIST: "artist",
	ARTISTS: "artists",
	ALBUMARTIST: "albumartist",
	"ALBUM ARTIST": "albumartist",
	ALBUM: "album",
	DATE: "date",
	ORIGINALDATE: "originaldate",
	ORIGINALYEAR: "originalyear",
	RELEASEDATE: "releasedate",
	COMMENT: "comment",
	TRACKNUMBER: "track",
	DISCNUMBER: "disk",
	GENRE: "genre",
	METADATA_BLOCK_PICTURE: "picture",
	COMPOSER: "composer",
	LYRICS: "lyrics",
	ALBUMSORT: "albumsort",
	TITLESORT: "titlesort",
	WORK: "work",
	ARTISTSORT: "artistsort",
	ALBUMARTISTSORT: "albumartistsort",
	COMPOSERSORT: "composersort",
	LYRICIST: "lyricist",
	WRITER: "writer",
	CONDUCTOR: "conductor",
	REMIXER: "remixer",
	ARRANGER: "arranger",
	ENGINEER: "engineer",
	PRODUCER: "producer",
	DJMIXER: "djmixer",
	MIXER: "mixer",
	LABEL: "label",
	GROUPING: "grouping",
	SUBTITLE: "subtitle",
	DISCSUBTITLE: "discsubtitle",
	TRACKTOTAL: "totaltracks",
	DISCTOTAL: "totaldiscs",
	COMPILATION: "compilation",
	RATING: "rating",
	BPM: "bpm",
	KEY: "key",
	MOOD: "mood",
	MEDIA: "media",
	CATALOGNUMBER: "catalognumber",
	RELEASESTATUS: "releasestatus",
	RELEASETYPE: "releasetype",
	RELEASECOUNTRY: "releasecountry",
	SCRIPT: "script",
	LANGUAGE: "language",
	COPYRIGHT: "copyright",
	LICENSE: "license",
	ENCODEDBY: "encodedby",
	ENCODERSETTINGS: "encodersettings",
	BARCODE: "barcode",
	ISRC: "isrc",
	ASIN: "asin",
	MUSICBRAINZ_TRACKID: "musicbrainz_recordingid",
	MUSICBRAINZ_RELEASETRACKID: "musicbrainz_trackid",
	MUSICBRAINZ_ALBUMID: "musicbrainz_albumid",
	MUSICBRAINZ_ARTISTID: "musicbrainz_artistid",
	MUSICBRAINZ_ALBUMARTISTID: "musicbrainz_albumartistid",
	MUSICBRAINZ_RELEASEGROUPID: "musicbrainz_releasegroupid",
	MUSICBRAINZ_WORKID: "musicbrainz_workid",
	MUSICBRAINZ_TRMID: "musicbrainz_trmid",
	MUSICBRAINZ_DISCID: "musicbrainz_discid",
	ACOUSTID_ID: "acoustid_id",
	ACOUSTID_ID_FINGERPRINT: "acoustid_fingerprint",
	MUSICIP_PUID: "musicip_puid",
	WEBSITE: "website",
	NOTES: "notes",
	TOTALTRACKS: "totaltracks",
	TOTALDISCS: "totaldiscs",
	DISCOGS_ARTIST_ID: "discogs_artist_id",
	DISCOGS_ARTISTS: "artists",
	DISCOGS_ARTIST_NAME: "artists",
	DISCOGS_ALBUM_ARTISTS: "albumartist",
	DISCOGS_CATALOG: "catalognumber",
	DISCOGS_COUNTRY: "releasecountry",
	DISCOGS_DATE: "originaldate",
	DISCOGS_LABEL: "label",
	DISCOGS_LABEL_ID: "discogs_label_id",
	DISCOGS_MASTER_RELEASE_ID: "discogs_master_release_id",
	DISCOGS_RATING: "discogs_rating",
	DISCOGS_RELEASED: "date",
	DISCOGS_RELEASE_ID: "discogs_release_id",
	DISCOGS_VOTES: "discogs_votes",
	CATALOGID: "catalognumber",
	STYLE: "genre",
	REPLAYGAIN_TRACK_GAIN: "replaygain_track_gain",
	REPLAYGAIN_TRACK_PEAK: "replaygain_track_peak",
	REPLAYGAIN_ALBUM_GAIN: "replaygain_album_gain",
	REPLAYGAIN_ALBUM_PEAK: "replaygain_album_peak",
	REPLAYGAIN_MINMAX: "replaygain_track_minmax",
	REPLAYGAIN_ALBUM_MINMAX: "replaygain_album_minmax",
	REPLAYGAIN_UNDO: "replaygain_undo"
};
var VorbisTagMapper = class VorbisTagMapper extends CommonTagMapper {
	static toRating(email, rating, maxScore) {
		return {
			source: email ? email.toLowerCase() : void 0,
			rating: Number.parseFloat(rating) / maxScore * CommonTagMapper.maxRatingScore
		};
	}
	constructor() {
		super(["vorbis"], vorbisTagMap);
	}
	postMap(tag) {
		if (tag.id === "RATING") tag.value = VorbisTagMapper.toRating(void 0, tag.value, 100);
		else if (tag.id.indexOf("RATING:") === 0) {
			const keys = tag.id.split(":");
			tag.value = VorbisTagMapper.toRating(keys[1], tag.value, 1);
			tag.id = keys[0];
		}
	}
};
//#endregion
//#region node_modules/music-metadata/lib/riff/RiffInfoTagMap.js
/**
* RIFF Info Tags; part of the EXIF 2.3
* Ref: http://owl.phy.queensu.ca/~phil/exiftool/TagNames/RIFF.html#Info
*/
const riffInfoTagMap = {
	IART: "artist",
	ICRD: "date",
	INAM: "title",
	TITL: "title",
	IPRD: "album",
	ITRK: "track",
	IPRT: "track",
	COMM: "comment",
	ICMT: "comment",
	ICNT: "releasecountry",
	GNRE: "genre",
	IWRI: "writer",
	RATE: "rating",
	YEAR: "year",
	ISFT: "encodedby",
	CODE: "encodedby",
	TURL: "website",
	IGNR: "genre",
	IENG: "engineer",
	ITCH: "technician",
	IMED: "media",
	IRPD: "album"
};
var RiffInfoTagMapper = class extends CommonTagMapper {
	constructor() {
		super(["exif"], riffInfoTagMap);
	}
};
//#endregion
//#region node_modules/music-metadata/lib/matroska/MatroskaTagMapper.js
/**
* EBML Tag map
*/
const ebmlTagMap = {
	"segment:title": "title",
	"album:ARTIST": "albumartist",
	"album:ARTISTSORT": "albumartistsort",
	"album:TITLE": "album",
	"album:DATE_RECORDED": "originaldate",
	"album:DATE_RELEASED": "releasedate",
	"album:PART_NUMBER": "disk",
	"album:TOTAL_PARTS": "totaltracks",
	"track:ARTIST": "artist",
	"track:ARTISTSORT": "artistsort",
	"track:TITLE": "title",
	"track:PART_NUMBER": "track",
	"track:MUSICBRAINZ_TRACKID": "musicbrainz_recordingid",
	"track:MUSICBRAINZ_ALBUMID": "musicbrainz_albumid",
	"track:MUSICBRAINZ_ARTISTID": "musicbrainz_artistid",
	"track:PUBLISHER": "label",
	"track:GENRE": "genre",
	"track:ENCODER": "encodedby",
	"track:ENCODER_OPTIONS": "encodersettings",
	"edition:TOTAL_PARTS": "totaldiscs",
	picture: "picture"
};
var MatroskaTagMapper = class extends CaseInsensitiveTagMap {
	constructor() {
		super(["matroska"], ebmlTagMap);
	}
};
//#endregion
//#region node_modules/music-metadata/lib/aiff/AiffTagMap.js
/**
* ID3v1 tag mappings
*/
const tagMap = {
	NAME: "title",
	AUTH: "artist",
	"(c) ": "copyright",
	ANNO: "comment"
};
var AiffTagMapper = class extends CommonTagMapper {
	constructor() {
		super(["AIFF"], tagMap);
	}
};
//#endregion
//#region node_modules/music-metadata/lib/common/CombinedTagMapper.js
var CombinedTagMapper = class {
	constructor() {
		this.tagMappers = {};
		[
			new ID3v1TagMapper(),
			new ID3v22TagMapper(),
			new ID3v24TagMapper(),
			new MP4TagMapper(),
			new MP4TagMapper(),
			new VorbisTagMapper(),
			new APEv2TagMapper(),
			new AsfTagMapper(),
			new RiffInfoTagMapper(),
			new MatroskaTagMapper(),
			new AiffTagMapper()
		].forEach((mapper) => {
			this.registerTagMapper(mapper);
		});
	}
	/**
	* Convert native to generic (common) tags
	* @param tagType Originating tag format
	* @param tag     Native tag to map to a generic tag id
	* @param warnings
	* @return Generic tag result (output of this function)
	*/
	mapTag(tagType, tag, warnings) {
		if (this.tagMappers[tagType]) return this.tagMappers[tagType].mapGenericTag(tag, warnings);
		throw new InternalParserError(`No generic tag mapper defined for tag-format: ${tagType}`);
	}
	registerTagMapper(genericTagMapper) {
		for (const tagType of genericTagMapper.tagTypes) this.tagMappers[tagType] = genericTagMapper;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/lrc/LyricsParser.js
const TIMESTAMP_REGEX = /\[(\d{2}):(\d{2})\.(\d{2,3})]/;
function parseLyrics(input) {
	if (TIMESTAMP_REGEX.test(input)) return parseLrc(input);
	return toUnsyncedLyrics(input);
}
function toUnsyncedLyrics(lyrics) {
	return {
		contentType: LyricsContentType.lyrics,
		timeStampFormat: TimestampFormat.notSynchronized,
		text: lyrics.trim(),
		syncText: []
	};
}
/**
* Parse LRC (Lyrics) formatted text
* Ref: https://en.wikipedia.org/wiki/LRC_(file_format)
* @param lrcString
*/
function parseLrc(lrcString) {
	const lines = lrcString.split("\n");
	const syncText = [];
	for (const line of lines) {
		const match = line.match(TIMESTAMP_REGEX);
		if (match) {
			const minutes = Number.parseInt(match[1], 10);
			const seconds = Number.parseInt(match[2], 10);
			const ms = match[3].length === 3 ? Number.parseInt(match[3], 10) : Number.parseInt(match[3], 10) * 10;
			const timestamp = (minutes * 60 + seconds) * 1e3 + ms;
			const text = line.replace(TIMESTAMP_REGEX, "").trim();
			syncText.push({
				timestamp,
				text
			});
		}
	}
	return {
		contentType: LyricsContentType.lyrics,
		timeStampFormat: TimestampFormat.milliseconds,
		text: syncText.map((line) => line.text).join("\n"),
		syncText
	};
}
//#endregion
//#region node_modules/music-metadata/lib/common/MetadataCollector.js
var import_src = /* @__PURE__ */ __toESM(require_src(), 1);
const debug$1 = (0, import_src.default)("music-metadata:collector");
const TagPriority = [
	"matroska",
	"APEv2",
	"vorbis",
	"ID3v2.4",
	"ID3v2.3",
	"ID3v2.2",
	"exif",
	"asf",
	"iTunes",
	"AIFF",
	"ID3v1"
];
/**
* Provided to the parser to uodate the metadata result.
* Responsible for triggering async updates
*/
var MetadataCollector = class {
	constructor(opts) {
		this.format = {
			tagTypes: [],
			trackInfo: []
		};
		this.native = {};
		this.common = {
			track: {
				no: null,
				of: null
			},
			disk: {
				no: null,
				of: null
			},
			movementIndex: {
				no: null,
				of: null
			}
		};
		this.quality = { warnings: [] };
		/**
		* Keeps track of origin priority for each mapped id
		*/
		this.commonOrigin = {};
		/**
		* Maps a tag type to a priority
		*/
		this.originPriority = {};
		this.tagMapper = new CombinedTagMapper();
		this.opts = opts;
		let priority = 1;
		for (const tagType of TagPriority) this.originPriority[tagType] = priority++;
		this.originPriority.artificial = 500;
		this.originPriority.id3v1 = 600;
	}
	/**
	* @returns {boolean} true if one or more tags have been found
	*/
	hasAny() {
		return Object.keys(this.native).length > 0;
	}
	addStreamInfo(streamInfo) {
		debug$1(`streamInfo: type=${streamInfo.type ? TrackTypeValueToKeyMap[streamInfo.type] : "?"}, codec=${streamInfo.codecName}`);
		this.format.trackInfo.push(streamInfo);
	}
	setFormat(key, value) {
		debug$1(`format: ${key} = ${value}`);
		this.format[key] = value;
		if (this.opts?.observer) this.opts.observer({
			metadata: this,
			tag: {
				type: "format",
				id: key,
				value
			}
		});
	}
	setAudioOnly() {
		this.setFormat("hasAudio", true);
		this.setFormat("hasVideo", false);
	}
	async addTag(tagType, tagId, value) {
		debug$1(`tag ${tagType}.${tagId} = ${value}`);
		if (!this.native[tagType]) {
			this.format.tagTypes.push(tagType);
			this.native[tagType] = [];
		}
		this.native[tagType].push({
			id: tagId,
			value
		});
		await this.toCommon(tagType, tagId, value);
	}
	addWarning(warning) {
		this.quality.warnings.push({ message: warning });
	}
	async postMap(tagType, tag) {
		switch (tag.id) {
			case "artist": return this.handleSingularArtistTag(tagType, tag, "artist", "artists");
			case "albumartist": return this.handleSingularArtistTag(tagType, tag, "albumartist", "albumartists");
			case "artists": return this.handlePluralArtistTag(tagType, tag, "artist", "artists");
			case "albumartists": return this.handlePluralArtistTag(tagType, tag, "albumartist", "albumartists");
			case "picture": return this.postFixPicture(tag.value).then((picture) => {
				if (picture !== null) {
					tag.value = picture;
					this.setGenericTag(tagType, tag);
				}
			});
			case "totaltracks":
				this.common.track.of = CommonTagMapper.toIntOrNull(tag.value);
				return;
			case "totaldiscs":
				this.common.disk.of = CommonTagMapper.toIntOrNull(tag.value);
				return;
			case "movementTotal":
				this.common.movementIndex.of = CommonTagMapper.toIntOrNull(tag.value);
				return;
			case "track":
			case "disk":
			case "movementIndex": {
				const of = this.common[tag.id].of;
				this.common[tag.id] = CommonTagMapper.normalizeTrack(tag.value);
				this.common[tag.id].of = of != null ? of : this.common[tag.id].of;
				return;
			}
			case "bpm":
			case "year":
			case "originalyear":
				tag.value = Number.parseInt(tag.value, 10);
				break;
			case "date": {
				const year = Number.parseInt(tag.value.substr(0, 4), 10);
				if (!Number.isNaN(year)) this.common.year = year;
				break;
			}
			case "discogs_label_id":
			case "discogs_release_id":
			case "discogs_master_release_id":
			case "discogs_artist_id":
			case "discogs_votes":
				tag.value = typeof tag.value === "string" ? Number.parseInt(tag.value, 10) : tag.value;
				break;
			case "replaygain_track_gain":
			case "replaygain_track_peak":
			case "replaygain_album_gain":
			case "replaygain_album_peak":
				tag.value = toRatio(tag.value);
				break;
			case "replaygain_track_minmax":
				tag.value = tag.value.split(",").map((v) => Number.parseInt(v, 10));
				break;
			case "replaygain_undo": {
				const minMix = tag.value.split(",").map((v) => Number.parseInt(v, 10));
				tag.value = {
					leftChannel: minMix[0],
					rightChannel: minMix[1]
				};
				break;
			}
			case "gapless":
			case "compilation":
			case "podcast":
			case "showMovement":
				tag.value = tag.value === "1" || tag.value === 1;
				break;
			case "isrc": {
				const commonTag = this.common[tag.id];
				if (commonTag && commonTag.indexOf(tag.value) !== -1) return;
				break;
			}
			case "comment":
				if (typeof tag.value === "string") tag.value = { text: tag.value };
				if (tag.value.descriptor === "iTunPGAP") this.setGenericTag(tagType, {
					id: "gapless",
					value: tag.value.text === "1"
				});
				break;
			case "lyrics":
				if (typeof tag.value === "string") tag.value = parseLyrics(tag.value);
				break;
			default:
		}
		if (tag.value !== null) this.setGenericTag(tagType, tag);
	}
	/**
	* Convert native tags to common tags
	* @returns {IAudioMetadata} Native + common tags
	*/
	toCommonMetadata() {
		return {
			format: this.format,
			native: this.native,
			quality: this.quality,
			common: this.common
		};
	}
	/**
	* Handle singular artist tags (artist, albumartist) and cross-populate to plural form
	*/
	handleSingularArtistTag(tagType, tag, singularId, pluralId) {
		if (this.commonOrigin[singularId] === this.originPriority[tagType]) return this.postMap("artificial", {
			id: pluralId,
			value: tag.value
		});
		if (!this.common[pluralId]) this.setGenericTag("artificial", {
			id: pluralId,
			value: tag.value
		});
		this.setGenericTag(tagType, tag);
	}
	/**
	* Handle plural artist tags (artists, albumartists) and cross-populate to singular form
	*/
	handlePluralArtistTag(tagType, tag, singularId, pluralId) {
		if (!this.common[singularId] || this.commonOrigin[singularId] === this.originPriority.artificial) {
			if (!this.common[pluralId] || this.common[pluralId].indexOf(tag.value) === -1) {
				const value = joinArtists((this.common[pluralId] || []).concat([tag.value]));
				this.setGenericTag("artificial", {
					id: singularId,
					value
				});
			}
		}
		this.setGenericTag(tagType, tag);
	}
	/**
	* Fix some common issues with picture object
	* @param picture Picture
	*/
	async postFixPicture(picture) {
		if (picture.data && picture.data.length > 0) {
			if (!picture.format) {
				const fileType = await fileTypeFromBuffer(Uint8Array.from(picture.data));
				if (fileType) picture.format = fileType.mime;
				else return null;
			}
			picture.format = picture.format.toLocaleLowerCase();
			switch (picture.format) {
				case "image/jpg": picture.format = "image/jpeg";
			}
			return picture;
		}
		this.addWarning("Empty picture tag found");
		return null;
	}
	/**
	* Convert native tag to common tags
	*/
	async toCommon(tagType, tagId, value) {
		const tag = {
			id: tagId,
			value
		};
		const genericTag = this.tagMapper.mapTag(tagType, tag, this);
		if (genericTag) await this.postMap(tagType, genericTag);
	}
	/**
	* Set generic tag
	*/
	setGenericTag(tagType, tag) {
		debug$1(`common.${tag.id} = ${tag.value}`);
		const prio0 = this.commonOrigin[tag.id] || 1e3;
		const prio1 = this.originPriority[tagType];
		if (isSingleton(tag.id)) if (prio1 <= prio0) {
			this.common[tag.id] = tag.value;
			this.commonOrigin[tag.id] = prio1;
		} else return debug$1(`Ignore native tag (singleton): ${tagType}.${tag.id} = ${tag.value}`);
		else if (prio1 === prio0) if (!isUnique(tag.id) || this.common[tag.id].indexOf(tag.value) === -1) this.common[tag.id].push(tag.value);
		else debug$1(`Ignore duplicate value: ${tagType}.${tag.id} = ${tag.value}`);
		else if (prio1 < prio0) {
			this.common[tag.id] = [tag.value];
			this.commonOrigin[tag.id] = prio1;
		} else return debug$1(`Ignore native tag (list): ${tagType}.${tag.id} = ${tag.value}`);
		if (this.opts?.observer) this.opts.observer({
			metadata: this,
			tag: {
				type: "common",
				id: tag.id,
				value: tag.value
			}
		});
	}
};
function joinArtists(artists) {
	if (artists.length > 2) return `${artists.slice(0, artists.length - 1).join(", ")} & ${artists[artists.length - 1]}`;
	return artists.join(" & ");
}
//#endregion
//#region node_modules/music-metadata/lib/mpeg/MpegLoader.js
const mpegParserLoader = {
	parserType: "mpeg",
	extensions: [
		".mp2",
		".mp3",
		".m2a",
		".aac",
		"aacp"
	],
	mimeTypes: [
		"audio/mpeg",
		"audio/mp3",
		"audio/aacs",
		"audio/aacp"
	],
	async load() {
		return (await import("./MpegParser-DEnVUH54.js")).MpegParser;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/apev2/Apev2Loader.js
const apeParserLoader = {
	parserType: "apev2",
	extensions: [".ape"],
	mimeTypes: ["audio/ape", "audio/monkeys-audio"],
	async load() {
		return (await import("./APEv2Parser-8CV_INoz.js")).APEv2Parser;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/asf/AsfLoader.js
const asfParserLoader = {
	parserType: "asf",
	extensions: [
		".asf",
		".wma",
		".wmv"
	],
	mimeTypes: [
		"audio/ms-wma",
		"video/ms-wmv",
		"audio/ms-asf",
		"video/ms-asf",
		"application/vnd.ms-asf"
	],
	async load() {
		return (await import("./AsfParser-DGIwipte.js")).AsfParser;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/dsdiff/DsdiffLoader.js
const dsdiffParserLoader = {
	parserType: "dsdiff",
	extensions: [".dff"],
	mimeTypes: ["audio/dsf", "audio/dsd"],
	async load() {
		return (await import("./DsdiffParser-IpOL7UEL.js")).DsdiffParser;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/aiff/AiffLoader.js
const aiffParserLoader = {
	parserType: "aiff",
	extensions: [
		".aif",
		"aiff",
		"aifc"
	],
	mimeTypes: [
		"audio/aiff",
		"audio/aif",
		"audio/aifc",
		"application/aiff"
	],
	async load() {
		return (await import("./AiffParser-C8XYeGiL.js")).AIFFParser;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/dsf/DsfLoader.js
const dsfParserLoader = {
	parserType: "dsf",
	extensions: [".dsf"],
	mimeTypes: ["audio/dsf"],
	async load() {
		return (await import("./DsfParser-DcdXjOFl.js")).DsfParser;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/flac/FlacLoader.js
const flacParserLoader = {
	parserType: "flac",
	extensions: [".flac"],
	mimeTypes: ["audio/flac"],
	async load() {
		return (await import("./FlacParser-BxI1tgTI.js")).FlacParser;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/matroska/MatroskaLoader.js
const matroskaParserLoader = {
	parserType: "matroska",
	extensions: [
		".mka",
		".mkv",
		".mk3d",
		".mks",
		"webm"
	],
	mimeTypes: [
		"audio/matroska",
		"video/matroska",
		"audio/webm",
		"video/webm"
	],
	async load() {
		return (await import("./MatroskaParser-CndxxarL.js")).MatroskaParser;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/mp4/Mp4Loader.js
const mp4ParserLoader = {
	parserType: "mp4",
	extensions: [
		".mp4",
		".m4a",
		".m4b",
		".m4pa",
		"m4v",
		"m4r",
		"3gp",
		".mov",
		".movie",
		".qt"
	],
	mimeTypes: [
		"audio/mp4",
		"audio/m4a",
		"video/m4v",
		"video/mp4",
		"video/quicktime"
	],
	async load() {
		return (await import("./MP4Parser-BMuLA8_h.js")).MP4Parser;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/musepack/MusepackLoader.js
const musepackParserLoader = {
	parserType: "musepack",
	extensions: [".mpc"],
	mimeTypes: ["audio/musepack"],
	async load() {
		return (await import("./MusepackParser-BWrzyvf7.js")).MusepackParser;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/ogg/OggLoader.js
const oggParserLoader = {
	parserType: "ogg",
	extensions: [
		".ogg",
		".ogv",
		".oga",
		".ogm",
		".ogx",
		".opus",
		".spx"
	],
	mimeTypes: [
		"audio/ogg",
		"audio/opus",
		"audio/speex",
		"video/ogg"
	],
	async load() {
		return (await import("./OggParser-D-nfDeMG.js")).OggParser;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/wavpack/WavPackLoader.js
const wavpackParserLoader = {
	parserType: "wavpack",
	extensions: [".wv", ".wvp"],
	mimeTypes: ["audio/wavpack"],
	async load() {
		return (await import("./WavPackParser-DsIBXmng.js")).WavPackParser;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/wav/WaveLoader.js
const riffParserLoader = {
	parserType: "riff",
	extensions: [
		".wav",
		"wave",
		".bwf"
	],
	mimeTypes: [
		"audio/vnd.wave",
		"audio/wav",
		"audio/wave"
	],
	async load() {
		return (await import("./WaveParser--U1ynzIg.js")).WaveParser;
	}
};
//#endregion
//#region node_modules/music-metadata/lib/ParserFactory.js
var import_content_type = /* @__PURE__ */ __toESM(require_content_type(), 1);
var import_media_typer = require_media_typer();
const debug = (0, import_src.default)("music-metadata:parser:factory");
function parseHttpContentType(contentType) {
	const type = import_content_type.parse(contentType);
	const mime = (0, import_media_typer.parse)(type.type);
	return {
		type: mime.type,
		subtype: mime.subtype,
		suffix: mime.suffix,
		parameters: type.parameters
	};
}
var ParserFactory = class {
	constructor() {
		this.parsers = [];
		[
			flacParserLoader,
			mpegParserLoader,
			apeParserLoader,
			mp4ParserLoader,
			matroskaParserLoader,
			riffParserLoader,
			oggParserLoader,
			asfParserLoader,
			aiffParserLoader,
			wavpackParserLoader,
			musepackParserLoader,
			dsfParserLoader,
			dsdiffParserLoader
		].forEach((parser) => {
			this.registerParser(parser);
		});
	}
	registerParser(parser) {
		this.parsers.push(parser);
	}
	async parse(tokenizer, parserLoader, opts) {
		if (tokenizer.supportsRandomAccess()) {
			debug("tokenizer supports random-access, scanning for appending headers");
			await scanAppendingHeaders(tokenizer, opts);
		} else debug("tokenizer does not support random-access, cannot scan for appending headers");
		if (!parserLoader) {
			const buf = new Uint8Array(4100);
			if (tokenizer.fileInfo.mimeType) parserLoader = this.findLoaderForContentType(tokenizer.fileInfo.mimeType);
			if (!parserLoader && tokenizer.fileInfo.path) parserLoader = this.findLoaderForExtension(tokenizer.fileInfo.path);
			if (!parserLoader) {
				debug("Guess parser on content...");
				await tokenizer.peekBuffer(buf, { mayBeLess: true });
				const guessedType = await fileTypeFromBuffer(buf, { mpegOffsetTolerance: 10 });
				if (!guessedType || !guessedType.mime) throw new CouldNotDetermineFileTypeError("Failed to determine audio format");
				debug(`Guessed file type is mime=${guessedType.mime}, extension=${guessedType.ext}`);
				parserLoader = this.findLoaderForContentType(guessedType.mime);
				if (!parserLoader) throw new UnsupportedFileTypeError(`Guessed MIME-type not supported: ${guessedType.mime}`);
			}
		}
		debug(`Loading ${parserLoader.parserType} parser...`);
		const metadata = new MetadataCollector(opts);
		const parser = new (await (parserLoader.load()))(metadata, tokenizer, opts ?? {});
		debug(`Parser ${parserLoader.parserType} loaded`);
		await parser.parse();
		if (metadata.format.trackInfo) {
			if (metadata.format.hasAudio === void 0) metadata.setFormat("hasAudio", !!metadata.format.trackInfo.find((track) => track.type === TrackType.audio));
			if (metadata.format.hasVideo === void 0) metadata.setFormat("hasVideo", !!metadata.format.trackInfo.find((track) => track.type === TrackType.video));
		}
		return metadata.toCommonMetadata();
	}
	/**
	* @param filePath - Path, filename or extension to audio file
	* @return Parser submodule name
	*/
	findLoaderForExtension(filePath) {
		if (!filePath) return;
		const extension = getExtension(filePath).toLocaleLowerCase() || filePath;
		return this.parsers.find((parser) => parser.extensions.indexOf(extension) !== -1);
	}
	findLoaderForContentType(httpContentType) {
		let mime;
		if (!httpContentType) return;
		try {
			mime = parseHttpContentType(httpContentType);
		} catch (_err) {
			debug(`Invalid HTTP Content-Type header value: ${httpContentType}`);
			return;
		}
		const subType = mime.subtype.indexOf("x-") === 0 ? mime.subtype.substring(2) : mime.subtype;
		return this.parsers.find((parser) => parser.mimeTypes.find((loader) => loader.indexOf(`${mime.type}/${subType}`) !== -1));
	}
	getSupportedMimeTypes() {
		const mimeTypeSet = /* @__PURE__ */ new Set();
		this.parsers.forEach((loader) => {
			loader.mimeTypes.forEach((mimeType) => {
				mimeTypeSet.add(mimeType);
				mimeTypeSet.add(mimeType.replace("/", "/x-"));
			});
		});
		return Array.from(mimeTypeSet);
	}
};
function getExtension(fname) {
	const i = fname.lastIndexOf(".");
	return i === -1 ? "" : fname.substring(i);
}
async function getLyricsHeaderLength(tokenizer) {
	const fileSize = tokenizer.fileInfo.size;
	if (fileSize >= 143) {
		const buf = new Uint8Array(15);
		const position = tokenizer.position;
		await tokenizer.readBuffer(buf, { position: fileSize - 143 });
		tokenizer.setPosition(position);
		const txt = textDecode(buf, "latin1");
		if (txt.substring(6) === "LYRICS200") return Number.parseInt(txt.substring(0, 6), 10) + 15;
	}
	return 0;
}
//#endregion
//#region node_modules/music-metadata/lib/core.js
/**
* Primary entry point, Node.js specific entry point is MusepackParser.ts
*/
/**
* Parse audio from memory
* @param uint8Array - Uint8Array holding audio data
* @param fileInfo - File information object or MIME-type string
* @param options - Parsing options
* @returns Metadata
* Ref: https://github.com/Borewit/strtok3/blob/e6938c81ff685074d5eb3064a11c0b03ca934c1d/src/index.ts#L15
*/
async function parseBuffer(uint8Array, fileInfo, options = {}) {
	return parseFromTokenizer(fromBuffer(uint8Array, { fileInfo: typeof fileInfo === "string" ? { mimeType: fileInfo } : fileInfo }), options);
}
/**
* Parse audio from ITokenizer source
* @param tokenizer - Audio source implementing the tokenizer interface
* @param options - Parsing options
* @returns Metadata
*/
function parseFromTokenizer(tokenizer, options) {
	return new ParserFactory().parse(tokenizer, void 0, options);
}
async function scanAppendingHeaders(tokenizer, options = {}) {
	let apeOffset = tokenizer.fileInfo.size;
	if (await hasID3v1Header(tokenizer)) {
		apeOffset -= 128;
		const lyricsLen = await getLyricsHeaderLength(tokenizer);
		apeOffset -= lyricsLen;
	}
	options.apeHeader = await APEv2Parser.findApeFooterOffset(tokenizer, apeOffset);
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
function createMatrixSendReceipt(params) {
	return createMessageReceiptFromOutboundResults({
		kind: params.kind,
		...params.replyToId ? { replyToId: params.replyToId } : {},
		...params.threadId ? { threadId: params.threadId } : {},
		results: params.platformMessageIds.map((messageId) => ({
			channel: "matrix",
			messageId,
			roomId: params.roomId
		}))
	});
}
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
		const platformMessageIds = [];
		let lastMessageId = "";
		let receiptKind = "text";
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
			receiptKind = useVoice ? "voice" : "media";
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
			if (eventId) platformMessageIds.push(eventId);
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
				if (followupEventId) platformMessageIds.push(followupEventId);
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
			if (eventId) platformMessageIds.push(eventId);
		}
		return {
			messageId: lastMessageId || "unknown",
			roomId,
			primaryMessageId: platformMessageIds[0] ?? (lastMessageId || "unknown"),
			receipt: createMatrixSendReceipt({
				roomId,
				platformMessageIds,
				kind: receiptKind,
				replyToId: opts.replyToId,
				threadId
			})
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
			receipt: createMatrixSendReceipt({
				roomId: resolvedRoom,
				platformMessageIds: eventId ? [eventId] : [],
				kind: "text",
				replyToId: opts.replyToId,
				threadId: normalizedThreadId
			})
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
