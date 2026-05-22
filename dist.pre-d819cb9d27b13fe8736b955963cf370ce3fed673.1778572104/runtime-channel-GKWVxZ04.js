import { u as resolveStorePath } from "./paths-D2tVOYHR.js";
import { n as readSessionUpdatedAt, o as updateLastRoute, r as recordSessionMetaFromInbound } from "./store-DOk7wSx2.js";
import "./sessions-XMEnIfWG.js";
import { u as saveMediaBuffer } from "./store-BKnXsQdq.js";
import { r as fetchRemoteMedia } from "./fetch-BjgK6UCg.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-BYWNdpxw.js";
import { a as chunkText, c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, o as chunkTextWithMode, r as chunkMarkdownText, s as resolveChunkMode, t as chunkByNewline } from "./chunk-Cwj1J7Kz.js";
import { t as loadChannelOutboundAdapter } from "./load-CGWONdKL.js";
import { i as resolveAgentRoute, t as buildAgentSessionKey } from "./resolve-route-Wl2GLQR8.js";
import { i as resolveHumanDelayConfig, r as resolveEffectiveMessagesConfig } from "./identity-BHO4vaI4.js";
import { a as createReplyDispatcherWithTyping, c as withReplyDispatcher, o as dispatchReplyFromConfig, s as settleReplyDispatcher } from "./dispatch-DXr9eR2C.js";
import { n as shouldHandleTextCommands } from "./commands-text-routing-DlcyZoi2.js";
import "./commands-registry-Bw0Y7iyN.js";
import { i as matchesMentionWithExplicit, n as buildMentionRegexes, r as matchesMentionPatterns } from "./mentions-DSuVxhvh.js";
import { t as finalizeInboundContext } from "./inbound-context-PrYNGmXv.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher-3rtWChjA.js";
import { i as shouldComputeCommandAuthorized, r as isControlCommandMessage, t as hasControlCommand } from "./command-detection-C_YGtBnK.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope, t as formatAgentEnvelope } from "./envelope-Wzq3Phnk.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-C3qgvRRJ.js";
import { i as shouldAckReaction, n as removeAckReactionAfterReply, r as removeAckReactionHandleAfterReply, t as createAckReactionHandle } from "./ack-reactions-Cz2IryHq.js";
import { t as resolveCommandAuthorizedFromAuthorizers } from "./command-gating-BNobKUab.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "./mention-gating-DFxiuzHe.js";
import { n as setChannelConversationBindingMaxAgeBySessionKey, t as setChannelConversationBindingIdleTimeoutBySessionKey } from "./conversation-bindings-BglpEFU5.js";
import { t as recordInboundSession } from "./session-wVd8d2m3.js";
import { a as runResolvedChannelTurn, i as runPreparedChannelTurn, n as dispatchAssembledChannelTurn, o as buildChannelTurnContext, r as runChannelTurn } from "./kernel-BZLvb-cS.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-0ejdDg51.js";
import { n as recordChannelActivity, t as getChannelActivity } from "./channel-activity-B22YB5W0.js";
import { t as convertMarkdownTables } from "./tables-Nh1Yv6rJ.js";
import { t as buildPairingReply } from "./pairing-messages-CRkCk1s9.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-Ck_jPbH4.js";
import { t as createChannelRuntimeContextRegistry } from "./channel-runtime-contexts-C5kHIEg7.js";
//#region src/plugins/runtime/runtime-channel.ts
function createRuntimeChannel() {
	return {
		text: {
			chunkByNewline,
			chunkMarkdownText,
			chunkMarkdownTextWithMode,
			chunkText,
			chunkTextWithMode,
			resolveChunkMode,
			resolveTextChunkLimit,
			hasControlCommand,
			resolveMarkdownTableMode,
			convertMarkdownTables
		},
		reply: {
			dispatchReplyWithBufferedBlockDispatcher,
			createReplyDispatcherWithTyping,
			resolveEffectiveMessagesConfig,
			resolveHumanDelayConfig,
			dispatchReplyFromConfig,
			withReplyDispatcher,
			settleReplyDispatcher,
			finalizeInboundContext,
			formatAgentEnvelope,
			/** @deprecated Prefer `BodyForAgent` + structured user-context blocks (do not build plaintext envelopes for prompts). */
			formatInboundEnvelope,
			resolveEnvelopeFormatOptions
		},
		routing: {
			buildAgentSessionKey,
			resolveAgentRoute
		},
		pairing: {
			buildPairingReply,
			readAllowFromStore: ({ channel, accountId, env }) => readChannelAllowFromStore(channel, env, accountId),
			upsertPairingRequest: ({ channel, id, accountId, meta, env, pairingAdapter }) => upsertChannelPairingRequest({
				channel,
				id,
				accountId,
				meta,
				env,
				pairingAdapter
			})
		},
		media: {
			fetchRemoteMedia,
			saveMediaBuffer
		},
		activity: {
			record: recordChannelActivity,
			get: getChannelActivity
		},
		session: {
			resolveStorePath,
			readSessionUpdatedAt,
			recordSessionMetaFromInbound,
			recordInboundSession,
			updateLastRoute
		},
		mentions: {
			buildMentionRegexes,
			matchesMentionPatterns,
			matchesMentionWithExplicit,
			implicitMentionKindWhen,
			resolveInboundMentionDecision
		},
		reactions: {
			createAckReactionHandle,
			shouldAckReaction,
			removeAckReactionAfterReply,
			removeAckReactionHandleAfterReply
		},
		groups: {
			resolveGroupPolicy: resolveChannelGroupPolicy,
			resolveRequireMention: resolveChannelGroupRequireMention
		},
		debounce: {
			createInboundDebouncer,
			resolveInboundDebounceMs
		},
		commands: {
			resolveCommandAuthorizedFromAuthorizers,
			isControlCommandMessage,
			shouldComputeCommandAuthorized,
			shouldHandleTextCommands
		},
		outbound: { loadAdapter: loadChannelOutboundAdapter },
		turn: {
			run: runChannelTurn,
			runAssembled: dispatchAssembledChannelTurn,
			runResolved: runResolvedChannelTurn,
			buildContext: buildChannelTurnContext,
			runPrepared: runPreparedChannelTurn,
			dispatchAssembled: dispatchAssembledChannelTurn
		},
		threadBindings: {
			setIdleTimeoutBySessionKey: ({ channelId, targetSessionKey, accountId, idleTimeoutMs }) => setChannelConversationBindingIdleTimeoutBySessionKey({
				channelId,
				targetSessionKey,
				accountId,
				idleTimeoutMs
			}),
			setMaxAgeBySessionKey: ({ channelId, targetSessionKey, accountId, maxAgeMs }) => setChannelConversationBindingMaxAgeBySessionKey({
				channelId,
				targetSessionKey,
				accountId,
				maxAgeMs
			})
		},
		runtimeContexts: createChannelRuntimeContextRegistry()
	};
}
//#endregion
export { createRuntimeChannel as t };
