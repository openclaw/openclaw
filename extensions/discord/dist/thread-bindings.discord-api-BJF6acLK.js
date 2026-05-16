import { s as resolveDiscordChannelId } from "./normalize-B-ktw-T_.js";
import { at as getChannel, q as createChannelWebhook } from "./discord-eZlimVfW.js";
import { N as createDiscordRestClient } from "./send.shared-e9Pd_Em0.js";
import { c as sendWebhookMessageDiscord, u as createThreadDiscord } from "./send-Dw6Da1m2.js";
import { t as sendMessageDiscord } from "./send.outbound-6KbINW5h.js";
import { i as REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL, k as toReusableWebhookKey, m as rememberReusableWebhook, t as BINDINGS_BY_THREAD_ID } from "./thread-bindings.state-Dzu1gCE7.js";
import { n as resolveDiscordChannelInfoSafe, t as resolveDiscordChannelIdSafe } from "./channel-access-ewDxhd9q.js";
import { SYSTEM_MARK, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { ChannelType } from "discord-api-types/v10";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatThreadBindingDurationLabel, resolveThreadBindingFarewellText, resolveThreadBindingIntroText, resolveThreadBindingThreadName } from "openclaw/plugin-sdk/conversation-runtime";
//#region extensions/discord/src/monitor/thread-bindings.persona.ts
const THREAD_BINDING_PERSONA_MAX_CHARS = 80;
function normalizePersonaLabel(value) {
	if (!value) return;
	return value.replace(/\s+/g, " ").trim() || void 0;
}
function resolveThreadBindingPersona(params) {
	return `${SYSTEM_MARK} ${normalizePersonaLabel(params.label) || normalizePersonaLabel(params.agentId) || "agent"}`.slice(0, THREAD_BINDING_PERSONA_MAX_CHARS);
}
function resolveThreadBindingPersonaFromRecord(record) {
	return resolveThreadBindingPersona({
		label: record.label,
		agentId: record.agentId
	});
}
//#endregion
//#region extensions/discord/src/monitor/thread-bindings.discord-api.ts
function buildThreadTarget(threadId) {
	return /^(channel:|user:)/i.test(threadId) ? threadId : `channel:${threadId}`;
}
function isThreadArchived(raw) {
	if (!raw || typeof raw !== "object") return false;
	const asRecord = raw;
	if (asRecord.archived === true) return true;
	if (asRecord.thread_metadata?.archived === true) return true;
	if (asRecord.threadMetadata?.archived === true) return true;
	return false;
}
function isThreadChannelType(type) {
	return type === ChannelType.PublicThread || type === ChannelType.PrivateThread || type === ChannelType.AnnouncementThread;
}
function normalizeDiscordBindingChannelId(raw) {
	const trimmed = normalizeOptionalString(raw) ?? "";
	if (!trimmed) return null;
	try {
		return resolveDiscordChannelId(trimmed);
	} catch {
		return null;
	}
}
function summarizeDiscordError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint" || typeof err === "symbol") return String(err);
	return "error";
}
function extractNumericDiscordErrorValue(value) {
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
}
function extractDiscordErrorStatus(err) {
	if (!err || typeof err !== "object") return;
	const candidate = err;
	return extractNumericDiscordErrorValue(candidate.status) ?? extractNumericDiscordErrorValue(candidate.statusCode) ?? extractNumericDiscordErrorValue(candidate.response?.status);
}
function extractDiscordErrorCode(err) {
	if (!err || typeof err !== "object") return;
	const candidate = err;
	return extractNumericDiscordErrorValue(candidate.code) ?? extractNumericDiscordErrorValue(candidate.rawError?.code) ?? extractNumericDiscordErrorValue(candidate.body?.code) ?? extractNumericDiscordErrorValue(candidate.response?.body?.code) ?? extractNumericDiscordErrorValue(candidate.response?.data?.code);
}
function isDiscordThreadGoneError(err) {
	if (extractDiscordErrorCode(err) === 10003) return true;
	const status = extractDiscordErrorStatus(err);
	return status === 404 || status === 403;
}
async function maybeSendBindingMessage(params) {
	const text = params.text.trim();
	if (!text) return;
	const record = params.record;
	if (params.preferWebhook !== false && record.webhookId && record.webhookToken) try {
		await sendWebhookMessageDiscord(text, {
			cfg: params.cfg,
			webhookId: record.webhookId,
			webhookToken: record.webhookToken,
			accountId: record.accountId,
			threadId: record.threadId,
			username: resolveThreadBindingPersonaFromRecord(record)
		});
		return;
	} catch (err) {
		logVerbose(`discord thread binding webhook send failed: ${summarizeDiscordError(err)}`);
	}
	try {
		await sendMessageDiscord(buildThreadTarget(record.threadId), text, {
			cfg: params.cfg,
			accountId: record.accountId
		});
	} catch (err) {
		logVerbose(`discord thread binding fallback send failed: ${summarizeDiscordError(err)}`);
	}
}
async function createWebhookForChannel(params) {
	try {
		const rest = createDiscordRestClient({
			cfg: params.cfg,
			accountId: params.accountId,
			token: params.token
		}).rest;
		const created = await createChannelWebhook(rest, params.channelId, { body: { name: "OpenClaw Agents" } });
		const webhookId = normalizeOptionalString(created?.id) ?? "";
		const webhookToken = normalizeOptionalString(created?.token) ?? "";
		if (!webhookId || !webhookToken) return {};
		return {
			webhookId,
			webhookToken
		};
	} catch (err) {
		logVerbose(`discord thread binding webhook create failed for ${params.channelId}: ${summarizeDiscordError(err)}`);
		return {};
	}
}
function findReusableWebhook(params) {
	const reusableKey = toReusableWebhookKey({
		accountId: params.accountId,
		channelId: params.channelId
	});
	const cached = REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL.get(reusableKey);
	if (cached) return {
		webhookId: cached.webhookId,
		webhookToken: cached.webhookToken
	};
	for (const record of BINDINGS_BY_THREAD_ID.values()) {
		if (record.accountId !== params.accountId) continue;
		if (record.channelId !== params.channelId) continue;
		if (!record.webhookId || !record.webhookToken) continue;
		rememberReusableWebhook(record);
		return {
			webhookId: record.webhookId,
			webhookToken: record.webhookToken
		};
	}
	return {};
}
async function resolveChannelIdForBinding(params) {
	const explicit = normalizeDiscordBindingChannelId(params.channelId);
	if (explicit) return explicit;
	const lookupThreadId = normalizeDiscordBindingChannelId(params.threadId);
	if (!lookupThreadId) return null;
	try {
		const rest = createDiscordRestClient({
			cfg: params.cfg,
			accountId: params.accountId,
			token: params.token
		}).rest;
		const channel = await getChannel(rest, lookupThreadId);
		const channelInfo = resolveDiscordChannelInfoSafe(channel);
		const channelId = normalizeOptionalString(resolveDiscordChannelIdSafe(channel)) ?? "";
		const type = channelInfo.type;
		const parentId = normalizeOptionalString(channelInfo.parentId) ?? "";
		if (parentId && isThreadChannelType(type)) return parentId;
		return channelId || null;
	} catch (err) {
		logVerbose(`discord thread binding channel resolve failed for ${lookupThreadId}: ${summarizeDiscordError(err)}`);
		return null;
	}
}
async function createThreadForBinding(params) {
	try {
		return (normalizeOptionalString((await createThreadDiscord(params.channelId, {
			name: params.threadName,
			autoArchiveMinutes: 60
		}, {
			cfg: params.cfg,
			accountId: params.accountId,
			token: params.token
		}))?.id) ?? "") || null;
	} catch (err) {
		logVerbose(`discord thread binding auto-thread create failed for ${params.channelId}: ${summarizeDiscordError(err)}`);
		return null;
	}
}
//#endregion
export { isThreadArchived as a, summarizeDiscordError as c, formatThreadBindingDurationLabel as d, resolveThreadBindingFarewellText as f, isDiscordThreadGoneError as i, resolveThreadBindingPersona as l, resolveThreadBindingThreadName as m, createWebhookForChannel as n, maybeSendBindingMessage as o, resolveThreadBindingIntroText as p, findReusableWebhook as r, resolveChannelIdForBinding as s, createThreadForBinding as t, resolveThreadBindingPersonaFromRecord as u };
