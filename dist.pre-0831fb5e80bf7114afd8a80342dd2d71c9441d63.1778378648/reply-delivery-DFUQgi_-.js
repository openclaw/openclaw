import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as sanitizeAssistantVisibleText } from "./assistant-visible-text-4F8gdkEc.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-CyLnxZJH.js";
import { t as buildOutboundSessionContext } from "./session-context-DvgNQLdE.js";
import "./text-runtime-Dm9-PE_c.js";
import { t as resolveAgentAvatar } from "./identity-avatar-B-28OKll.js";
import "./outbound-runtime-CPrFRc-_.js";
import "./agent-runtime-CLe15ipX.js";
import { d as sendDurableMessageBatch } from "./channel-message-CF65m1xH.js";
import { i as resolveTimestampMs } from "./format-CvdQKkK_.js";
import { o as sendVoiceMessageDiscord } from "./send-CtS3TABt.js";
import { t as sendMessageDiscord } from "./send.outbound-D9ig3lem.js";
import { t as resolveDiscordSenderIdentity } from "./sender-identity-Cq_sP2XQ.js";
//#region extensions/discord/src/monitor/reply-context.ts
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
		senderId: referenced.author.id,
		senderName: referenced.author.username ?? void 0,
		senderTag: sender.tag ?? void 0,
		memberRoleIds: (() => {
			const roles = referenced.member?.roles;
			return Array.isArray(roles) ? roles.map((roleId) => roleId) : void 0;
		})(),
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
//#region extensions/discord/src/monitor/reply-safety.ts
const DISCORD_INTERNAL_TRACE_LINE_RE = /^(?:>\s*)?(?:📊|🛠️|📖|📝|🔍|🔎|⚙️)\s*(?:Session Status|Exec|Read|Edit|Write|Patch|Search|Open|Click|Find|Screenshot|Update Plan|Tool Call|Tool Result|Function Call|Shell|Command)\s*:/i;
const DISCORD_INTERNAL_CHANNEL_LINE_RE = /^(?:>\s*)?(?:analysis|commentary|tool[-_ ]?call|tool[-_ ]?result|function[-_ ]?call|thinking|reasoning)\s*[:=]/i;
function hasNonEmptyRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);
}
function hasInteractiveOrPresentationBlocks(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value;
	if (typeof record.title === "string" && record.title.trim().length > 0) return true;
	return Array.isArray(record.blocks) && record.blocks.length > 0;
}
function hasNonTextReplyPayloadContent(payload) {
	return payload.audioAsVoice === true || hasNonEmptyRecord(payload.channelData) || hasInteractiveOrPresentationBlocks(payload.interactive) || hasInteractiveOrPresentationBlocks(payload.presentation);
}
function stripDiscordInternalTraceLines(text) {
	let inFence = false;
	const kept = [];
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			kept.push(line);
			continue;
		}
		if (!inFence) {
			const trimmed = line.trim();
			if (DISCORD_INTERNAL_TRACE_LINE_RE.test(trimmed) || DISCORD_INTERNAL_CHANNEL_LINE_RE.test(trimmed)) continue;
		}
		kept.push(line);
	}
	return kept.join("\n");
}
function collapseExcessBlankLines(text) {
	return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}
function sanitizeDiscordFrontChannelText(text) {
	return collapseExcessBlankLines(stripDiscordInternalTraceLines(sanitizeAssistantVisibleText(text))).trim();
}
function sanitizeDiscordFrontChannelReplyPayloads(payloads) {
	const safePayloads = [];
	for (const payload of payloads) {
		const safeText = typeof payload.text === "string" ? sanitizeDiscordFrontChannelText(payload.text) : payload.text;
		const nextPayload = safeText === payload.text ? payload : {
			...payload,
			text: safeText || void 0
		};
		if (!resolveSendableOutboundReplyParts(nextPayload).hasContent && !hasNonTextReplyPayloadContent(nextPayload)) continue;
		safePayloads.push(nextPayload);
	}
	return safePayloads;
}
//#endregion
//#region extensions/discord/src/monitor/reply-delivery.ts
function resolveTargetChannelId(target) {
	if (!target.startsWith("channel:")) return;
	return target.slice(8).trim() || void 0;
}
function resolveBoundThreadBinding(params) {
	const sessionKey = params.sessionKey?.trim();
	if (!params.threadBindings || !sessionKey) return;
	const targetChannelId = resolveTargetChannelId(params.target);
	if (!targetChannelId) return;
	return params.threadBindings.listBySessionKey(sessionKey).find((entry) => entry.threadId === targetChannelId);
}
function resolveBindingIdentity(cfg, binding) {
	if (!binding) return;
	const identity = { name: (`🤖 ${binding.label?.trim() || binding.agentId}`.trim() || "🤖 agent").slice(0, 80) };
	try {
		const avatar = resolveAgentAvatar(cfg, binding.agentId);
		if (avatar.kind === "remote") identity.avatarUrl = avatar.url;
	} catch {}
	return identity;
}
function createDiscordDeliveryDeps(params) {
	return {
		discord: (to, text, opts) => sendMessageDiscord(to, text, {
			...opts,
			cfg: opts?.cfg ?? params.cfg,
			token: params.token,
			rest: params.rest
		}),
		discordVoice: (to, audioPath, opts) => sendVoiceMessageDiscord(to, audioPath, {
			...opts,
			cfg: opts?.cfg ?? params.cfg,
			token: params.token,
			rest: params.rest
		})
	};
}
function resolveDiscordDeliveryOptions(params) {
	const binding = resolveBoundThreadBinding({
		threadBindings: params.threadBindings,
		sessionKey: params.sessionKey,
		target: params.target
	});
	return {
		to: binding ? `channel:${binding.channelId}` : params.target,
		threadId: binding?.threadId,
		agentId: binding?.agentId,
		identity: resolveBindingIdentity(params.cfg, binding),
		mediaAccess: params.mediaLocalRoots?.length ? { localRoots: params.mediaLocalRoots } : void 0,
		replyToMode: params.replyToMode ?? "all",
		formatting: {
			textLimit: params.textLimit,
			maxLinesPerMessage: params.maxLinesPerMessage,
			tableMode: params.tableMode,
			chunkMode: params.chunkMode
		}
	};
}
async function deliverDiscordReply(params) {
	params.runtime;
	const delivery = resolveDiscordDeliveryOptions(params);
	const payloads = sanitizeDiscordFrontChannelReplyPayloads(params.replies);
	if (payloads.length === 0) return;
	const send = await sendDurableMessageBatch({
		cfg: params.cfg,
		channel: "discord",
		to: delivery.to,
		accountId: params.accountId,
		payloads,
		replyToId: normalizeOptionalString(params.replyToId),
		replyToMode: delivery.replyToMode,
		formatting: delivery.formatting,
		threadId: delivery.threadId,
		identity: delivery.identity,
		deps: createDiscordDeliveryDeps({
			cfg: params.cfg,
			token: params.token,
			rest: params.rest
		}),
		mediaAccess: delivery.mediaAccess,
		session: buildOutboundSessionContext({
			cfg: params.cfg,
			sessionKey: params.sessionKey,
			agentId: delivery.agentId,
			requesterAccountId: params.accountId
		})
	});
	if (send.status === "failed" || send.status === "partial_failed") throw send.error;
	if ((send.status === "sent" ? send.results : []).length === 0) throw new Error(`discord final reply produced no delivered message for ${delivery.to}`);
}
//#endregion
export { resolveReplyContext as i, buildDirectLabel as n, buildGuildLabel as r, deliverDiscordReply as t };
