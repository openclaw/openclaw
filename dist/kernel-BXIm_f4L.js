import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as createCommandTurnContext, t as commandTurnKindToSource } from "./command-turn-context-BiMylvBj.js";
import { t as buildOutboundSessionContext } from "./session-context-DSIPIqLK.js";
import { t as deriveDurableFinalDeliveryRequirements } from "./capabilities-B3ut6ovI.js";
import { r as resolveOutboundDurableFinalDeliverySupport } from "./deliver-WPtVqUMT.js";
import { t as normalizeDeliverableOutboundChannel } from "./channel-resolution-Ecs0HEdK.js";
import { n as listMessageReceiptPlatformIds } from "./receipt-vrVTwZtS.js";
import { t as sendDurableMessageBatch } from "./send-CGvo7HYh.js";
import { t as finalizeInboundContext } from "./inbound-context-Cg0uCtqQ.js";
import { h as recordPendingHistoryEntryWithMedia, u as clearHistoryEntriesIfEnabled } from "./history-BD_TtuvO.js";
import { t as createChannelReplyPipeline } from "./reply-pipeline-EtNTatED.js";
import { a as resolvePairLoopGuardSettings, r as createPairLoopGuard } from "./pair-loop-guard-runtime-jabAgbOL.js";
import { t as EMPTY_CHANNEL_TURN_DISPATCH_COUNTS } from "./dispatch-result-BM3RYtx4.js";
import { r as shouldIncludeSupplementalContext } from "./context-visibility-C9pX_aod.js";
import "./history-window-Gy0CzEef.js";
//#region src/channels/inbound-event/media.ts
function alignedStrings(values) {
	if (!values.some(Boolean)) return;
	return values.map((value) => value ?? "");
}
function normalizeString(value) {
	const normalized = value?.trim();
	return normalized ? normalized : void 0;
}
function normalizeKind(value) {
	return value ?? void 0;
}
function mediaType(media) {
	return media.contentType ?? media.kind;
}
function toInboundMediaFacts(media, defaults = {}) {
	if (!Array.isArray(media)) return [];
	return media.map((entry, index) => ({
		path: normalizeString(entry.path),
		url: normalizeString(entry.url),
		contentType: normalizeString(entry.contentType),
		kind: normalizeKind(entry.kind) ?? defaults.kind,
		transcribed: entry.transcribed === true || defaults.transcribed?.(entry, index) === true,
		messageId: normalizeString(entry.messageId) ?? defaults.messageId
	}));
}
function toHistoryMediaEntries(media, defaults = {}) {
	return toInboundMediaFacts(media, defaults).map((entry) => ({
		path: entry.path,
		url: entry.url,
		contentType: entry.contentType,
		kind: entry.kind,
		messageId: entry.messageId
	}));
}
function buildChannelInboundMediaPayload(media) {
	const entries = Array.isArray(media) ? media : [];
	const transcribedIndexes = entries.map((item, index) => item.transcribed ? index : void 0).filter((index) => index !== void 0);
	return {
		MediaPath: entries[0]?.path,
		MediaUrl: entries[0]?.url ?? entries[0]?.path,
		MediaType: entries[0] ? mediaType(entries[0]) : void 0,
		MediaPaths: alignedStrings(entries.map((item) => item.path)),
		MediaUrls: alignedStrings(entries.map((item) => item.url ?? item.path)),
		MediaTypes: alignedStrings(entries.map(mediaType)),
		MediaTranscribedIndexes: transcribedIndexes.length > 0 ? transcribedIndexes : void 0
	};
}
//#endregion
//#region src/channels/turn/bot-loop-protection.ts
const channelBotPairLoopGuard = createPairLoopGuard({ pruneIntervalMs: 6e4 });
function recordChannelBotPairLoopAndCheckSuppression(params) {
	return channelBotPairLoopGuard.recordAndCheck({
		scopeId: params.scopeId,
		conversationId: params.conversationId,
		senderId: params.senderId,
		receiverId: params.receiverId,
		settings: resolvePairLoopGuardSettings({
			config: params.config,
			defaultsConfig: params.defaultsConfig,
			defaultEnabled: params.defaultEnabled
		}),
		nowMs: params.nowMs
	});
}
//#endregion
//#region src/channels/turn/delivery-result.ts
function createChannelDeliveryResultFromReceipt(params) {
	const messageIds = listMessageReceiptPlatformIds(params.receipt);
	return {
		...messageIds.length > 0 ? { messageIds } : {},
		receipt: params.receipt,
		...params.threadId ? { threadId: params.threadId } : {},
		...params.replyToId ? { replyToId: params.replyToId } : {},
		...params.visibleReplySent === void 0 ? {} : { visibleReplySent: params.visibleReplySent },
		...params.deliveryIntent ? { deliveryIntent: params.deliveryIntent } : {}
	};
}
//#endregion
//#region src/channels/turn/durable-delivery.ts
function resolveDeliveryTarget(params) {
	return normalizeOptionalString(params.to) ?? normalizeOptionalString(params.ctxPayload.OriginatingTo) ?? normalizeOptionalString(params.ctxPayload.To);
}
function resolveDurableInboundReplyToId(params) {
	if (params.replyToId === null || params.payload.replyToId === null) return null;
	return normalizeOptionalString(params.replyToId) ?? normalizeOptionalString(params.payload.replyToId) ?? normalizeOptionalString(params.ctxPayload.ReplyToIdFull) ?? normalizeOptionalString(params.ctxPayload.ReplyToId);
}
function resolveDurableInboundReplyThreadId(params) {
	if ("threadId" in params) return params.threadId;
	return params.ctxPayload.MessageThreadId;
}
function stringifyThreadId(value) {
	return value == null ? void 0 : String(value);
}
function toDeliveryIntent(intent) {
	return {
		id: intent.id,
		kind: "outbound_queue",
		queuePolicy: intent.queuePolicy
	};
}
function isDurableInboundReplyDeliveryHandled(result) {
	return result.status === "handled_visible" || result.status === "handled_no_send";
}
function throwIfDurableInboundReplyDeliveryFailed(result) {
	if (result.status === "failed") throw result.error;
}
async function deliverInboundReplyWithMessageSendContext(params) {
	if (params.info.kind !== "final") return {
		status: "not_applicable",
		reason: "non_final"
	};
	const channel = normalizeDeliverableOutboundChannel(params.channel);
	const to = resolveDeliveryTarget(params);
	if (!channel) return {
		status: "unsupported",
		reason: "missing_channel"
	};
	if (!to) return {
		status: "unsupported",
		reason: "missing_target"
	};
	const replyToId = resolveDurableInboundReplyToId(params);
	const threadId = resolveDurableInboundReplyThreadId(params);
	const requiredCapabilities = params.requiredCapabilities ?? deriveDurableFinalDeliveryRequirements({
		payload: params.payload,
		replyToId,
		threadId,
		silent: params.silent
	});
	const durability = requiredCapabilities.reconcileUnknownSend === true ? "required" : "best_effort";
	let support;
	try {
		support = await resolveOutboundDurableFinalDeliverySupport({
			cfg: params.cfg,
			channel,
			requirements: requiredCapabilities
		});
	} catch (err) {
		return {
			status: "failed",
			error: err
		};
	}
	if (!support.ok) return {
		status: "unsupported",
		reason: support.reason,
		...support.capability ? { capability: support.capability } : {}
	};
	const session = buildOutboundSessionContext({
		cfg: params.cfg,
		sessionKey: params.ctxPayload.SessionKey,
		policySessionKey: params.ctxPayload.RuntimePolicySessionKey,
		conversationType: params.ctxPayload.ChatType,
		agentId: params.agentId,
		requesterAccountId: params.accountId ?? params.ctxPayload.AccountId,
		requesterSenderId: params.ctxPayload.SenderId ?? params.ctxPayload.From,
		requesterSenderName: params.ctxPayload.SenderName,
		requesterSenderUsername: params.ctxPayload.SenderUsername,
		requesterSenderE164: params.ctxPayload.SenderE164
	});
	const send = await sendDurableMessageBatch({
		cfg: params.cfg,
		channel,
		to,
		accountId: params.accountId,
		payloads: [params.payload],
		threadId,
		replyToId,
		replyToMode: params.replyToMode,
		formatting: params.formatting,
		identity: params.identity,
		deps: params.deps,
		mediaAccess: params.mediaAccess,
		silent: params.silent,
		durability,
		session,
		gatewayClientScopes: params.ctxPayload.GatewayClientScopes
	});
	if (send.status === "failed") return {
		status: "failed",
		error: send.error
	};
	if (send.status === "partial_failed") return {
		status: "failed",
		error: send.error
	};
	const delivery = createChannelDeliveryResultFromReceipt({
		receipt: send.receipt,
		threadId: stringifyThreadId(threadId),
		...replyToId ? { replyToId } : {},
		visibleReplySent: send.status === "sent",
		...send.deliveryIntent ? { deliveryIntent: toDeliveryIntent(send.deliveryIntent) } : {}
	});
	if (send.status === "suppressed") return {
		status: "handled_no_send",
		reason: "no_visible_result",
		delivery
	};
	return {
		status: "handled_visible",
		delivery
	};
}
//#endregion
//#region src/channels/inbound-event/context.ts
function keepSupplementalContext(params) {
	if (!params.mode || params.mode === "all") return true;
	if (params.senderAllowed === void 0) return false;
	return shouldIncludeSupplementalContext({
		mode: params.mode,
		kind: params.kind,
		senderAllowed: params.senderAllowed
	});
}
function filterChannelInboundSupplementalContext(params) {
	const supplemental = params.supplemental;
	if (!supplemental) return;
	const quote = keepSupplementalContext({
		mode: params.contextVisibility,
		kind: "quote",
		senderAllowed: supplemental.quote?.senderAllowed
	}) ? supplemental.quote : void 0;
	const forwarded = keepSupplementalContext({
		mode: params.contextVisibility,
		kind: "forwarded",
		senderAllowed: supplemental.forwarded?.senderAllowed
	}) ? supplemental.forwarded : void 0;
	const thread = keepSupplementalContext({
		mode: params.contextVisibility,
		kind: "thread",
		senderAllowed: supplemental.thread?.senderAllowed
	}) ? supplemental.thread : void 0;
	return {
		...supplemental,
		quote,
		forwarded,
		thread
	};
}
function resolveAccessFactsCommandAuthorized(access) {
	const commands = access?.commands;
	return typeof commands?.authorized === "boolean" ? commands.authorized : commands?.authorizers?.some((entry) => entry.allowed);
}
function resolveChannelCommandContext(params) {
	if (params.commandTurn) return params.commandTurn;
	const command = params.command;
	if (!command) return;
	const body = command.body ?? params.message.commandBody ?? params.message.rawBody;
	return createCommandTurnContext(commandTurnKindToSource(command.kind), {
		authorized: command.kind === "normal" ? false : command.authorized ?? resolveAccessFactsCommandAuthorized(params.access) === true,
		commandName: command.name,
		body
	});
}
function buildChannelInboundEventContext(params) {
	const mediaPayload = buildChannelInboundMediaPayload(params.media ?? []);
	const supplemental = filterChannelInboundSupplementalContext({
		supplemental: params.supplemental,
		contextVisibility: params.contextVisibility
	});
	const body = params.message.body ?? params.message.rawBody;
	const commandTurn = resolveChannelCommandContext({
		command: params.command,
		commandTurn: params.commandTurn,
		message: params.message,
		access: params.access
	});
	return finalizeInboundContext({
		Body: body,
		InboundEventKind: params.message.inboundEventKind ?? "user_request",
		BodyForAgent: params.message.bodyForAgent ?? params.message.rawBody,
		InboundHistory: params.message.inboundHistory,
		RawBody: params.message.rawBody,
		CommandBody: params.message.commandBody ?? params.message.rawBody,
		BodyForCommands: params.message.commandBody ?? params.message.rawBody,
		From: params.from,
		To: params.reply.to,
		SessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
		AccountId: params.route.accountId ?? params.accountId,
		ParentSessionKey: params.route.parentSessionKey,
		ModelParentSessionKey: params.route.modelParentSessionKey,
		MessageSid: params.messageId,
		MessageSidFull: params.messageIdFull,
		ReplyToId: params.reply.replyToId ?? supplemental?.quote?.id,
		ReplyToIdFull: params.reply.replyToIdFull ?? supplemental?.quote?.fullId,
		ReplyToBody: supplemental?.quote?.body,
		ReplyToSender: supplemental?.quote?.sender,
		ReplyToIsQuote: supplemental?.quote?.isQuote,
		ForwardedFrom: supplemental?.forwarded?.from,
		ForwardedFromType: supplemental?.forwarded?.fromType,
		ForwardedFromId: supplemental?.forwarded?.fromId,
		ForwardedDate: supplemental?.forwarded?.date,
		ThreadStarterBody: supplemental?.thread?.starterBody,
		ThreadHistoryBody: supplemental?.thread?.historyBody,
		ThreadLabel: supplemental?.thread?.label,
		...mediaPayload,
		ChatType: params.conversation.kind,
		ConversationLabel: params.conversation.label,
		GroupSubject: params.conversation.kind !== "direct" ? params.conversation.label : void 0,
		GroupSpace: params.conversation.spaceId,
		GroupSystemPrompt: supplemental?.groupSystemPrompt,
		UntrustedStructuredContext: supplemental?.untrustedContext,
		SenderName: params.sender.name ?? params.sender.displayLabel,
		SenderId: params.sender.id,
		SenderUsername: params.sender.username,
		SenderTag: params.sender.tag,
		MemberRoleIds: params.sender.roles,
		Timestamp: params.timestamp,
		Provider: params.provider ?? params.channel,
		Surface: params.surface ?? params.provider ?? params.channel,
		WasMentioned: params.access?.mentions?.wasMentioned,
		CommandAuthorized: resolveAccessFactsCommandAuthorized(params.access) === true,
		CommandTurn: commandTurn,
		MessageThreadId: params.reply.messageThreadId ?? params.conversation.threadId,
		NativeChannelId: params.reply.nativeChannelId ?? params.conversation.nativeChannelId,
		OriginatingChannel: params.channel,
		OriginatingTo: params.reply.originatingTo,
		ThreadParentId: params.reply.threadParentId ?? params.conversation.parentId,
		...params.extra
	});
}
//#endregion
//#region src/channels/turn/kernel.ts
const DEFAULT_EVENT_CLASS = {
	kind: "message",
	canStartAgentTurn: true
};
function isAdmission(value) {
	if (!value || typeof value !== "object") return false;
	const kind = value.kind;
	return kind === "dispatch" || kind === "observeOnly" || kind === "handled" || kind === "drop";
}
function normalizePreflight(value) {
	if (!value) return {};
	if (isAdmission(value)) return { admission: value };
	return value;
}
function emit(params) {
	params.log?.({
		channel: params.channel,
		accountId: params.accountId,
		...params.event
	});
}
function createNoopChannelEventDeliveryAdapter() {
	return { deliver: async () => ({ visibleReplySent: false }) };
}
function clearPendingHistoryAfterTurn(params) {
	if (!params?.isGroup || !params.historyKey || !params.historyMap || params.limit === void 0) return;
	clearHistoryEntriesIfEnabled({
		historyMap: params.historyMap,
		historyKey: params.historyKey,
		limit: params.limit
	});
}
function resolveDroppedHistorySender(input, preflight) {
	return preflight.message?.senderLabel ?? preflight.message?.envelopeFrom ?? (typeof input.raw === "object" && input.raw && "sender" in input.raw && typeof input.raw.sender === "string" ? input.raw.sender : void 0) ?? "unknown";
}
function resolveDroppedHistoryBody(input, preflight) {
	return preflight.message?.bodyForAgent ?? preflight.message?.body ?? preflight.message?.rawBody ?? input.textForAgent ?? input.rawText;
}
async function recordDroppedChannelTurnHistory(params) {
	const admission = params.admission ?? params.preflight.admission;
	if (admission?.kind !== "drop") return;
	const history = params.preflight.history;
	if (!history || history.limit <= 0 || !(history.recordOnDrop || admission.recordHistory)) return;
	const body = resolveDroppedHistoryBody(params.input, params.preflight);
	const entry = body.trim().length > 0 ? {
		sender: resolveDroppedHistorySender(params.input, params.preflight),
		body,
		timestamp: params.input.timestamp,
		messageId: params.input.id
	} : null;
	const media = params.preflight.media;
	await recordPendingHistoryEntryWithMedia({
		historyMap: history.historyMap,
		historyKey: history.key,
		limit: history.limit,
		entry,
		mediaLimit: history.mediaLimit,
		messageId: params.input.id,
		shouldRecord: history.shouldRecord,
		media: typeof media === "function" ? async () => toHistoryMediaEntries(await media(), { messageId: params.input.id }) : toHistoryMediaEntries(media, { messageId: params.input.id })
	});
}
function resolveAssembledReplyPipeline(params) {
	if (!params.replyPipeline) return {
		dispatcherOptions: params.dispatcherOptions,
		replyOptions: params.replyOptions
	};
	const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: params.channel,
		accountId: params.accountId,
		...params.replyPipeline
	});
	return {
		dispatcherOptions: {
			...replyPipeline,
			...params.dispatcherOptions
		},
		replyOptions: {
			onModelSelected,
			...params.replyOptions
		}
	};
}
function resolveObserveOnlyDispatchResult(params) {
	return params.observeOnlyDispatchResult ?? {
		queuedFinal: false,
		counts: EMPTY_CHANNEL_TURN_DISPATCH_COUNTS
	};
}
function resolveBotLoopProtectionDrop(params) {
	if (!params.botLoopProtection) return;
	if (!recordChannelBotPairLoopAndCheckSuppression(params.botLoopProtection).suppressed) return;
	const admission = {
		kind: "drop",
		reason: "bot-loop-protection"
	};
	emit({
		...params,
		event: {
			stage: "authorize",
			event: "drop",
			messageId: params.messageId,
			sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
			admission: admission.kind,
			reason: admission.reason
		}
	});
	return {
		admission,
		dispatched: false,
		ctxPayload: params.ctxPayload,
		routeSessionKey: params.routeSessionKey
	};
}
async function dispatchAssembledChannelTurn(params) {
	const replyPipeline = resolveAssembledReplyPipeline(params);
	return await runPreparedChannelTurnCore({
		channel: params.channel,
		accountId: params.accountId,
		routeSessionKey: params.routeSessionKey,
		storePath: params.storePath,
		ctxPayload: params.ctxPayload,
		recordInboundSession: params.recordInboundSession,
		record: params.record,
		history: params.history,
		admission: params.admission,
		botLoopProtection: params.botLoopProtection,
		log: params.log,
		messageId: params.messageId,
		runDispatch: async () => await params.dispatchReplyWithBufferedBlockDispatcher({
			ctx: params.ctxPayload,
			cfg: params.cfg,
			dispatcherOptions: {
				...replyPipeline.dispatcherOptions,
				deliver: async (payload, info) => {
					const preparedPayload = params.delivery.preparePayload ? await params.delivery.preparePayload(payload, info) : payload;
					const durableOptions = typeof params.delivery.durable === "function" ? await params.delivery.durable(preparedPayload, info) : params.delivery.durable;
					if (durableOptions) {
						const durable = await deliverInboundReplyWithMessageSendContext({
							cfg: params.cfg,
							channel: params.channel,
							accountId: params.accountId,
							agentId: params.agentId,
							ctxPayload: params.ctxPayload,
							payload: preparedPayload,
							info,
							...durableOptions
						});
						throwIfDurableInboundReplyDeliveryFailed(durable);
						if (isDurableInboundReplyDeliveryHandled(durable)) {
							await params.delivery.onDelivered?.(preparedPayload, info, durable.delivery);
							return durable.delivery;
						}
					}
					const result = await params.delivery.deliver(preparedPayload, info);
					await params.delivery.onDelivered?.(preparedPayload, info, result);
					return result;
				},
				onError: params.delivery.onError
			},
			replyOptions: replyPipeline.replyOptions,
			replyResolver: params.replyResolver
		})
	}, { suppressObserveOnlyDispatch: false });
}
function isPreparedChannelTurn(value) {
	return "runDispatch" in value;
}
async function dispatchResolvedChannelTurn(params) {
	if (isPreparedChannelTurn(params)) return await runPreparedChannelTurn(params);
	return await dispatchAssembledChannelTurn(params);
}
async function runPreparedChannelTurnCore(params, options) {
	const admission = params.admission ?? { kind: "dispatch" };
	const botLoopDrop = resolveBotLoopProtectionDrop(params);
	if (botLoopDrop) {
		clearPendingHistoryAfterTurn(params.history);
		return botLoopDrop;
	}
	emit({
		...params,
		event: {
			stage: "record",
			event: "start",
			messageId: params.messageId,
			sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
			admission: admission.kind
		}
	});
	try {
		await params.recordInboundSession({
			storePath: params.storePath,
			sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
			ctx: params.ctxPayload,
			groupResolution: params.record?.groupResolution,
			createIfMissing: params.record?.createIfMissing,
			updateLastRoute: params.record?.updateLastRoute,
			onRecordError: params.record?.onRecordError ?? (() => void 0),
			trackSessionMetaTask: params.record?.trackSessionMetaTask
		});
		emit({
			...params,
			event: {
				stage: "record",
				event: "done",
				messageId: params.messageId,
				sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
				admission: admission.kind
			}
		});
	} catch (err) {
		emit({
			...params,
			event: {
				stage: "record",
				event: "error",
				messageId: params.messageId,
				sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
				admission: admission.kind,
				error: err
			}
		});
		try {
			await params.onPreDispatchFailure?.(err);
		} catch {}
		throw err;
	}
	emit({
		...params,
		event: {
			stage: "dispatch",
			event: "start",
			messageId: params.messageId,
			sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
			admission: admission.kind
		}
	});
	let dispatchResult;
	try {
		dispatchResult = options.suppressObserveOnlyDispatch && admission.kind === "observeOnly" ? resolveObserveOnlyDispatchResult(params) : await params.runDispatch();
	} catch (err) {
		emit({
			...params,
			event: {
				stage: "dispatch",
				event: "error",
				messageId: params.messageId,
				sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
				admission: admission.kind,
				error: err
			}
		});
		throw err;
	}
	emit({
		...params,
		event: {
			stage: "dispatch",
			event: "done",
			messageId: params.messageId,
			sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
			admission: admission.kind
		}
	});
	clearPendingHistoryAfterTurn(params.history);
	return {
		admission,
		dispatched: true,
		ctxPayload: params.ctxPayload,
		routeSessionKey: params.routeSessionKey,
		dispatchResult
	};
}
async function runPreparedChannelTurn(params) {
	return await runPreparedChannelTurnCore(params, { suppressObserveOnlyDispatch: true });
}
async function runChannelTurn(params) {
	emit({
		...params,
		event: {
			stage: "ingest",
			event: "start"
		}
	});
	const input = await params.adapter.ingest(params.raw);
	if (!input) {
		const admission = {
			kind: "drop",
			reason: "ingest-null"
		};
		emit({
			...params,
			event: {
				stage: "ingest",
				event: "drop",
				admission: admission.kind,
				reason: admission.reason
			}
		});
		return {
			admission,
			dispatched: false
		};
	}
	emit({
		...params,
		event: {
			stage: "ingest",
			event: "done",
			messageId: input.id
		}
	});
	const eventClass = await params.adapter.classify?.(input) ?? DEFAULT_EVENT_CLASS;
	if (!eventClass.canStartAgentTurn) {
		const admission = {
			kind: "handled",
			reason: `event:${eventClass.kind}`
		};
		emit({
			...params,
			event: {
				stage: "classify",
				event: "handled",
				messageId: input.id,
				admission: admission.kind,
				reason: admission.reason
			}
		});
		return {
			admission,
			dispatched: false
		};
	}
	const preflight = normalizePreflight(await params.adapter.preflight?.(input, eventClass));
	const preflightAdmission = preflight.admission;
	if (preflightAdmission && preflightAdmission.kind !== "dispatch" && preflightAdmission.kind !== "observeOnly") {
		await recordDroppedChannelTurnHistory({
			input,
			preflight,
			admission: preflightAdmission
		});
		emit({
			...params,
			event: {
				stage: "preflight",
				event: preflightAdmission.kind === "handled" ? "handled" : "drop",
				messageId: input.id,
				admission: preflightAdmission.kind,
				reason: preflightAdmission.reason
			}
		});
		return {
			admission: preflightAdmission,
			dispatched: false
		};
	}
	const resolved = await params.adapter.resolveTurn(input, eventClass, preflight);
	emit({
		...params,
		accountId: resolved.accountId ?? params.accountId,
		event: {
			stage: "assemble",
			event: "done",
			messageId: input.id,
			sessionKey: resolved.routeSessionKey,
			admission: resolved.admission?.kind ?? "dispatch"
		}
	});
	const admission = resolved.admission ?? preflightAdmission ?? { kind: "dispatch" };
	let result;
	try {
		const dispatchResult = await dispatchResolvedChannelTurn(admission.kind === "observeOnly" ? {
			...resolved,
			delivery: createNoopChannelEventDeliveryAdapter(),
			admission,
			log: params.log,
			messageId: input.id
		} : {
			...resolved,
			admission,
			log: params.log,
			messageId: input.id
		});
		result = dispatchResult.dispatched ? {
			...dispatchResult,
			admission
		} : dispatchResult;
	} catch (err) {
		const failedResult = {
			admission,
			dispatched: false,
			ctxPayload: resolved.ctxPayload,
			routeSessionKey: resolved.routeSessionKey
		};
		try {
			await params.adapter.onFinalize?.(failedResult);
		} catch {}
		emit({
			...params,
			accountId: resolved.accountId ?? params.accountId,
			event: {
				stage: "finalize",
				event: "done",
				messageId: input.id,
				sessionKey: resolved.routeSessionKey,
				admission: admission.kind
			}
		});
		throw err;
	}
	try {
		await params.adapter.onFinalize?.(result);
		emit({
			...params,
			accountId: resolved.accountId ?? params.accountId,
			event: {
				stage: "finalize",
				event: "done",
				messageId: input.id,
				sessionKey: resolved.routeSessionKey,
				admission: admission.kind
			}
		});
	} catch (err) {
		emit({
			...params,
			accountId: resolved.accountId ?? params.accountId,
			event: {
				stage: "finalize",
				event: "error",
				messageId: input.id,
				sessionKey: resolved.routeSessionKey,
				admission: admission.kind,
				error: err
			}
		});
		throw err;
	}
	return result;
}
async function runResolvedChannelTurn(params) {
	return await runChannelTurn({
		channel: params.channel,
		accountId: params.accountId,
		raw: params.raw,
		log: params.log,
		adapter: {
			ingest: (raw) => typeof params.input === "function" ? params.input(raw) : params.input,
			resolveTurn: params.resolveTurn
		}
	});
}
//#endregion
export { runPreparedChannelTurn as a, filterChannelInboundSupplementalContext as c, throwIfDurableInboundReplyDeliveryFailed as d, createChannelDeliveryResultFromReceipt as f, toInboundMediaFacts as g, toHistoryMediaEntries as h, runChannelTurn as i, deliverInboundReplyWithMessageSendContext as l, buildChannelInboundMediaPayload as m, dispatchAssembledChannelTurn as n, runResolvedChannelTurn as o, recordChannelBotPairLoopAndCheckSuppression as p, recordDroppedChannelTurnHistory as r, buildChannelInboundEventContext as s, createNoopChannelEventDeliveryAdapter as t, isDurableInboundReplyDeliveryHandled as u };
