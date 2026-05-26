import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { _ as sleep } from "./utils-CKsuXgDI.js";
import { a as shouldLogVerbose, r as logVerbose, t as danger } from "./globals-CouSpJO4.js";
import { u as resolveStorePath } from "./paths-kGAxo7MN.js";
import { o as updateLastRoute } from "./store-3qAZ3Zl6.js";
import { a as createReplyDispatcherWithTyping, s as settleReplyDispatcher, t as dispatchInboundMessage } from "./dispatch-CvimgVpK.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-BOrd8HRU.js";
import { C as resolveChannelStreamingPreviewToolProgress, a as createChannelProgressDraftGate, b as resolveChannelStreamingNativeTransport, c as formatChannelProgressDraftText, g as resolveChannelProgressDraftRender, h as resolveChannelProgressDraftMaxLines, i as buildChannelProgressDraftLineForEntry, p as resolveChannelProgressDraftLabel, r as buildChannelProgressDraftLine, u as isChannelProgressDraftWorkToolName, v as resolveChannelStreamingBlockEnabled, w as resolveChannelStreamingSuppressDefaultToolProgressMessages } from "./channel-streaming-BfXk-s2d.js";
import { a as deliverWithFinalizableLivePreviewAdapter, r as defineFinalizableLivePreviewAdapter } from "./live-Bp-_0KoT.js";
import { a as resolveInboundLastRouteSessionKey } from "./resolve-route-DQZZzDyD.js";
import { i as resolveHumanDelayConfig } from "./identity-CRZts9Qd.js";
import "./error-runtime-BnVeBNYa.js";
import "./runtime-env-AKjXcC53.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import "./routing-BfSZVtOk.js";
import { n as removeAckReactionAfterReply } from "./ack-reactions-D6S-dTdd.js";
import { t as recordInboundSession } from "./session-BGECYHCy.js";
import { c as clearHistoryEntriesIfEnabled } from "./history-DVJTezhz.js";
import { n as resolveChannelSourceReplyDeliveryMode, t as createChannelReplyPipeline } from "./reply-pipeline-B0RIiqGl.js";
import { r as hasVisibleChannelTurnDispatch } from "./dispatch-result-D_mc19X9.js";
import { l as resolvePinnedMainDmOwnerFromAllowlist } from "./channel-access-compat-Dny0RAlV.js";
import "./reply-history-DFZwzL3w.js";
import "./reply-runtime-Cnhadp3p.js";
import { d as runInboundReplyTurn } from "./inbound-reply-dispatch-BoJXUblV.js";
import { n as resolveAgentOutboundIdentity } from "./identity-BK1E_Y6V.js";
import "./outbound-runtime-HTtq1b9m.js";
import "./agent-runtime-C0lBBqMR.js";
import "./security-runtime-JcBeOGgV.js";
import { r as logTypingFailure, t as logAckFailure } from "./logging-BKsFuiAg.js";
import { a as createStatusReactionController, r as DEFAULT_TIMING } from "./channel-feedback-B9Irbkxa.js";
import { s as createDraftStreamLoop } from "./channel-lifecycle-BrKB268B.js";
import "./channel-message-CmG6T1ry.js";
import { i as truncateSlackText, r as SLACK_TEXT_LIMIT } from "./thread-ts-DWLXPVhT.js";
import { n as isSlackInteractiveRepliesEnabled, t as compileSlackInteractiveReplies } from "./interactive-replies-DNuhlh3P.js";
import { i as normalizeSlackAllowOwnerEntry } from "./allow-list-NJrZzx1V.js";
import "./blocks-input-BkCFIqct.js";
import { n as resolveSlackNativeStreaming, r as resolveSlackStreamingMode, t as mapStreamingModeToSlackLegacyDraftStreamMode } from "./streaming-compat-C_8hxj7n.js";
import { a as recordSlackThreadParticipation, s as normalizeSlackOutboundText, t as sendMessageSlack } from "./send-N1ZXm8DK.js";
import { f as removeSlackReaction, h as buildSlackEditTextPayload, l as reactSlackMessage, r as editSlackMessage, t as deleteSlackMessage } from "./actions-DM_Aqnbb.js";
import { t as formatSlackError } from "./errors-C7qatgFo.js";
import "./room-context-DrGzGSyg.js";
import { t as escapeSlackMrkdwn } from "./mrkdwn-D4v581Ex.js";
import { n as resolveSlackThreadTargets, t as prepareSlackMessage } from "./prepare-XVP5TK-H.js";
import { a as resolveDeliveredSlackReplyThreadTs, i as readSlackReplyBlocks, n as deliverReplies, o as resolveSlackThreadTs, t as createSlackReplyDeliveryPlan } from "./replies-Bf9e5TlH.js";
//#region extensions/slack/src/draft-stream.ts
const DEFAULT_THROTTLE_MS = 1e3;
function createSlackDraftStream(params) {
	const maxChars = Math.min(params.maxChars ?? 8e3, SLACK_TEXT_LIMIT);
	const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
	const send = params.send ?? sendMessageSlack;
	const edit = params.edit ?? editSlackMessage;
	const remove = params.remove ?? deleteSlackMessage;
	let streamMessageId;
	let streamChannelId;
	let lastSentKey = "";
	let pendingUpdate;
	let stopped = false;
	const normalizeUpdate = (update) => typeof update === "string" ? { text: update } : update;
	const sendOrEditStreamMessage = async (text) => {
		if (stopped) return;
		const trimmed = text.trimEnd();
		if (!trimmed) return;
		if (trimmed.length > maxChars) {
			stopped = true;
			params.warn?.(`slack stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
			return;
		}
		const update = normalizeUpdate(pendingUpdate ?? text);
		const blocks = update.text === text ? update.blocks : void 0;
		const sentKey = `${trimmed}\n${blocks ? JSON.stringify(blocks) : ""}`;
		if (sentKey === lastSentKey) return;
		lastSentKey = sentKey;
		try {
			if (streamChannelId && streamMessageId) {
				await edit(streamChannelId, streamMessageId, trimmed, {
					cfg: params.cfg,
					token: params.token,
					accountId: params.accountId,
					...blocks ? { blocks } : {}
				});
				return;
			}
			const sent = await send(params.target, trimmed, {
				cfg: params.cfg,
				token: params.token,
				accountId: params.accountId,
				threadTs: params.resolveThreadTs?.(),
				identity: params.identity,
				...blocks ? { blocks } : {}
			});
			streamChannelId = sent.channelId || streamChannelId;
			streamMessageId = sent.messageId || streamMessageId;
			if (!streamChannelId || !streamMessageId) {
				stopped = true;
				params.warn?.("slack stream preview stopped (missing identifiers from sendMessage)");
				return;
			}
			params.onMessageSent?.();
		} catch (err) {
			stopped = true;
			params.warn?.(`slack stream preview failed: ${formatSlackError(err)}`);
		}
	};
	const loop = createDraftStreamLoop({
		throttleMs,
		isStopped: () => stopped,
		sendOrEditStreamMessage
	});
	const stop = () => {
		stopped = true;
		loop.stop();
	};
	const discardPending = async () => {
		stop();
		await loop.waitForInFlight();
	};
	const clear = async () => {
		await discardPending();
		const channelId = streamChannelId;
		const messageId = streamMessageId;
		streamChannelId = void 0;
		streamMessageId = void 0;
		lastSentKey = "";
		pendingUpdate = void 0;
		if (!channelId || !messageId) return;
		try {
			await remove(channelId, messageId, {
				token: params.token,
				accountId: params.accountId
			});
		} catch (err) {
			params.warn?.(`slack stream preview cleanup failed: ${formatSlackError(err)}`);
		}
	};
	const forceNewMessage = () => {
		streamMessageId = void 0;
		streamChannelId = void 0;
		lastSentKey = "";
		pendingUpdate = void 0;
		loop.resetPending();
	};
	params.log?.(`slack stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);
	return {
		update: (update) => {
			const normalized = normalizeUpdate(update);
			pendingUpdate = update;
			loop.update(normalized.text);
		},
		flush: loop.flush,
		clear,
		discardPending,
		seal: discardPending,
		stop,
		forceNewMessage,
		messageId: () => streamMessageId,
		channelId: () => streamChannelId
	};
}
//#endregion
//#region extensions/slack/src/progress-blocks.ts
const SLACK_PROGRESS_FIELD_MAX = 1800;
const SLACK_PROGRESS_DETAIL_MAX_CHARS = 48;
function field(text) {
	return {
		type: "mrkdwn",
		text: truncateSlackText(text, SLACK_PROGRESS_FIELD_MAX)
	};
}
function lineTitle(line) {
	return `${line.icon ?? "•"} *${escapeSlackMrkdwn(line.label)}*`;
}
function compactDetail(value) {
	const normalized = value.replace(/\s+/g, " ").trim();
	const chars = Array.from(normalized);
	if (chars.length <= SLACK_PROGRESS_DETAIL_MAX_CHARS) return normalized;
	const keepStart = Math.ceil((SLACK_PROGRESS_DETAIL_MAX_CHARS - 1) * .45);
	const keepEnd = SLACK_PROGRESS_DETAIL_MAX_CHARS - keepStart - 1;
	return `${chars.slice(0, keepStart).join("").trimEnd()}…${chars.slice(-keepEnd).join("").trimStart()}`;
}
function lineDetail(line) {
	const parts = [line.detail, line.status && !line.detail?.includes(line.status) ? line.status : void 0].map((part) => part?.trim()).filter((part) => Boolean(part));
	return parts.length ? escapeSlackMrkdwn(compactDetail(parts.join(" · "))) : " ";
}
function buildSlackProgressDraftBlocks(params) {
	const label = params.label?.trim();
	const blocks = [...label ? [{
		type: "section",
		text: field(`*${escapeSlackMrkdwn(label)}*`)
	}] : [], ...params.lines.map((line) => ({
		type: "section",
		fields: [field(lineTitle(line)), field(lineDetail(line))]
	}))].slice(-50);
	return blocks.length ? blocks : void 0;
}
//#endregion
//#region extensions/slack/src/stream-mode.ts
function resolveSlackStreamingConfig(params) {
	const mode = resolveSlackStreamingMode(params);
	return {
		mode,
		nativeStreaming: resolveSlackNativeStreaming(params),
		draftMode: mapStreamingModeToSlackLegacyDraftStreamMode(mode)
	};
}
function applyAppendOnlyStreamUpdate(params) {
	const incoming = params.incoming.trimEnd();
	if (!incoming) return {
		rendered: params.rendered,
		source: params.source,
		changed: false
	};
	if (!params.rendered) return {
		rendered: incoming,
		source: incoming,
		changed: true
	};
	if (incoming === params.source) return {
		rendered: params.rendered,
		source: params.source,
		changed: false
	};
	if (incoming.startsWith(params.source) || incoming.startsWith(params.rendered)) return {
		rendered: incoming,
		source: incoming,
		changed: incoming !== params.rendered
	};
	if (params.source.startsWith(incoming)) return {
		rendered: params.rendered,
		source: params.source,
		changed: false
	};
	const separator = params.rendered.endsWith("\n") ? "" : "\n";
	return {
		rendered: `${params.rendered}${separator}${incoming}`,
		source: incoming,
		changed: true
	};
}
//#endregion
//#region extensions/slack/src/streaming.ts
/**
* Thrown when Slack rejects a stream flush/finalize with a recipient-resolution
* error (see {@link BENIGN_SLACK_FINALIZE_ERROR_CODES}) while text is still
* only buffered locally by the Slack SDK. Carries the pending text so the
* caller can deliver it via the normal Slack reply path.
*/
var SlackStreamNotDeliveredError = class extends Error {
	constructor(pendingText, slackCode) {
		super(`slack-stream: finalize failed with ${slackCode} before any text reached Slack (${pendingText.length} chars pending)`);
		this.name = "SlackStreamNotDeliveredError";
		this.pendingText = pendingText;
		this.slackCode = slackCode;
	}
};
/**
* Start a new Slack text stream.
*
* Returns a {@link SlackStreamSession} that should be passed to
* {@link appendSlackStream} and {@link stopSlackStream}.
*
* The first chunk of text can optionally be included via `text`.
*/
async function startSlackStream(params) {
	const { client, channel, threadTs, text, teamId, userId } = params;
	logVerbose(`slack-stream: starting stream in ${channel} thread=${threadTs}${teamId ? ` team=${teamId}` : ""}${userId ? ` user=${userId}` : ""}`);
	const streamer = client.chatStream({
		channel,
		thread_ts: threadTs,
		...teamId ? { recipient_team_id: teamId } : {},
		...userId ? { recipient_user_id: userId } : {}
	});
	const session = {
		streamer,
		channel,
		threadTs,
		stopped: false,
		delivered: false,
		pendingText: ""
	};
	if (text) {
		session.pendingText += text;
		try {
			const result = await streamer.append({ markdown_text: text });
			if (result) {
				session.delivered = true;
				session.pendingText = "";
			}
			logVerbose(`slack-stream: appended initial text (${text.length} chars, ${result ? "flushed" : "buffered"})`);
		} catch (err) {
			if (isBenignSlackFinalizeError(err) && session.pendingText) throw new SlackStreamNotDeliveredError(session.pendingText, extractSlackErrorCode(err) ?? "unknown");
			throw err;
		}
	}
	return session;
}
/**
* Append markdown text to an active Slack stream.
*/
async function appendSlackStream(params) {
	const { session, text } = params;
	if (session.stopped) {
		logVerbose("slack-stream: attempted to append to a stopped stream, ignoring");
		return;
	}
	if (!text) return;
	session.pendingText += text;
	try {
		const result = await session.streamer.append({ markdown_text: text });
		if (result) {
			session.delivered = true;
			session.pendingText = "";
		}
		logVerbose(`slack-stream: appended ${text.length} chars (${result ? "flushed" : "buffered"})`);
	} catch (err) {
		if (isBenignSlackFinalizeError(err) && session.pendingText) throw new SlackStreamNotDeliveredError(session.pendingText, extractSlackErrorCode(err) ?? "unknown");
		throw err;
	}
}
/**
* Stop (finalize) a Slack stream.
*
* After calling this the stream message becomes a normal Slack message.
* Optionally include final text to append before stopping.
*
* If Slack's `chat.stopStream` responds with a known benign finalize error
* (see {@link BENIGN_SLACK_FINALIZE_ERROR_CODES}) AND any prior `append`
* has already landed on Slack, the error is swallowed and the session is
* marked stopped - the already-delivered text stays visible.
*
* If the same benign error fires while text is still only buffered locally
* (e.g. short replies that never exceeded the SDK's buffer_size), this
* function throws a {@link SlackStreamNotDeliveredError} carrying that pending
* text so the caller can deliver it through the normal Slack reply path.
*
* All other errors propagate unchanged.
*/
async function stopSlackStream(params) {
	const { session, text } = params;
	if (session.stopped) {
		logVerbose("slack-stream: stream already stopped, ignoring duplicate stop");
		return;
	}
	session.stopped = true;
	if (text) session.pendingText += text;
	logVerbose(`slack-stream: stopping stream in ${session.channel} thread=${session.threadTs}${text ? ` (final text: ${text.length} chars)` : ""}`);
	try {
		await session.streamer.stop(text ? { markdown_text: text } : void 0);
		session.delivered = true;
		session.pendingText = "";
	} catch (err) {
		if (isBenignSlackFinalizeError(err)) {
			const code = extractSlackErrorCode(err) ?? "unknown";
			if (session.pendingText) throw new SlackStreamNotDeliveredError(session.pendingText, code);
			if (session.delivered) {
				logVerbose(`slack-stream: finalize rejected by Slack (${code}); prior appends delivered, treating stream as stopped`);
				return;
			}
		}
		throw err;
	}
	logVerbose("slack-stream: stream stopped");
}
/**
* Slack API error codes that indicate `chat.stopStream` (or the
* `chat.startStream` call the SDK issues inside `stop()` when the buffer
* never flushed) cannot finalize the stream for the current recipient or
* team. Either the caller falls back to a normal message (see
* {@link SlackStreamNotDeliveredError}) or, if prior appends already
* delivered text, the error is logged verbosely and swallowed.
*/
const BENIGN_SLACK_FINALIZE_ERROR_CODES = new Set([
	"user_not_found",
	"team_not_found",
	"missing_recipient_user_id"
]);
function isBenignSlackFinalizeError(err) {
	const code = extractSlackErrorCode(err);
	return code !== void 0 && BENIGN_SLACK_FINALIZE_ERROR_CODES.has(code);
}
function extractSlackErrorCode(err) {
	if (!err || typeof err !== "object") return;
	const record = err;
	if (record.data && typeof record.data === "object") {
		const inner = record.data.error;
		if (typeof inner === "string") return inner;
	}
	return (typeof record.message === "string" ? record.message : "").match(/An API error occurred:\s*([a-z_][a-z0-9_]*)/i)?.[1];
}
function markSlackStreamFallbackDelivered(session) {
	const hadNativeDelivery = session.delivered;
	session.pendingText = "";
	session.delivered = true;
	if (!hadNativeDelivery) session.stopped = true;
}
//#endregion
//#region extensions/slack/src/monitor/message-handler/preview-finalize.ts
function buildExpectedSlackEditText(params) {
	return buildSlackEditTextPayload(params.text, params.blocks);
}
function blocksMatch(expected, actual) {
	if (!expected?.length) return !actual?.length;
	if (!actual?.length) return false;
	return JSON.stringify(expected) === JSON.stringify(actual);
}
async function readSlackMessageAfterEditError(params) {
	if (params.threadTs) return ((await params.client.conversations.replies({
		token: params.token,
		channel: params.channelId,
		ts: params.threadTs,
		latest: params.messageId,
		inclusive: true,
		limit: 100
	})).messages ?? []).find((message) => message?.ts === params.messageId) ?? null;
	const message = (await params.client.conversations.history({
		token: params.token,
		channel: params.channelId,
		latest: params.messageId,
		oldest: params.messageId,
		inclusive: true,
		limit: 1
	})).messages?.[0];
	if (!message?.ts || message.ts !== params.messageId) return null;
	return message;
}
async function didSlackPreviewEditApplyAfterError(params) {
	const readback = await readSlackMessageAfterEditError(params);
	if (!readback) return false;
	const expectedText = buildExpectedSlackEditText({
		text: params.text,
		blocks: params.blocks
	});
	const actualText = normalizeSlackOutboundText((readback.text ?? "").trim());
	if (params.blocks?.length) return actualText === expectedText && blocksMatch(params.blocks, readback.blocks);
	return actualText === expectedText;
}
async function finalizeSlackPreviewEdit(params) {
	try {
		await editSlackMessage(params.channelId, params.messageId, params.text, {
			token: params.token,
			accountId: params.accountId,
			client: params.client,
			...params.blocks?.length ? { blocks: params.blocks } : {}
		});
		return;
	} catch (err) {
		try {
			if (await didSlackPreviewEditApplyAfterError({
				client: params.client,
				token: params.token,
				channelId: params.channelId,
				messageId: params.messageId,
				text: params.text,
				blocks: params.blocks,
				threadTs: params.threadTs
			})) {
				logVerbose(`slack: preview final edit response failed but readback matched message ${params.channelId}/${params.messageId}; suppressing duplicate fallback send`);
				return;
			}
		} catch (readbackErr) {
			logVerbose(`slack: preview final edit readback failed (${String(readbackErr)})`);
		}
		throw err;
	}
}
//#endregion
//#region extensions/slack/src/monitor/message-handler/dispatch.ts
const UNICODE_TO_SLACK = {
	"👀": "eyes",
	"🤔": "thinking_face",
	"🔥": "fire",
	"👨‍💻": "male-technologist",
	"👨💻": "male-technologist",
	"👩‍💻": "female-technologist",
	"⚡": "zap",
	"🌐": "globe_with_meridians",
	"✅": "white_check_mark",
	"👍": "thumbsup",
	"❌": "x",
	"😱": "scream",
	"🥱": "yawning_face",
	"😨": "fearful",
	"⏳": "hourglass_flowing_sand",
	"⚠️": "warning",
	"✍": "writing_hand",
	"🧠": "brain",
	"🛠️": "hammer_and_wrench",
	"💻": "computer"
};
function toSlackEmojiName(emoji) {
	let trimmed = emoji.trim();
	while (trimmed.startsWith(":")) trimmed = trimmed.slice(1);
	while (trimmed.endsWith(":")) trimmed = trimmed.slice(0, -1);
	return UNICODE_TO_SLACK[trimmed] ?? trimmed;
}
function isSlackStreamingEnabled(params) {
	if (params.mode !== "partial") return false;
	return params.nativeStreaming;
}
function shouldEnableSlackPreviewStreaming(params) {
	return params.mode !== "off";
}
function shouldInitializeSlackDraftStream(params) {
	return params.previewStreamingEnabled && !params.useStreaming;
}
function resolveSlackDisableBlockStreaming(params) {
	if (params.useStreaming || params.shouldUseDraftStream) return true;
	return typeof params.blockStreamingEnabled === "boolean" ? !params.blockStreamingEnabled : void 0;
}
function resolveSlackStreamingThreadHint(params) {
	return resolveSlackThreadTs({
		replyToMode: params.replyToMode,
		incomingThreadTs: params.incomingThreadTs,
		messageTs: params.messageTs,
		hasReplied: false,
		isThreadReply: params.isThreadReply
	});
}
const SLACK_STREAM_RECIPIENT_TEAM_CACHE_MAX = 2e3;
const slackStreamRecipientTeamCache = /* @__PURE__ */ new Map();
function buildSlackTurnDeliveryKey(params) {
	const reply = resolveSendableOutboundReplyParts(params.payload, { text: params.textOverride });
	const slackBlocks = readSlackReplyBlocks(params.payload);
	if (!reply.hasContent && !slackBlocks?.length) return null;
	return JSON.stringify({
		kind: params.kind,
		threadTs: params.threadTs ?? "",
		replyToId: params.payload.replyToId ?? null,
		text: reply.trimmedText,
		mediaUrls: reply.mediaUrls,
		blocks: slackBlocks ?? null
	});
}
function readSlackStreamRecipientTeamCache(params) {
	if (!params.fallbackTeamId || !params.userId) return;
	const cacheKey = `${params.fallbackTeamId}:${params.userId}`;
	const cached = slackStreamRecipientTeamCache.get(cacheKey);
	if (!cached) return;
	slackStreamRecipientTeamCache.delete(cacheKey);
	slackStreamRecipientTeamCache.set(cacheKey, cached);
	return cached;
}
function rememberSlackStreamRecipientTeam(params) {
	if (!params.fallbackTeamId || !params.userId) return;
	const cacheKey = `${params.fallbackTeamId}:${params.userId}`;
	if (slackStreamRecipientTeamCache.has(cacheKey)) slackStreamRecipientTeamCache.delete(cacheKey);
	slackStreamRecipientTeamCache.set(cacheKey, params.teamId);
	if (slackStreamRecipientTeamCache.size > SLACK_STREAM_RECIPIENT_TEAM_CACHE_MAX) {
		const oldest = slackStreamRecipientTeamCache.keys().next().value;
		if (oldest) slackStreamRecipientTeamCache.delete(oldest);
	}
}
function createSlackTurnDeliveryTracker() {
	const deliveredKeys = /* @__PURE__ */ new Set();
	return {
		hasDelivered(params) {
			const key = buildSlackTurnDeliveryKey(params);
			return key ? deliveredKeys.has(key) : false;
		},
		markDelivered(params) {
			const key = buildSlackTurnDeliveryKey(params);
			if (key) deliveredKeys.add(key);
		}
	};
}
function shouldUseStreaming(params) {
	if (!params.streamingEnabled) return false;
	if (!params.threadTs) {
		logVerbose("slack-stream: streaming disabled — no reply thread target available");
		return false;
	}
	return true;
}
async function resolveSlackStreamRecipientTeamId(params) {
	const cachedTeamId = readSlackStreamRecipientTeamCache(params);
	if (cachedTeamId) return cachedTeamId;
	if (params.userId) try {
		const info = await params.client.users.info({
			token: params.token,
			user: params.userId
		});
		const teamId = info.user?.team_id ?? info.user?.profile?.team;
		if (teamId) {
			rememberSlackStreamRecipientTeam({
				...params,
				teamId
			});
			return teamId;
		}
	} catch (err) {
		logVerbose(`slack-stream: users.info team lookup failed (${formatErrorMessage(err)})`);
	}
	return params.fallbackTeamId;
}
async function dispatchPreparedSlackMessage(prepared) {
	const { ctx, account, message, route } = prepared;
	const cfg = ctx.cfg;
	const runtime = ctx.runtime;
	const outboundIdentity = resolveAgentOutboundIdentity(cfg, route.agentId);
	const slackIdentity = outboundIdentity ? {
		username: outboundIdentity.name,
		iconUrl: outboundIdentity.avatarUrl,
		iconEmoji: outboundIdentity.emoji
	} : void 0;
	if (prepared.isDirectMessage) {
		const sessionCfg = cfg.session;
		const storePath = resolveStorePath(sessionCfg?.store, { agentId: route.agentId });
		const pinnedMainDmOwner = resolvePinnedMainDmOwnerFromAllowlist({
			dmScope: cfg.session?.dmScope,
			allowFrom: ctx.allowFrom,
			normalizeEntry: normalizeSlackAllowOwnerEntry
		});
		const senderRecipient = normalizeOptionalLowercaseString(message.user);
		if (pinnedMainDmOwner && senderRecipient && normalizeOptionalLowercaseString(pinnedMainDmOwner) !== senderRecipient) logVerbose(`slack: skip main-session last route for ${senderRecipient} (pinned owner ${pinnedMainDmOwner})`);
		else await updateLastRoute({
			storePath,
			sessionKey: resolveInboundLastRouteSessionKey({
				route,
				sessionKey: prepared.ctxPayload.SessionKey ?? route.sessionKey
			}),
			deliveryContext: {
				channel: "slack",
				to: `user:${message.user}`,
				accountId: route.accountId,
				threadId: prepared.ctxPayload.MessageThreadId
			},
			ctx: prepared.ctxPayload
		});
	}
	const { statusThreadTs, isThreadReply } = resolveSlackThreadTargets({
		message,
		replyToMode: prepared.replyToMode
	});
	const sourceReplyDeliveryMode = resolveChannelSourceReplyDeliveryMode({
		cfg,
		ctx: prepared.ctxPayload
	});
	const sourceRepliesAreToolOnly = sourceReplyDeliveryMode === "message_tool_only";
	const reactionMessageTs = prepared.ackReactionMessageTs;
	const messageTs = message.ts ?? message.event_ts;
	const incomingThreadTs = message.thread_ts;
	let didSetStatus = false;
	const statusReactionsEnabled = Boolean(prepared.ackReactionPromise) && Boolean(reactionMessageTs) && cfg.messages?.statusReactions?.enabled !== false;
	const slackStatusAdapter = {
		setReaction: async (emoji) => {
			await reactSlackMessage(message.channel, reactionMessageTs ?? "", toSlackEmojiName(emoji), {
				token: ctx.botToken,
				client: ctx.app.client
			}).catch((err) => {
				if (formatErrorMessage(err).includes("already_reacted")) return;
				throw err;
			});
		},
		removeReaction: async (emoji) => {
			await removeSlackReaction(message.channel, reactionMessageTs ?? "", toSlackEmojiName(emoji), {
				token: ctx.botToken,
				client: ctx.app.client
			}).catch((err) => {
				if (formatErrorMessage(err).includes("no_reaction")) return;
				throw err;
			});
		}
	};
	const statusReactionTiming = {
		...DEFAULT_TIMING,
		...cfg.messages?.statusReactions?.timing
	};
	const statusReactions = createStatusReactionController({
		enabled: statusReactionsEnabled,
		adapter: slackStatusAdapter,
		initialEmoji: prepared.ackReactionValue || "eyes",
		emojis: cfg.messages?.statusReactions?.emojis,
		timing: cfg.messages?.statusReactions?.timing,
		onError: (err) => {
			logAckFailure({
				log: logVerbose,
				channel: "slack",
				target: `${message.channel}/${message.ts}`,
				error: err
			});
		}
	});
	if (statusReactionsEnabled) statusReactions.setQueued();
	const hasRepliedRef = { value: false };
	const replyPlan = createSlackReplyDeliveryPlan({
		replyToMode: prepared.replyToMode,
		incomingThreadTs,
		messageTs,
		hasRepliedRef,
		isThreadReply
	});
	const typingTarget = statusThreadTs ? `${message.channel}/${statusThreadTs}` : message.channel;
	const typingReaction = ctx.typingReaction;
	const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
		cfg,
		agentId: route.agentId,
		channel: "slack",
		accountId: route.accountId,
		transformReplyPayload: (payload) => isSlackInteractiveRepliesEnabled({
			cfg,
			accountId: route.accountId
		}) ? compileSlackInteractiveReplies(payload) : payload,
		typing: {
			start: async () => {
				didSetStatus = true;
				await ctx.setSlackThreadStatus({
					channelId: message.channel,
					threadTs: statusThreadTs,
					status: "is typing..."
				});
				if (typingReaction && message.ts) await reactSlackMessage(message.channel, message.ts, typingReaction, {
					token: ctx.botToken,
					client: ctx.app.client
				}).catch(() => {});
			},
			stop: async () => {
				if (!didSetStatus) return;
				didSetStatus = false;
				await ctx.setSlackThreadStatus({
					channelId: message.channel,
					threadTs: statusThreadTs,
					status: ""
				});
				if (typingReaction && message.ts) await removeSlackReaction(message.channel, message.ts, typingReaction, {
					token: ctx.botToken,
					client: ctx.app.client
				}).catch(() => {});
			},
			onStartError: (err) => {
				logTypingFailure({
					log: (message) => runtime.error?.(danger(message)),
					channel: "slack",
					action: "start",
					target: typingTarget,
					error: err
				});
			},
			onStopError: (err) => {
				logTypingFailure({
					log: (message) => runtime.error?.(danger(message)),
					channel: "slack",
					action: "stop",
					target: typingTarget,
					error: err
				});
			}
		}
	});
	const slackStreaming = resolveSlackStreamingConfig({
		streaming: account.config.streaming,
		nativeStreaming: resolveChannelStreamingNativeTransport(account.config)
	});
	const streamThreadHint = resolveSlackStreamingThreadHint({
		replyToMode: prepared.replyToMode,
		incomingThreadTs,
		messageTs,
		isThreadReply
	});
	const previewStreamingEnabled = !sourceRepliesAreToolOnly && shouldEnableSlackPreviewStreaming({ mode: slackStreaming.mode });
	const useStreaming = shouldUseStreaming({
		streamingEnabled: !sourceRepliesAreToolOnly && isSlackStreamingEnabled({
			mode: slackStreaming.mode,
			nativeStreaming: slackStreaming.nativeStreaming
		}),
		threadTs: streamThreadHint
	});
	const shouldUseDraftStream = shouldInitializeSlackDraftStream({
		previewStreamingEnabled,
		useStreaming
	});
	const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(account.config);
	const disableBlockStreaming = sourceRepliesAreToolOnly ? true : resolveSlackDisableBlockStreaming({
		useStreaming,
		shouldUseDraftStream,
		blockStreamingEnabled
	});
	let streamSession = null;
	let streamFailed = false;
	let usedReplyThreadTs;
	let usedBlockReplyThreadTs;
	let observedReplyDelivery = false;
	const deliveryTracker = createSlackTurnDeliveryTracker();
	const resolveDeliveryThreadTs = (params) => {
		const plannedThreadTs = params.forcedThreadTs ? void 0 : replyPlan.nextThreadTs();
		return params.forcedThreadTs ?? plannedThreadTs ?? (params.kind === "block" ? usedBlockReplyThreadTs : void 0);
	};
	const rememberDeliveredThreadTs = (kind, deliveredThreadTs) => {
		if (!deliveredThreadTs) return;
		usedReplyThreadTs ??= deliveredThreadTs;
		if (kind === "block") usedBlockReplyThreadTs = deliveredThreadTs;
	};
	const deliverPendingStreamFallback = async (session, err) => {
		const fallbackText = err.pendingText.trim();
		if (!fallbackText) return false;
		try {
			await deliverReplies({
				cfg: ctx.cfg,
				replies: [{ text: fallbackText }],
				target: prepared.replyTarget,
				token: ctx.botToken,
				accountId: account.accountId,
				runtime,
				textLimit: ctx.textLimit,
				replyThreadTs: session.threadTs,
				replyToMode: prepared.replyToMode,
				...slackIdentity ? { identity: slackIdentity } : {}
			});
			markSlackStreamFallbackDelivered(session);
			observedReplyDelivery = true;
			usedReplyThreadTs ??= session.threadTs;
			logVerbose(`slack-stream: streamed delivery failed (${err.slackCode}); delivered ${fallbackText.length} chars via deliverReplies fallback`);
			return true;
		} catch (postErr) {
			runtime.error?.(danger(`slack-stream: fallback deliverReplies failed after ${err.slackCode}: ${formatErrorMessage(postErr)}`));
			return false;
		}
	};
	const deliverNormally = async (params) => {
		const replyThreadTs = resolveDeliveryThreadTs(params);
		if (deliveryTracker.hasDelivered({
			kind: params.kind,
			payload: params.payload,
			threadTs: replyThreadTs
		})) {
			logVerbose("slack: suppressed duplicate normal delivery within the same turn");
			return;
		}
		await deliverReplies({
			cfg: ctx.cfg,
			replies: [params.payload],
			target: prepared.replyTarget,
			token: ctx.botToken,
			accountId: account.accountId,
			runtime,
			textLimit: ctx.textLimit,
			replyThreadTs,
			replyToMode: prepared.replyToMode,
			...slackIdentity ? { identity: slackIdentity } : {}
		});
		observedReplyDelivery = true;
		const deliveredThreadTs = resolveDeliveredSlackReplyThreadTs({
			replyToMode: prepared.replyToMode,
			payloadReplyToId: params.payload.replyToId,
			replyThreadTs
		});
		rememberDeliveredThreadTs(params.kind, deliveredThreadTs);
		replyPlan.markSent();
		deliveryTracker.markDelivered({
			kind: params.kind,
			payload: params.payload,
			threadTs: replyThreadTs
		});
	};
	const deliverBufferedStreamFallback = async (params) => {
		if (!await deliverPendingStreamFallback(params.session, params.err)) return false;
		replyPlan.markSent();
		deliveryTracker.markDelivered({
			kind: params.kind,
			payload: params.payload,
			threadTs: params.session.threadTs,
			textOverride: params.textOverride
		});
		rememberDeliveredThreadTs(params.kind, params.session.threadTs);
		return true;
	};
	const deliverWithStreaming = async (params) => {
		if (params.payload.isReasoning === true) return;
		const reply = resolveSendableOutboundReplyParts(params.payload);
		if (streamFailed || reply.hasMedia || readSlackReplyBlocks(params.payload)?.length || !reply.hasText) {
			await deliverNormally({
				payload: params.payload,
				kind: params.kind,
				forcedThreadTs: streamSession?.threadTs
			});
			return;
		}
		const text = reply.trimmedText;
		let plannedThreadTs;
		try {
			if (!streamSession) {
				const streamThreadTs = replyPlan.nextThreadTs();
				plannedThreadTs = streamThreadTs;
				if (!streamThreadTs) {
					logVerbose("slack-stream: no reply thread target for stream start, falling back to normal delivery");
					streamFailed = true;
					await deliverNormally({
						payload: params.payload,
						kind: params.kind
					});
					return;
				}
				if (deliveryTracker.hasDelivered({
					kind: params.kind,
					payload: params.payload,
					threadTs: streamThreadTs,
					textOverride: text
				})) {
					logVerbose("slack-stream: suppressed duplicate stream start payload");
					return;
				}
				streamSession = await startSlackStream({
					client: ctx.app.client,
					channel: message.channel,
					threadTs: streamThreadTs,
					text,
					teamId: await resolveSlackStreamRecipientTeamId({
						client: ctx.app.client,
						token: ctx.botToken,
						userId: message.user,
						fallbackTeamId: ctx.teamId
					}),
					userId: message.user
				});
				if (streamSession.delivered) observedReplyDelivery = true;
				rememberDeliveredThreadTs(params.kind, streamThreadTs);
				replyPlan.markSent();
				deliveryTracker.markDelivered({
					kind: params.kind,
					payload: params.payload,
					threadTs: streamThreadTs,
					textOverride: text
				});
				return;
			}
			if (deliveryTracker.hasDelivered({
				kind: params.kind,
				payload: params.payload,
				threadTs: streamSession.threadTs,
				textOverride: text
			})) {
				logVerbose("slack-stream: suppressed duplicate append payload");
				return;
			}
			await appendSlackStream({
				session: streamSession,
				text: "\n" + text
			});
			if (streamSession.delivered) observedReplyDelivery = true;
			deliveryTracker.markDelivered({
				kind: params.kind,
				payload: params.payload,
				threadTs: streamSession.threadTs,
				textOverride: text
			});
		} catch (err) {
			if (err instanceof SlackStreamNotDeliveredError) {
				streamFailed = true;
				if (streamSession) {
					if (await deliverBufferedStreamFallback({
						session: streamSession,
						err,
						payload: params.payload,
						kind: params.kind,
						textOverride: text
					})) return;
					throw err;
				}
				await deliverNormally({
					payload: params.payload,
					kind: params.kind,
					forcedThreadTs: plannedThreadTs
				});
				return;
			}
			runtime.error?.(danger(`slack-stream: streaming API call failed: ${formatSlackError(err)}, falling back`));
			streamFailed = true;
			if (streamSession && streamSession.pendingText) {
				const bufferedFallbackErr = new SlackStreamNotDeliveredError(streamSession.pendingText, "unknown");
				if (await deliverBufferedStreamFallback({
					session: streamSession,
					err: bufferedFallbackErr,
					payload: params.payload,
					kind: params.kind,
					textOverride: text
				})) return;
			}
			await deliverNormally({
				payload: params.payload,
				kind: params.kind,
				forcedThreadTs: streamSession?.threadTs ?? plannedThreadTs
			});
		}
	};
	const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
		...replyPipeline,
		humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
		deliver: async (payload, info) => {
			if (useStreaming) {
				await deliverWithStreaming({
					payload,
					kind: info.kind
				});
				return;
			}
			const reply = resolveSendableOutboundReplyParts(payload);
			const slackBlocks = readSlackReplyBlocks(payload);
			const trimmedFinalText = reply.trimmedText;
			if ((await deliverWithFinalizableLivePreviewAdapter({
				kind: info.kind,
				payload,
				adapter: defineFinalizableLivePreviewAdapter({
					draft: draftStream ? {
						flush: draftStream.flush,
						clear: draftStream.clear,
						discardPending: draftStream.discardPending,
						seal: draftStream.seal,
						id: () => {
							const channelId = draftStream.channelId();
							const messageId = draftStream.messageId();
							return channelId && messageId ? {
								channelId,
								messageId
							} : void 0;
						}
					} : void 0,
					buildFinalEdit: () => {
						if (!previewStreamingEnabled || reply.hasMedia || payload.isError || trimmedFinalText.length === 0 && !slackBlocks?.length) return;
						return {
							text: normalizeSlackOutboundText(trimmedFinalText),
							blocks: slackBlocks,
							threadTs: usedReplyThreadTs ?? statusThreadTs
						};
					},
					editFinal: async (preview, edit) => {
						if (deliveryTracker.hasDelivered({
							kind: info.kind,
							payload,
							threadTs: edit.threadTs
						})) return;
						await finalizeSlackPreviewEdit({
							client: ctx.app.client,
							token: ctx.botToken,
							accountId: account.accountId,
							channelId: preview.channelId,
							messageId: preview.messageId,
							text: edit.text,
							...edit.blocks?.length ? { blocks: edit.blocks } : {},
							threadTs: edit.threadTs
						});
					},
					onPreviewFinalized: (_preview) => {
						const finalThreadTs = usedReplyThreadTs ?? statusThreadTs;
						observedReplyDelivery = true;
						replyPlan.markSent();
						deliveryTracker.markDelivered({
							kind: info.kind,
							payload,
							threadTs: finalThreadTs
						});
					},
					logPreviewEditFailure: (err) => {
						logVerbose(`slack: preview final edit failed; falling back to standard send (${formatSlackError(err)})`);
					}
				}),
				deliverNormally: async () => {
					await deliverNormally({
						payload,
						kind: info.kind
					});
				}
			})).kind === "preview-finalized") return;
		},
		onError: (err, info) => {
			runtime.error?.(danger(`slack ${info.kind} reply failed: ${formatSlackError(err)}`));
			replyPipeline.typingCallbacks?.onIdle?.();
		}
	});
	const draftStream = shouldUseDraftStream ? createSlackDraftStream({
		target: prepared.replyTarget,
		cfg,
		token: ctx.botToken,
		accountId: account.accountId,
		identity: slackIdentity,
		maxChars: Math.min(ctx.textLimit, SLACK_TEXT_LIMIT),
		resolveThreadTs: () => {
			const ts = replyPlan.peekThreadTs();
			if (ts) usedReplyThreadTs ??= ts;
			return ts;
		},
		log: logVerbose,
		warn: logVerbose
	}) : void 0;
	let hasStreamedMessage = false;
	const streamMode = slackStreaming.draftMode;
	const previewToolProgressEnabled = Boolean(draftStream) && resolveChannelStreamingPreviewToolProgress(account.config);
	const suppressDefaultToolProgressMessages = resolveChannelStreamingSuppressDefaultToolProgressMessages(account.config, {
		draftStreamActive: Boolean(draftStream),
		previewToolProgressEnabled,
		previewStreamingEnabled
	});
	let previewToolProgressSuppressed = false;
	let previewToolProgressLines = [];
	let appendRenderedText = "";
	let appendSourceText = "";
	let statusUpdateCount = 0;
	const progressSeed = `${account.accountId}:${message.channel}`;
	const useRichProgressDraft = streamMode === "status_final" && resolveChannelProgressDraftRender(account.config) === "rich";
	const renderProgressDraft = () => {
		if (!draftStream || streamMode !== "status_final") return;
		const previewText = formatChannelProgressDraftText({
			entry: account.config,
			lines: previewToolProgressLines,
			seed: progressSeed,
			formatLine: escapeSlackMrkdwn
		});
		if (!previewText) return;
		draftStream.update(useRichProgressDraft ? {
			text: previewText,
			blocks: buildSlackProgressDraftBlocks({
				label: resolveChannelProgressDraftLabel({
					entry: account.config,
					seed: progressSeed
				}),
				lines: previewToolProgressLines
			})
		} : previewText);
		hasStreamedMessage = true;
	};
	const progressDraftGate = createChannelProgressDraftGate({ onStart: renderProgressDraft });
	const pushPreviewToolProgress = async (line, options) => {
		if (!draftStream) return;
		if (options?.toolName !== void 0 && !isChannelProgressDraftWorkToolName(options.toolName)) return;
		const normalized = line?.text.replace(/\s+/g, " ").trim();
		if (!line || !normalized) {
			if (streamMode !== "status_final") return;
			const alreadyStarted = progressDraftGate.hasStarted;
			await progressDraftGate.noteWork();
			if (alreadyStarted && progressDraftGate.hasStarted) renderProgressDraft();
			return;
		}
		if (streamMode !== "status_final") {
			if (!previewToolProgressEnabled || previewToolProgressSuppressed) return;
			if (previewToolProgressLines.at(-1)?.text === normalized) return;
			previewToolProgressLines = [...previewToolProgressLines, line].slice(-resolveChannelProgressDraftMaxLines(account.config));
			draftStream.update(formatChannelProgressDraftText({
				entry: account.config,
				lines: previewToolProgressLines,
				seed: progressSeed,
				formatLine: escapeSlackMrkdwn
			}));
			hasStreamedMessage = true;
			return;
		}
		if (previewToolProgressEnabled && !previewToolProgressSuppressed) {
			if (previewToolProgressLines.at(-1)?.text !== normalized) previewToolProgressLines = [...previewToolProgressLines, line].slice(-resolveChannelProgressDraftMaxLines(account.config));
		}
		const alreadyStarted = progressDraftGate.hasStarted;
		await progressDraftGate.noteWork();
		if (alreadyStarted && progressDraftGate.hasStarted) renderProgressDraft();
	};
	const updateDraftFromPartial = (text) => {
		const trimmed = text?.trimEnd();
		if (!trimmed) return;
		if (streamMode === "append") {
			previewToolProgressSuppressed = true;
			previewToolProgressLines = [];
			const next = applyAppendOnlyStreamUpdate({
				incoming: trimmed,
				rendered: appendRenderedText,
				source: appendSourceText
			});
			appendRenderedText = next.rendered;
			appendSourceText = next.source;
			if (!next.changed) return;
			draftStream?.update(next.rendered);
			hasStreamedMessage = true;
			return;
		}
		if (streamMode === "status_final") {
			if (!progressDraftGate.hasStarted) return;
			statusUpdateCount += 1;
			if (statusUpdateCount > 1 && statusUpdateCount % 4 !== 0) return;
			renderProgressDraft();
			return;
		}
		previewToolProgressSuppressed = true;
		previewToolProgressLines = [];
		draftStream?.update(trimmed);
		hasStreamedMessage = true;
	};
	const onDraftBoundary = !shouldUseDraftStream ? void 0 : async () => {
		if (hasStreamedMessage) {
			draftStream?.forceNewMessage();
			hasStreamedMessage = false;
			appendRenderedText = "";
			appendSourceText = "";
			statusUpdateCount = 0;
		}
		previewToolProgressSuppressed = false;
		previewToolProgressLines = [];
	};
	let dispatchError;
	let queuedFinal = false;
	let counts = {};
	let dispatchSettledBeforeStart = false;
	try {
		const turnResult = await runInboundReplyTurn({
			channel: "slack",
			accountId: route.accountId,
			raw: prepared.message,
			adapter: {
				ingest: () => ({
					id: prepared.message.ts ?? `${prepared.ctxPayload.From}:${Date.now()}`,
					timestamp: prepared.message.ts ? Number(prepared.message.ts) * 1e3 : void 0,
					rawText: prepared.ctxPayload.RawBody ?? "",
					textForAgent: prepared.ctxPayload.BodyForAgent,
					textForCommands: prepared.ctxPayload.CommandBody,
					raw: prepared.message
				}),
				resolveTurn: () => ({
					channel: "slack",
					accountId: route.accountId,
					routeSessionKey: route.sessionKey,
					storePath: prepared.turn.storePath,
					ctxPayload: prepared.ctxPayload,
					recordInboundSession,
					record: prepared.turn.record,
					onPreDispatchFailure: async () => {
						dispatchSettledBeforeStart = true;
						await settleReplyDispatcher({
							dispatcher,
							onSettled: () => markDispatchIdle()
						});
					},
					runDispatch: () => dispatchInboundMessage({
						ctx: prepared.ctxPayload,
						cfg,
						dispatcher,
						replyOptions: {
							...replyOptions,
							skillFilter: prepared.channelConfig?.skills,
							sourceReplyDeliveryMode,
							hasRepliedRef,
							disableBlockStreaming,
							onModelSelected,
							suppressDefaultToolProgressMessages: suppressDefaultToolProgressMessages ? true : void 0,
							onPartialReply: useStreaming ? void 0 : !previewStreamingEnabled ? void 0 : async (payload) => {
								updateDraftFromPartial(payload.text);
							},
							onAssistantMessageStart: onDraftBoundary,
							onReasoningEnd: onDraftBoundary,
							onReasoningStream: statusReactionsEnabled ? async () => {
								await statusReactions.setThinking();
							} : void 0,
							onToolStart: async (payload) => {
								if (statusReactionsEnabled) await statusReactions.setTool(payload.name);
								await pushPreviewToolProgress(buildChannelProgressDraftLineForEntry(account.config, {
									event: "tool",
									name: payload.name,
									phase: payload.phase,
									args: payload.args
								}, payload.detailMode ? { detailMode: payload.detailMode } : void 0), { toolName: payload.name });
							},
							onItemEvent: async (payload) => {
								await pushPreviewToolProgress(buildChannelProgressDraftLineForEntry(account.config, {
									event: "item",
									itemKind: payload.kind,
									title: payload.title,
									name: payload.name,
									phase: payload.phase,
									status: payload.status,
									summary: payload.summary,
									progressText: payload.progressText,
									meta: payload.meta
								}));
							},
							onPlanUpdate: async (payload) => {
								if (payload.phase !== "update") return;
								await pushPreviewToolProgress(buildChannelProgressDraftLine({
									event: "plan",
									phase: payload.phase,
									title: payload.title,
									explanation: payload.explanation,
									steps: payload.steps
								}));
							},
							onApprovalEvent: async (payload) => {
								if (payload.phase !== "requested") return;
								await pushPreviewToolProgress(buildChannelProgressDraftLine({
									event: "approval",
									phase: payload.phase,
									title: payload.title,
									command: payload.command,
									reason: payload.reason,
									message: payload.message
								}));
							},
							onCommandOutput: async (payload) => {
								if (payload.phase !== "end") return;
								await pushPreviewToolProgress(buildChannelProgressDraftLine({
									event: "command-output",
									phase: payload.phase,
									title: payload.title,
									name: payload.name,
									status: payload.status,
									exitCode: payload.exitCode
								}));
							},
							onPatchSummary: async (payload) => {
								if (payload.phase !== "end") return;
								await pushPreviewToolProgress(buildChannelProgressDraftLine({
									event: "patch",
									phase: payload.phase,
									title: payload.title,
									name: payload.name,
									added: payload.added,
									modified: payload.modified,
									deleted: payload.deleted,
									summary: payload.summary
								}));
							}
						}
					})
				})
			}
		});
		if (!turnResult.dispatched) return;
		const result = turnResult.dispatchResult;
		queuedFinal = result.queuedFinal;
		counts = result.counts;
	} catch (err) {
		dispatchError = err;
	} finally {
		progressDraftGate.cancel();
		await draftStream?.discardPending();
		if (!dispatchSettledBeforeStart) markDispatchIdle();
	}
	let streamFallbackDelivered = false;
	const finalStream = streamSession;
	if (finalStream && !finalStream.stopped) try {
		await stopSlackStream({ session: finalStream });
	} catch (err) {
		if (err instanceof SlackStreamNotDeliveredError) streamFallbackDelivered = await deliverPendingStreamFallback(finalStream, err);
		else runtime.error?.(danger(`slack-stream: failed to stop stream: ${formatSlackError(err)}`));
	}
	const anyReplyDelivered = hasVisibleChannelTurnDispatch({
		queuedFinal,
		counts
	}, {
		observedReplyDelivery,
		fallbackDelivered: streamFallbackDelivered
	});
	if (statusReactionsEnabled) if (dispatchError) {
		await statusReactions.setError();
		if (ctx.removeAckAfterReply) (async () => {
			await sleep(statusReactionTiming.errorHoldMs);
			if (anyReplyDelivered) await statusReactions.clear();
		})();
	} else if (anyReplyDelivered) {
		await statusReactions.setDone();
		if (ctx.removeAckAfterReply) (async () => {
			await sleep(statusReactionTiming.doneHoldMs);
			await statusReactions.clear();
		})();
		else statusReactions.restoreInitial();
	} else await statusReactions.restoreInitial();
	if (dispatchError) throw dispatchError;
	const participationThreadTs = usedReplyThreadTs ?? statusThreadTs;
	if (anyReplyDelivered && participationThreadTs) recordSlackThreadParticipation(account.accountId, message.channel, participationThreadTs, { agentId: route.agentId });
	if (!anyReplyDelivered) {
		await draftStream?.clear();
		if (prepared.isRoomish && prepared.requireMention) clearHistoryEntriesIfEnabled({
			historyMap: ctx.channelHistories,
			historyKey: prepared.historyKey,
			limit: ctx.historyLimit
		});
		return;
	}
	if (shouldLogVerbose()) {
		const finalCount = counts.final;
		logVerbose(`slack: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${prepared.replyTarget}`);
	}
	if (!statusReactionsEnabled) removeAckReactionAfterReply({
		removeAfterReply: ctx.removeAckAfterReply && anyReplyDelivered,
		ackReactionPromise: prepared.ackReactionPromise,
		ackReactionValue: prepared.ackReactionValue,
		remove: () => removeSlackReaction(message.channel, prepared.ackReactionMessageTs ?? "", prepared.ackReactionValue, {
			token: ctx.botToken,
			client: ctx.app.client
		}),
		onError: (err) => {
			logAckFailure({
				log: logVerbose,
				channel: "slack",
				target: `${message.channel}/${message.ts}`,
				error: err
			});
		}
	});
	if (prepared.isRoomish && prepared.requireMention) clearHistoryEntriesIfEnabled({
		historyMap: ctx.channelHistories,
		historyKey: prepared.historyKey,
		limit: ctx.historyLimit
	});
}
//#endregion
export { dispatchPreparedSlackMessage, prepareSlackMessage };
