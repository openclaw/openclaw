import { p as resolveSessionAgentId, x as resolveAgentWorkspaceDir } from "./agent-scope-CcybJBoN.js";
import { r as writeRuntimeJson } from "./runtime-bzt9CHmD.js";
import { r as isInternalMessageChannel } from "./message-channel-qkYXfTa4.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-vjc31mTI.js";
import "./plugins-B_QXrzEj.js";
import { n as isNestedAgentLane } from "./lanes-tlr9rGev.js";
import { i as normalizeOutboundPayloadsForJson, l as projectOutboundPayloadPlanForOutbound, n as createOutboundPayloadPlan, r as formatOutboundPayloadLog, s as projectOutboundPayloadPlanForJson, t as deliverOutboundPayloads } from "./deliver-Bvip2m0C.js";
import { n as resolveMessageChannelSelection } from "./channel-selection-Cci13-DO.js";
import { t as normalizeReplyPayload } from "./normalize-reply-Bk_cykA3.js";
import { n as createReplyMediaPathNormalizer } from "./reply-media-paths.runtime-s8tylZiq.js";
import { t as createReplyPrefixContext } from "./reply-prefix-Cp2pWUcj.js";
import { t as createOutboundSendDeps } from "./outbound-send-deps-D2hM_cE9.js";
import { n as resolveAgentOutboundTarget, t as resolveAgentDeliveryPlan } from "./agent-delivery-heMrOykm.js";
//#region src/infra/outbound/envelope.ts
const isOutboundPayloadJson = (payload) => "mediaUrl" in payload;
function buildOutboundResultEnvelope(params) {
	const hasPayloads = params.payloads !== void 0;
	const payloads = params.payloads === void 0 ? void 0 : params.payloads.length === 0 ? [] : isOutboundPayloadJson(params.payloads[0]) ? [...params.payloads] : normalizeOutboundPayloadsForJson(params.payloads);
	if (params.flattenDelivery !== false && params.delivery && !params.meta && !hasPayloads) return params.delivery;
	return {
		...hasPayloads ? { payloads } : {},
		...params.meta ? { meta: params.meta } : {},
		...params.delivery ? { delivery: params.delivery } : {}
	};
}
//#endregion
//#region src/agents/command/delivery.ts
const NESTED_LOG_PREFIX = "[agent:nested]";
function formatNestedLogPrefix(opts, sessionKey) {
	const parts = [NESTED_LOG_PREFIX];
	const session = sessionKey ?? opts.sessionKey ?? opts.sessionId;
	if (session) parts.push(`session=${session}`);
	if (opts.runId) parts.push(`run=${opts.runId}`);
	const channel = opts.messageChannel ?? opts.channel;
	if (channel) parts.push(`channel=${channel}`);
	if (opts.to) parts.push(`to=${opts.to}`);
	if (opts.accountId) parts.push(`account=${opts.accountId}`);
	return parts.join(" ");
}
function logNestedOutput(runtime, opts, output, sessionKey) {
	const prefix = formatNestedLogPrefix(opts, sessionKey);
	for (const line of output.split(/\r?\n/)) {
		if (!line) continue;
		runtime.log(`${prefix} ${line}`);
	}
}
function mergeResultMetaOverrides(meta, overrides) {
	if (!overrides) return meta;
	return {
		...meta,
		...overrides
	};
}
async function normalizeReplyMediaPathsForDelivery(params) {
	if (params.payloads.length === 0) return params.payloads;
	const agentId = params.outboundSession?.agentId ?? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	});
	const workspaceDir = agentId ? resolveAgentWorkspaceDir(params.cfg, agentId) : void 0;
	if (!workspaceDir) return params.payloads;
	const normalizeMediaPaths = createReplyMediaPathNormalizer({
		cfg: params.cfg,
		sessionKey: params.sessionKey,
		agentId,
		workspaceDir,
		messageProvider: params.deliveryChannel,
		accountId: params.accountId
	});
	const result = [];
	for (const payload of params.payloads) result.push(await normalizeMediaPaths(payload));
	return result;
}
function normalizeAgentCommandReplyPayloads(params) {
	const payloads = params.payloads ?? [];
	if (payloads.length === 0) return [];
	const channel = params.deliveryChannel && !isInternalMessageChannel(params.deliveryChannel) ? normalizeChannelId(params.deliveryChannel) ?? params.deliveryChannel : void 0;
	if (!channel) return payloads;
	const applyChannelTransforms = params.applyChannelTransforms ?? true;
	const deliveryPlugin = applyChannelTransforms ? getChannelPlugin(channel) : void 0;
	const sessionKey = params.outboundSession?.key ?? params.opts.sessionKey;
	const agentId = params.outboundSession?.agentId ?? resolveSessionAgentId({
		sessionKey,
		config: params.cfg
	});
	const replyPrefix = createReplyPrefixContext({
		cfg: params.cfg,
		agentId,
		channel,
		accountId: params.accountId
	});
	const modelUsed = params.result.meta.agentMeta?.model;
	const providerUsed = params.result.meta.agentMeta?.provider;
	if (providerUsed && modelUsed) replyPrefix.onModelSelected({
		provider: providerUsed,
		model: modelUsed,
		thinkLevel: void 0
	});
	const responsePrefixContext = replyPrefix.responsePrefixContextProvider();
	const transformReplyPayload = deliveryPlugin?.messaging?.transformReplyPayload ? (payload) => deliveryPlugin.messaging?.transformReplyPayload?.({
		payload,
		cfg: params.cfg,
		accountId: params.accountId
	}) ?? payload : void 0;
	const normalizedPayloads = [];
	for (const payload of payloads) {
		const normalized = normalizeReplyPayload(payload, {
			responsePrefix: replyPrefix.responsePrefix,
			applyChannelTransforms,
			responsePrefixContext,
			transformReplyPayload
		});
		if (normalized) normalizedPayloads.push(normalized);
	}
	return normalizedPayloads;
}
async function deliverAgentCommandResult(params) {
	const { cfg, deps, runtime, opts, outboundSession, sessionEntry, payloads, result } = params;
	const effectiveSessionKey = outboundSession?.key ?? opts.sessionKey;
	const deliver = opts.deliver === true;
	const bestEffortDeliver = opts.bestEffortDeliver === true;
	const turnSourceChannel = opts.runContext?.messageChannel ?? opts.messageChannel;
	const turnSourceTo = opts.runContext?.currentChannelId ?? opts.to;
	const turnSourceAccountId = opts.runContext?.accountId ?? opts.accountId;
	const turnSourceThreadId = opts.runContext?.currentThreadTs ?? opts.threadId;
	const deliveryPlan = resolveAgentDeliveryPlan({
		sessionEntry,
		requestedChannel: opts.replyChannel ?? opts.channel,
		explicitTo: opts.replyTo ?? opts.to,
		explicitThreadId: opts.threadId,
		accountId: opts.replyAccountId ?? opts.accountId,
		wantsDelivery: deliver,
		turnSourceChannel,
		turnSourceTo,
		turnSourceAccountId,
		turnSourceThreadId
	});
	let deliveryChannel = deliveryPlan.resolvedChannel;
	const explicitChannelHint = (opts.replyChannel ?? opts.channel)?.trim();
	if (deliver && isInternalMessageChannel(deliveryChannel) && !explicitChannelHint) try {
		deliveryChannel = (await resolveMessageChannelSelection({ cfg })).channel;
	} catch {}
	const effectiveDeliveryPlan = deliveryChannel === deliveryPlan.resolvedChannel ? deliveryPlan : {
		...deliveryPlan,
		resolvedChannel: deliveryChannel
	};
	const deliveryPlugin = deliver && !isInternalMessageChannel(deliveryChannel) ? getChannelPlugin(normalizeChannelId(deliveryChannel) ?? deliveryChannel) : void 0;
	const isDeliveryChannelKnown = isInternalMessageChannel(deliveryChannel) || Boolean(deliveryPlugin);
	const targetMode = opts.deliveryTargetMode ?? effectiveDeliveryPlan.deliveryTargetMode ?? (opts.to ? "explicit" : "implicit");
	const resolvedAccountId = effectiveDeliveryPlan.resolvedAccountId;
	const resolved = deliver && isDeliveryChannelKnown && deliveryChannel ? resolveAgentOutboundTarget({
		cfg,
		plan: effectiveDeliveryPlan,
		targetMode,
		validateExplicitTarget: true
	}) : {
		resolvedTarget: null,
		resolvedTo: effectiveDeliveryPlan.resolvedTo,
		targetMode
	};
	const resolvedTarget = resolved.resolvedTarget;
	const deliveryTarget = resolved.resolvedTo;
	const resolvedThreadId = deliveryPlan.resolvedThreadId ?? opts.threadId;
	const replyTransport = deliveryPlugin?.threading?.resolveReplyTransport?.({
		cfg,
		accountId: resolvedAccountId,
		threadId: resolvedThreadId
	}) ?? null;
	const resolvedReplyToId = replyTransport?.replyToId ?? void 0;
	const resolvedThreadTarget = replyTransport && Object.hasOwn(replyTransport, "threadId") ? replyTransport.threadId ?? null : resolvedThreadId ?? null;
	const logDeliveryError = (err) => {
		const message = `Delivery failed (${deliveryChannel}${deliveryTarget ? ` to ${deliveryTarget}` : ""}): ${String(err)}`;
		runtime.error?.(message);
		if (!runtime.error) runtime.log(message);
	};
	if (deliver) {
		if (isInternalMessageChannel(deliveryChannel)) {
			const err = /* @__PURE__ */ new Error("delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel");
			if (!bestEffortDeliver) throw err;
			logDeliveryError(err);
		} else if (!isDeliveryChannelKnown) {
			const err = /* @__PURE__ */ new Error(`Unknown channel: ${deliveryChannel}`);
			if (!bestEffortDeliver) throw err;
			logDeliveryError(err);
		} else if (resolvedTarget && !resolvedTarget.ok) {
			if (!bestEffortDeliver) throw resolvedTarget.error;
			logDeliveryError(resolvedTarget.error);
		}
	}
	const normalizedReplyPayloads = normalizeAgentCommandReplyPayloads({
		cfg,
		opts,
		outboundSession,
		payloads,
		result,
		deliveryChannel,
		accountId: resolvedAccountId,
		applyChannelTransforms: deliver
	});
	const outboundPayloadPlan = createOutboundPayloadPlan(deliver && !isInternalMessageChannel(deliveryChannel) ? await normalizeReplyMediaPathsForDelivery({
		cfg,
		payloads: normalizedReplyPayloads,
		sessionKey: effectiveSessionKey,
		outboundSession,
		deliveryChannel,
		accountId: resolvedAccountId
	}) : normalizedReplyPayloads);
	const normalizedPayloads = projectOutboundPayloadPlanForJson(outboundPayloadPlan);
	const resultMeta = mergeResultMetaOverrides(result.meta, opts.resultMetaOverrides);
	if (opts.json) {
		writeRuntimeJson(runtime, buildOutboundResultEnvelope({
			payloads: normalizedPayloads,
			meta: resultMeta
		}));
		if (!deliver) return {
			payloads: normalizedPayloads,
			meta: resultMeta
		};
	}
	if (!payloads || payloads.length === 0) return {
		payloads: [],
		meta: resultMeta
	};
	const deliveryPayloads = projectOutboundPayloadPlanForOutbound(outboundPayloadPlan);
	let deliverySucceeded = false;
	let deliveryHadError = false;
	const logPayload = (payload) => {
		if (opts.json) return;
		const output = formatOutboundPayloadLog(payload);
		if (!output) return;
		if (isNestedAgentLane(opts.lane)) {
			logNestedOutput(runtime, opts, output, effectiveSessionKey);
			return;
		}
		runtime.log(output);
	};
	const markDeliveryError = (err) => {
		deliveryHadError = true;
		logDeliveryError(err);
	};
	if (!deliver) for (const payload of deliveryPayloads) logPayload(payload);
	if (deliver && deliveryChannel && !isInternalMessageChannel(deliveryChannel)) {
		if (deliveryTarget) deliverySucceeded = (await deliverOutboundPayloads({
			cfg,
			channel: deliveryChannel,
			to: deliveryTarget,
			accountId: resolvedAccountId,
			payloads: deliveryPayloads,
			session: outboundSession,
			replyToId: resolvedReplyToId ?? null,
			threadId: resolvedThreadTarget ?? null,
			bestEffort: bestEffortDeliver,
			onError: markDeliveryError,
			onPayload: logPayload,
			deps: createOutboundSendDeps(deps)
		})).length > 0 && !deliveryHadError;
	}
	return {
		payloads: normalizedPayloads,
		meta: resultMeta,
		deliverySucceeded
	};
}
//#endregion
export { deliverAgentCommandResult };
