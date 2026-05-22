import { t as finalizeInboundContext } from "./inbound-context-7ossg2z_.js";
import { c as clearHistoryEntriesIfEnabled } from "./history-BNSb9V71.js";
import { t as EMPTY_CHANNEL_TURN_DISPATCH_COUNTS } from "./dispatch-result-vD_r1T2i.js";
import { r as shouldIncludeSupplementalContext } from "./context-visibility-CPmLQtEe.js";
//#region src/channels/turn/context.ts
function compactStrings(values) {
	const compacted = values.filter((value) => Boolean(value));
	return compacted.length > 0 ? compacted : void 0;
}
function mediaTranscribedIndexes(media) {
	const indexes = media.map((item, index) => item.transcribed ? index : void 0).filter((index) => index !== void 0);
	return indexes.length > 0 ? indexes : void 0;
}
function commandAuthorized(access) {
	const commands = access?.commands;
	if (!commands) return;
	return commands.authorizers.some((entry) => entry.allowed);
}
function keepSupplementalContext(params) {
	if (!params.mode || params.mode === "all") return true;
	if (params.senderAllowed === void 0) return false;
	return shouldIncludeSupplementalContext({
		mode: params.mode,
		kind: params.kind,
		senderAllowed: params.senderAllowed
	});
}
function filterChannelTurnSupplementalContext(params) {
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
function buildChannelTurnContext(params) {
	const media = params.media ?? [];
	const supplemental = filterChannelTurnSupplementalContext({
		supplemental: params.supplemental,
		contextVisibility: params.contextVisibility
	});
	return finalizeInboundContext({
		Body: params.message.body ?? params.message.rawBody,
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
		MediaPath: media[0]?.path,
		MediaUrl: media[0]?.url ?? media[0]?.path,
		MediaType: media[0]?.contentType ?? media[0]?.kind,
		MediaPaths: compactStrings(media.map((item) => item.path)),
		MediaUrls: compactStrings(media.map((item) => item.url ?? item.path)),
		MediaTypes: compactStrings(media.map((item) => item.contentType ?? item.kind)),
		MediaTranscribedIndexes: mediaTranscribedIndexes(media),
		ChatType: params.conversation.kind,
		ConversationLabel: params.conversation.label,
		GroupSubject: params.conversation.kind !== "direct" ? params.conversation.label : void 0,
		GroupSpace: params.conversation.spaceId,
		GroupSystemPrompt: supplemental?.groupSystemPrompt,
		UntrustedStructuredContext: Array.isArray(supplemental?.untrustedContext) ? supplemental.untrustedContext.map((payload, index) => ({
			label: `context ${index + 1}`,
			payload
		})) : void 0,
		SenderName: params.sender.name ?? params.sender.displayLabel,
		SenderId: params.sender.id,
		SenderUsername: params.sender.username,
		SenderTag: params.sender.tag,
		MemberRoleIds: params.sender.roles,
		Timestamp: params.timestamp,
		Provider: params.provider ?? params.channel,
		Surface: params.surface ?? params.provider ?? params.channel,
		WasMentioned: params.access?.mentions?.wasMentioned,
		CommandAuthorized: commandAuthorized(params.access),
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
function createNoopChannelTurnDeliveryAdapter() {
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
function resolveObserveOnlyDispatchResult(params) {
	return params.observeOnlyDispatchResult ?? {
		queuedFinal: false,
		counts: EMPTY_CHANNEL_TURN_DISPATCH_COUNTS
	};
}
async function dispatchAssembledChannelTurn(params) {
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
		log: params.log,
		messageId: params.messageId,
		runDispatch: async () => await params.dispatchReplyWithBufferedBlockDispatcher({
			ctx: params.ctxPayload,
			cfg: params.cfg,
			dispatcherOptions: {
				...params.dispatcherOptions,
				deliver: async (payload, info) => {
					await params.delivery.deliver(payload, info);
				},
				onError: params.delivery.onError
			},
			replyOptions: params.replyOptions,
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
		result = {
			...await dispatchResolvedChannelTurn(admission.kind === "observeOnly" ? {
				...resolved,
				delivery: createNoopChannelTurnDeliveryAdapter(),
				admission,
				log: params.log,
				messageId: input.id
			} : {
				...resolved,
				admission,
				log: params.log,
				messageId: input.id
			}),
			admission
		};
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
export { buildChannelTurnContext as a, runResolvedChannelTurn as i, runChannelTurn as n, runPreparedChannelTurn as r, dispatchAssembledChannelTurn as t };
