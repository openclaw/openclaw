import { d as resolveAgentIdFromSessionKey, p as resolveThreadSessionKeys } from "./session-key-Bte0mmcq.js";
import { n as getSessionBindingService } from "./session-binding-service-B19FMAqz.js";
import { n as deriveLastRoutePolicy, t as buildAgentSessionKey } from "./resolve-route-C8IahAyG.js";
import { t as resolveConfiguredAcpBindingRecord } from "./persistent-bindings.resolve-DrfbZLJ2.js";
import "./routing-79DRZvfm.js";
import "./acp-binding-resolve-runtime-BzofJFni.js";
import "./session-binding-runtime-B_bKWdzh.js";
import { n as MATRIX_REACTION_EVENT_TYPE } from "./reaction-common-BjAtJ4Dp.js";
//#region extensions/matrix/src/matrix/monitor/types.ts
const EventType = {
	RoomMessage: "m.room.message",
	RoomMessageEncrypted: "m.room.encrypted",
	RoomMember: "m.room.member",
	Location: "m.location",
	Reaction: MATRIX_REACTION_EVENT_TYPE
};
const RelationType = {
	Replace: "m.replace",
	Thread: "m.thread"
};
//#endregion
//#region extensions/matrix/src/matrix/monitor/threads.ts
function resolveMatrixThreadSessionKeys(params) {
	return resolveThreadSessionKeys({
		...params,
		normalizeThreadId: (threadId) => threadId
	});
}
function resolveMatrixRelatedReplyToEventId(relates) {
	if (!relates || typeof relates !== "object") return;
	if ("m.in_reply_to" in relates && typeof relates["m.in_reply_to"] === "object" && relates["m.in_reply_to"] && "event_id" in relates["m.in_reply_to"] && typeof relates["m.in_reply_to"].event_id === "string") return relates["m.in_reply_to"].event_id;
}
function resolveMatrixThreadRouting(params) {
	const effectiveThreadReplies = params.isDirectMessage && params.dmThreadReplies !== void 0 ? params.dmThreadReplies : params.threadReplies;
	const messageId = params.messageId.trim();
	const threadRootId = params.threadRootId?.trim();
	const inboundThreadId = threadRootId && threadRootId !== messageId ? threadRootId : void 0;
	return { threadId: effectiveThreadReplies === "off" ? void 0 : effectiveThreadReplies === "inbound" ? inboundThreadId : inboundThreadId ?? (messageId || void 0) };
}
function resolveMatrixThreadRootId(params) {
	const relates = params.content["m.relates_to"];
	if (!relates || typeof relates !== "object") return;
	if ("rel_type" in relates && relates.rel_type === RelationType.Thread) {
		if ("event_id" in relates && typeof relates.event_id === "string") return relates.event_id;
		return resolveMatrixRelatedReplyToEventId(relates);
	}
}
function resolveMatrixReplyToEventId(content) {
	return resolveMatrixRelatedReplyToEventId(content["m.relates_to"]);
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/route.ts
function resolveMatrixDmSessionKey(params) {
	if (params.dmSessionScope !== "per-room") return params.fallbackSessionKey;
	return buildAgentSessionKey({
		agentId: params.agentId,
		channel: "matrix",
		accountId: params.accountId,
		peer: {
			kind: "channel",
			id: params.roomId
		}
	});
}
function shouldApplyMatrixPerRoomDmSessionScope(params) {
	return params.isDirectMessage && !params.configuredSessionKey;
}
function resolveMatrixInboundRoute(params) {
	const baseRoute = params.resolveAgentRoute({
		cfg: params.cfg,
		channel: "matrix",
		accountId: params.accountId,
		peer: {
			kind: params.isDirectMessage ? "direct" : "channel",
			id: params.isDirectMessage ? params.senderId : params.roomId
		},
		parentPeer: params.isDirectMessage ? {
			kind: "channel",
			id: params.roomId
		} : void 0
	});
	const bindingConversationId = params.threadId ?? params.roomId;
	const bindingParentConversationId = params.threadId ? params.roomId : void 0;
	const runtimeBinding = getSessionBindingService().resolveByConversation({
		channel: "matrix",
		accountId: params.accountId,
		conversationId: bindingConversationId,
		parentConversationId: bindingParentConversationId
	});
	const boundSessionKey = runtimeBinding?.targetSessionKey?.trim();
	if (runtimeBinding && boundSessionKey) return {
		route: {
			...baseRoute,
			sessionKey: boundSessionKey,
			agentId: resolveAgentIdFromSessionKey(boundSessionKey) || baseRoute.agentId,
			lastRoutePolicy: deriveLastRoutePolicy({
				sessionKey: boundSessionKey,
				mainSessionKey: baseRoute.mainSessionKey
			}),
			matchedBy: "binding.channel"
		},
		configuredBinding: null,
		runtimeBindingId: runtimeBinding.bindingId
	};
	const configuredBinding = runtimeBinding == null ? resolveConfiguredAcpBindingRecord({
		cfg: params.cfg,
		channel: "matrix",
		accountId: params.accountId,
		conversationId: bindingConversationId,
		parentConversationId: bindingParentConversationId
	}) : null;
	const configuredSessionKey = configuredBinding?.record.targetSessionKey?.trim();
	const effectiveRoute = configuredBinding && configuredSessionKey ? {
		...baseRoute,
		sessionKey: configuredSessionKey,
		agentId: resolveAgentIdFromSessionKey(configuredSessionKey) || configuredBinding.spec.agentId || baseRoute.agentId,
		lastRoutePolicy: deriveLastRoutePolicy({
			sessionKey: configuredSessionKey,
			mainSessionKey: baseRoute.mainSessionKey
		}),
		matchedBy: "binding.channel"
	} : baseRoute;
	const dmSessionKey = shouldApplyMatrixPerRoomDmSessionScope({
		isDirectMessage: params.isDirectMessage,
		configuredSessionKey
	}) ? resolveMatrixDmSessionKey({
		accountId: params.accountId,
		agentId: effectiveRoute.agentId,
		roomId: params.roomId,
		dmSessionScope: params.dmSessionScope,
		fallbackSessionKey: effectiveRoute.sessionKey
	}) : effectiveRoute.sessionKey;
	const routeWithDmScope = dmSessionKey === effectiveRoute.sessionKey ? effectiveRoute : {
		...effectiveRoute,
		sessionKey: dmSessionKey,
		lastRoutePolicy: "session"
	};
	if (!configuredBinding && !configuredSessionKey && params.threadId) {
		const threadKeys = resolveMatrixThreadSessionKeys({
			baseSessionKey: routeWithDmScope.sessionKey,
			threadId: params.threadId,
			parentSessionKey: routeWithDmScope.sessionKey
		});
		return {
			route: {
				...routeWithDmScope,
				sessionKey: threadKeys.sessionKey,
				mainSessionKey: threadKeys.parentSessionKey ?? routeWithDmScope.sessionKey,
				lastRoutePolicy: deriveLastRoutePolicy({
					sessionKey: threadKeys.sessionKey,
					mainSessionKey: threadKeys.parentSessionKey ?? routeWithDmScope.sessionKey
				})
			},
			configuredBinding,
			runtimeBindingId: null
		};
	}
	return {
		route: routeWithDmScope,
		configuredBinding,
		runtimeBindingId: null
	};
}
//#endregion
export { EventType as a, resolveMatrixThreadRouting as i, resolveMatrixReplyToEventId as n, RelationType as o, resolveMatrixThreadRootId as r, resolveMatrixInboundRoute as t };
