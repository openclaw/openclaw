import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { r as isInternalMessageChannel } from "./message-channel-CYCKkVrh.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { c as projectOutboundPayloadPlanForOutbound, n as formatOutboundPayloadLog, o as projectOutboundPayloadPlanForJson, r as normalizeOutboundPayloadsForJson, t as createOutboundPayloadPlan } from "./payloads-BOM5t2O4.js";
import { t as normalizeReplyPayload } from "./normalize-reply-yKKEXSMw.js";
import { t as sendDurableMessageBatch } from "./send-CGvo7HYh.js";
import "./runtime-BN74dT7u.js";
import { n as resolveMessageChannelSelection } from "./channel-selection-DQG3SYlu.js";
import { n as isNestedAgentLane } from "./lanes-ReZ09_e4.js";
import { n as createReplyMediaPathNormalizer } from "./reply-media-paths.runtime-DYciI0K5.js";
import { t as createReplyPrefixContext } from "./reply-prefix-D0w1Q_CL.js";
import { t as createOutboundSendDeps } from "./outbound-send-deps-fPP8XU6h.js";
import { n as resolveAgentOutboundTarget, t as resolveAgentDeliveryPlan } from "./agent-delivery-BF85uL-M.js";
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
function normalizeDeliverySessionId(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function isFreshDeliverySessionMatch(freshSessionEntry, expectedSessionId) {
	const normalizedExpected = normalizeDeliverySessionId(expectedSessionId);
	return Boolean(normalizedExpected && freshSessionEntry.sessionId === normalizedExpected);
}
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
function hasNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function hasNonEmptyStringArray(value) {
	return Array.isArray(value) && value.some(hasNonEmptyString);
}
function hasNonEmptyArray(value) {
	return Array.isArray(value) && value.length > 0;
}
function buildDeliveryResult(params) {
	return {
		payloads: params.payloads,
		meta: params.meta,
		...params.result.didSendViaMessagingTool === true ? { didSendViaMessagingTool: true } : {},
		...hasNonEmptyStringArray(params.result.messagingToolSentTexts) ? { messagingToolSentTexts: params.result.messagingToolSentTexts } : {},
		...hasNonEmptyStringArray(params.result.messagingToolSentMediaUrls) ? { messagingToolSentMediaUrls: params.result.messagingToolSentMediaUrls } : {},
		...hasNonEmptyArray(params.result.messagingToolSentTargets) ? { messagingToolSentTargets: params.result.messagingToolSentTargets } : {},
		...params.deliverySucceeded !== void 0 ? { deliverySucceeded: params.deliverySucceeded } : {},
		...params.deliveryStatus ? { deliveryStatus: params.deliveryStatus } : {}
	};
}
function serializeDeliveryPayloadOutcomes(outcomes) {
	if (!outcomes || outcomes.length === 0) return;
	return outcomes.map((outcome) => {
		if (outcome.status === "sent") return {
			index: outcome.index,
			status: "sent",
			resultCount: outcome.results.length
		};
		if (outcome.status === "suppressed") return {
			index: outcome.index,
			status: "suppressed",
			reason: outcome.reason,
			...outcome.hookEffect ? { hookEffect: outcome.hookEffect } : {}
		};
		return {
			index: outcome.index,
			status: "failed",
			error: formatErrorMessage(outcome.error),
			sentBeforeError: outcome.sentBeforeError,
			stage: outcome.stage
		};
	});
}
function deliveryStatusFromDurableSend(send) {
	const payloadOutcomes = serializeDeliveryPayloadOutcomes(send.payloadOutcomes);
	switch (send.status) {
		case "sent": return {
			requested: true,
			attempted: true,
			status: "sent",
			succeeded: true,
			resultCount: send.results.length,
			...payloadOutcomes ? { payloadOutcomes } : {}
		};
		case "suppressed": return {
			requested: true,
			attempted: true,
			status: "suppressed",
			succeeded: true,
			reason: send.reason,
			resultCount: 0,
			...payloadOutcomes ? { payloadOutcomes } : {}
		};
		case "partial_failed": return {
			requested: true,
			attempted: true,
			status: "partial_failed",
			succeeded: "partial",
			error: true,
			errorMessage: formatErrorMessage(send.error),
			resultCount: send.results.length,
			sentBeforeError: true,
			...payloadOutcomes ? { payloadOutcomes } : {}
		};
		case "failed": return {
			requested: true,
			attempted: true,
			status: "failed",
			succeeded: false,
			error: true,
			errorMessage: formatErrorMessage(send.error),
			...send.stage ? { reason: send.stage } : {},
			...payloadOutcomes ? { payloadOutcomes } : {}
		};
	}
	return send;
}
function preDeliveryFailureStatus(reason) {
	return {
		requested: true,
		attempted: false,
		status: "failed",
		succeeded: false,
		error: true,
		reason
	};
}
function noVisiblePayloadStatus() {
	return {
		requested: true,
		attempted: false,
		status: "suppressed",
		succeeded: true,
		reason: "no_visible_payload",
		resultCount: 0
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
	const explicitChannelHint = (opts.replyChannel ?? opts.channel)?.trim();
	const resolveDeliveryRouting = async (candidateSessionEntry) => {
		const deliveryPlan = resolveAgentDeliveryPlan({
			sessionEntry: candidateSessionEntry,
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
		const resolvedThreadId = deliveryPlan.resolvedThreadId ?? opts.threadId;
		const replyTransport = deliveryPlugin?.threading?.resolveReplyTransport?.({
			cfg,
			accountId: resolvedAccountId,
			threadId: resolvedThreadId
		}) ?? null;
		return {
			deliveryPlan,
			deliveryChannel,
			effectiveDeliveryPlan,
			deliveryPlugin,
			isDeliveryChannelKnown,
			targetMode,
			resolvedAccountId,
			resolved,
			resolvedTarget: resolved.resolvedTarget,
			deliveryTarget: resolved.resolvedTo,
			resolvedThreadId,
			resolvedReplyToId: replyTransport?.replyToId ?? void 0,
			resolvedThreadTarget: replyTransport && Object.hasOwn(replyTransport, "threadId") ? replyTransport.threadId ?? null : resolvedThreadId ?? null
		};
	};
	const deliveryRoutingFailureReason = (route) => {
		if (!deliver) return;
		if (isInternalMessageChannel(route.deliveryChannel)) return "channel_resolved_to_internal";
		if (!route.isDeliveryChannelKnown) return "unknown_channel";
		if (route.resolvedTarget && !route.resolvedTarget.ok) return "invalid_delivery_target";
		if (!route.deliveryTarget) return "no_delivery_target";
	};
	const isRetryableFreshSessionRoutingFailure = (route) => {
		const reason = deliveryRoutingFailureReason(route);
		if (!reason) return false;
		if (reason === "unknown_channel") return false;
		return true;
	};
	let deliveryRouting = await resolveDeliveryRouting(sessionEntry);
	if (isRetryableFreshSessionRoutingFailure(deliveryRouting)) {
		const freshSessionEntry = await params.resolveFreshSessionEntryForDelivery?.();
		const expectedFreshSessionId = params.expectedSessionIdForFreshDelivery ?? sessionEntry?.sessionId;
		if (freshSessionEntry && freshSessionEntry !== sessionEntry && isFreshDeliverySessionMatch(freshSessionEntry, expectedFreshSessionId)) {
			const freshRouting = await resolveDeliveryRouting(freshSessionEntry);
			if (!deliveryRoutingFailureReason(freshRouting)) {
				if (!opts.json) runtime.log(`[delivery] refreshed session routing before final delivery (session=${effectiveSessionKey ?? "unknown"} channel=${freshRouting.deliveryChannel})`);
				deliveryRouting = freshRouting;
			}
		}
	}
	const { deliveryChannel, isDeliveryChannelKnown, resolvedAccountId, resolvedTarget, deliveryTarget, resolvedReplyToId, resolvedThreadTarget } = deliveryRouting;
	let deliveryLoggedError = false;
	const logDeliveryError = (err) => {
		deliveryLoggedError = true;
		const message = `Delivery failed (${deliveryChannel}${deliveryTarget ? ` to ${deliveryTarget}` : ""}): ${String(err)}`;
		runtime.error?.(message);
		if (!runtime.error) runtime.log(message);
	};
	let strictPreDeliveryError;
	let deliveryStatus;
	const handlePreDeliveryError = (err, reason) => {
		deliveryStatus = preDeliveryFailureStatus(reason);
		if (!bestEffortDeliver) {
			if (opts.json) {
				strictPreDeliveryError = err;
				return;
			}
			throw err;
		}
		logDeliveryError(err);
	};
	if (deliver) {
		if (isInternalMessageChannel(deliveryChannel)) handlePreDeliveryError(/* @__PURE__ */ new Error("delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel"), "channel_resolved_to_internal");
		else if (!isDeliveryChannelKnown) handlePreDeliveryError(/* @__PURE__ */ new Error(`Unknown channel: ${deliveryChannel}`), "unknown_channel");
		else if (resolvedTarget && !resolvedTarget.ok) handlePreDeliveryError(resolvedTarget.error, "invalid_delivery_target");
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
	const outboundPayloadPlan = createOutboundPayloadPlan(deliver && !deliveryStatus && !isInternalMessageChannel(deliveryChannel) ? await normalizeReplyMediaPathsForDelivery({
		cfg,
		payloads: normalizedReplyPayloads,
		sessionKey: effectiveSessionKey,
		outboundSession,
		deliveryChannel,
		accountId: resolvedAccountId
	}) : normalizedReplyPayloads);
	const normalizedPayloads = projectOutboundPayloadPlanForJson(outboundPayloadPlan);
	const resultMeta = mergeResultMetaOverrides(result.meta, opts.resultMetaOverrides);
	const emitJsonEnvelope = (status) => {
		if (!opts.json) return;
		writeRuntimeJson(runtime, {
			...buildOutboundResultEnvelope({
				payloads: normalizedPayloads,
				meta: resultMeta
			}),
			...status ? { deliveryStatus: status } : {}
		});
	};
	if (strictPreDeliveryError) {
		emitJsonEnvelope(deliveryStatus);
		throw strictPreDeliveryError;
	}
	const deliveryPayloads = projectOutboundPayloadPlanForOutbound(outboundPayloadPlan);
	if (deliveryPayloads.length === 0) {
		deliveryStatus = deliver ? deliveryStatus ?? noVisiblePayloadStatus() : void 0;
		const deliverySucceeded = deliveryStatus?.succeeded === true ? true : void 0;
		emitJsonEnvelope(deliveryStatus);
		return buildDeliveryResult({
			payloads: normalizedPayloads,
			meta: resultMeta,
			result,
			deliverySucceeded,
			deliveryStatus
		});
	}
	let deliverySucceeded = false;
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
	if (!deliver) {
		for (const payload of deliveryPayloads) logPayload(payload);
		emitJsonEnvelope();
		return buildDeliveryResult({
			payloads: normalizedPayloads,
			meta: resultMeta,
			result
		});
	}
	if (deliver && deliveryChannel && !isInternalMessageChannel(deliveryChannel)) {
		if (deliveryTarget && !deliveryStatus) {
			const send = await sendDurableMessageBatch({
				cfg,
				channel: deliveryChannel,
				to: deliveryTarget,
				accountId: resolvedAccountId,
				payloads: deliveryPayloads,
				session: outboundSession,
				replyToId: resolvedReplyToId ?? null,
				threadId: resolvedThreadTarget ?? null,
				bestEffort: bestEffortDeliver,
				durability: bestEffortDeliver ? "best_effort" : "required",
				onError: logDeliveryError,
				onPayload: logPayload,
				deps: createOutboundSendDeps(deps)
			});
			deliveryStatus = deliveryStatusFromDurableSend(send);
			if (!bestEffortDeliver && (send.status === "failed" || send.status === "partial_failed")) {
				emitJsonEnvelope(deliveryStatus);
				throw send.error;
			}
			deliverySucceeded = send.status === "sent" || send.status === "suppressed";
		}
	}
	if (deliver && !deliveryStatus) deliveryStatus = preDeliveryFailureStatus("no_delivery_target");
	if (deliver && !deliverySucceeded && !opts.json && !deliveryLoggedError) {
		const message = `[delivery] delivery requested but not completed: ${deliveryStatus?.status ?? "unknown"} (reason=${deliveryStatus?.reason ?? "none"} session=${effectiveSessionKey ?? "unknown"} channel=${deliveryChannel ?? "none"} target=${deliveryTarget ?? "none"} payloads=${deliveryPayloads.length})`;
		runtime.error?.(message);
		if (!runtime.error) runtime.log(message);
	}
	emitJsonEnvelope(deliveryStatus);
	return buildDeliveryResult({
		payloads: normalizedPayloads,
		meta: resultMeta,
		result,
		deliverySucceeded,
		deliveryStatus
	});
}
//#endregion
export { deliverAgentCommandResult };
