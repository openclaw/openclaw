import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import "./message-channel-CYCKkVrh.js";
import { a as projectOutboundPayloadPlanForDelivery, s as projectOutboundPayloadPlanForMirror, t as createOutboundPayloadPlan } from "./payloads-BOM5t2O4.js";
import { t as buildOutboundSessionContext } from "./session-context-DSIPIqLK.js";
import { t as deriveDurableFinalDeliveryRequirements } from "./capabilities-B3ut6ovI.js";
import { r as resolveOutboundDurableFinalDeliverySupport } from "./deliver-WPtVqUMT.js";
import { r as resolveOutboundChannelPlugin } from "./channel-resolution-Ecs0HEdK.js";
import { t as sendDurableMessageBatch } from "./send-CGvo7HYh.js";
import "./runtime-BN74dT7u.js";
import { n as normalizePollInput } from "./polls-C-v11_tu.js";
import { n as resolveMessageChannelSelection } from "./channel-selection-DQG3SYlu.js";
import { r as resolveOutboundTarget } from "./targets-CNDTJ9IB.js";
//#region src/infra/outbound/message.ts
let messageConfigRuntimePromise = null;
let messageGatewayRuntimePromise = null;
function loadMessageConfigRuntime() {
	messageConfigRuntimePromise ??= import("./message.config.runtime.js");
	return messageConfigRuntimePromise;
}
function loadMessageGatewayRuntime() {
	messageGatewayRuntimePromise ??= import("./message.gateway.runtime.js");
	return messageGatewayRuntimePromise;
}
function buildMessagePollResult(params) {
	return {
		channel: params.channel,
		to: params.to,
		question: params.normalized.question,
		options: params.normalized.options,
		maxSelections: params.normalized.maxSelections,
		durationSeconds: params.normalized.durationSeconds ?? null,
		durationHours: params.normalized.durationHours ?? null,
		via: "gateway",
		...params.dryRun ? { dryRun: true } : { result: params.result }
	};
}
async function resolveRequiredChannel(params) {
	return (await resolveMessageChannelSelection({
		cfg: params.cfg,
		channel: params.channel
	})).channel;
}
function resolveRequiredPlugin(channel, cfg) {
	const plugin = resolveOutboundChannelPlugin({
		channel,
		cfg
	});
	if (!plugin) throw new Error(`Unknown channel: ${channel}`);
	return plugin;
}
function payloadRequiresDurablePayloadTransport(payload) {
	return payload.presentation !== void 0 || payload.delivery !== void 0 || payload.interactive !== void 0 || payload.channelData !== void 0 && Object.keys(payload.channelData).length > 0;
}
function mergeDurableRequirements(target, source) {
	for (const [capability, required] of Object.entries(source)) if (required === true) target[capability] = true;
	return target;
}
function deriveRequiredMessageSendCapabilities(params) {
	const requirements = { reconcileUnknownSend: true };
	for (const payload of params.payloads) mergeDurableRequirements(requirements, deriveDurableFinalDeliveryRequirements({
		payload,
		replyToId: params.replyToId,
		threadId: params.threadId,
		silent: params.silent,
		payloadTransport: payloadRequiresDurablePayloadTransport(payload),
		batch: params.payloads.length > 1,
		reconcileUnknownSend: true
	}));
	return requirements;
}
async function assertRequiredMessageSendDurability(params) {
	const support = await resolveOutboundDurableFinalDeliverySupport({
		cfg: params.cfg,
		channel: params.channel,
		requirements: deriveRequiredMessageSendCapabilities(params)
	});
	if (support.ok) return;
	const suffix = support.reason === "capability_mismatch" && support.capability ? `missing ${support.capability}` : support.reason;
	throw new Error(`Required durable message send is unsupported for ${params.channel}: ${suffix}`);
}
function resolveGatewayOptions(opts) {
	return {
		url: opts?.mode === GATEWAY_CLIENT_MODES.BACKEND || opts?.clientName === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT ? void 0 : opts?.url,
		token: opts?.token,
		timeoutMs: typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 1e4,
		clientName: opts?.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
		clientDisplayName: opts?.clientDisplayName,
		mode: opts?.mode ?? GATEWAY_CLIENT_MODES.CLI
	};
}
async function callMessageGateway(params) {
	const { callGatewayLeastPrivilege } = await loadMessageGatewayRuntime();
	const gateway = resolveGatewayOptions(params.gateway);
	return await callGatewayLeastPrivilege({
		url: gateway.url,
		token: gateway.token,
		method: params.method,
		params: params.params,
		timeoutMs: gateway.timeoutMs,
		clientName: gateway.clientName,
		clientDisplayName: gateway.clientDisplayName,
		mode: gateway.mode
	});
}
async function resolveMessageConfig(cfg) {
	if (cfg) return cfg;
	const { getRuntimeConfig } = await loadMessageConfigRuntime();
	return getRuntimeConfig();
}
async function resolveGatewayIdempotencyKey(idempotencyKey) {
	if (idempotencyKey) return idempotencyKey;
	const { randomIdempotencyKey } = await loadMessageGatewayRuntime();
	return randomIdempotencyKey();
}
async function sendMessage(params) {
	const cfg = await resolveMessageConfig(params.cfg);
	const channel = await resolveRequiredChannel({
		cfg,
		channel: params.channel
	});
	const deliveryMode = resolveRequiredPlugin(channel, cfg).outbound?.deliveryMode ?? "direct";
	const outboundPlan = createOutboundPayloadPlan(params.payloads && params.payloads.length > 0 ? params.payloads : [{
		text: params.content,
		mediaUrl: params.mediaUrl,
		mediaUrls: params.mediaUrls,
		audioAsVoice: params.asVoice === true
	}]);
	const normalizedPayloads = projectOutboundPayloadPlanForDelivery(outboundPlan);
	const mirrorProjection = projectOutboundPayloadPlanForMirror(outboundPlan);
	const mirrorText = mirrorProjection.text;
	const mirrorMediaUrls = mirrorProjection.mediaUrls;
	const primaryMediaUrl = mirrorMediaUrls[0] ?? params.mediaUrl ?? null;
	if (params.dryRun) return {
		channel,
		to: params.to,
		via: deliveryMode === "gateway" ? "gateway" : "direct",
		mediaUrl: primaryMediaUrl,
		mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : void 0,
		dryRun: true
	};
	if (deliveryMode !== "gateway") {
		const outboundChannel = channel;
		const resolvedTarget = resolveOutboundTarget({
			channel: outboundChannel,
			to: params.to,
			cfg,
			accountId: params.accountId,
			mode: "explicit"
		});
		if (!resolvedTarget.ok) throw resolvedTarget.error;
		const outboundSession = buildOutboundSessionContext({
			cfg,
			agentId: params.agentId,
			sessionKey: params.requesterSessionKey ?? params.mirror?.sessionKey,
			requesterAccountId: params.requesterAccountId ?? params.accountId,
			requesterSenderId: params.requesterSenderId,
			requesterSenderName: params.requesterSenderName,
			requesterSenderUsername: params.requesterSenderUsername,
			requesterSenderE164: params.requesterSenderE164
		});
		if (params.queuePolicy === "required") await assertRequiredMessageSendDurability({
			cfg,
			channel: outboundChannel,
			payloads: normalizedPayloads,
			replyToId: params.replyToId,
			threadId: params.threadId,
			silent: params.silent
		});
		const send = await sendDurableMessageBatch({
			cfg,
			channel: outboundChannel,
			to: resolvedTarget.to,
			session: outboundSession,
			accountId: params.accountId,
			payloads: normalizedPayloads,
			replyToId: params.replyToId,
			threadId: params.threadId,
			gifPlayback: params.gifPlayback,
			forceDocument: params.forceDocument,
			deps: params.deps,
			bestEffort: params.bestEffort,
			durability: params.bestEffort || params.queuePolicy === "best_effort" ? "best_effort" : "required",
			signal: params.abortSignal,
			silent: params.silent,
			mediaAccess: params.mediaAccess,
			formatting: params.parseMode ? { parseMode: params.parseMode } : void 0,
			mirror: params.mirror ? {
				...params.mirror,
				text: mirrorText || params.content,
				mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : void 0,
				idempotencyKey: params.mirror.idempotencyKey ?? params.idempotencyKey
			} : void 0
		});
		if (!params.bestEffort && (send.status === "failed" || send.status === "partial_failed")) throw send.error;
		const results = send.status === "sent" || send.status === "partial_failed" ? send.results : [];
		return {
			channel,
			to: params.to,
			via: "direct",
			mediaUrl: primaryMediaUrl,
			mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : void 0,
			result: results.at(-1)
		};
	}
	const result = await callMessageGateway({
		gateway: params.gateway,
		method: "send",
		params: {
			to: params.to,
			message: params.content,
			mediaUrl: params.mediaUrl,
			mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : params.mediaUrls,
			asVoice: params.asVoice,
			gifPlayback: params.gifPlayback,
			accountId: params.accountId,
			agentId: params.agentId,
			channel,
			replyToId: params.replyToId,
			threadId: params.threadId != null ? String(params.threadId) : void 0,
			forceDocument: params.forceDocument,
			silent: params.silent,
			parseMode: params.parseMode,
			sessionKey: params.mirror?.sessionKey,
			idempotencyKey: await resolveGatewayIdempotencyKey(params.idempotencyKey)
		}
	});
	return {
		channel,
		to: params.to,
		via: "gateway",
		mediaUrl: primaryMediaUrl,
		mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : void 0,
		result
	};
}
async function sendPoll(params) {
	const cfg = await resolveMessageConfig(params.cfg);
	const channel = await resolveRequiredChannel({
		cfg,
		channel: params.channel
	});
	const pollInput = {
		question: params.question,
		options: params.options,
		maxSelections: params.maxSelections,
		durationSeconds: params.durationSeconds,
		durationHours: params.durationHours
	};
	const outbound = resolveRequiredPlugin(channel, cfg)?.outbound;
	if (!outbound?.sendPoll) throw new Error(`Unsupported poll channel: ${channel}`);
	const normalized = outbound.pollMaxOptions ? normalizePollInput(pollInput, { maxOptions: outbound.pollMaxOptions }) : normalizePollInput(pollInput);
	if (params.dryRun) return buildMessagePollResult({
		channel,
		to: params.to,
		normalized,
		dryRun: true
	});
	const result = await callMessageGateway({
		gateway: params.gateway,
		method: "poll",
		params: {
			to: params.to,
			question: normalized.question,
			options: normalized.options,
			maxSelections: normalized.maxSelections,
			durationSeconds: normalized.durationSeconds,
			durationHours: normalized.durationHours,
			threadId: params.threadId,
			silent: params.silent,
			isAnonymous: params.isAnonymous,
			channel,
			accountId: params.accountId,
			idempotencyKey: await resolveGatewayIdempotencyKey(params.idempotencyKey)
		}
	});
	return buildMessagePollResult({
		channel,
		to: params.to,
		normalized,
		result
	});
}
//#endregion
export { sendPoll as n, sendMessage as t };
