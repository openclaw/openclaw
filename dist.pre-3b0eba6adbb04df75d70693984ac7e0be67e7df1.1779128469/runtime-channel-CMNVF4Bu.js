import { u as resolveStorePath } from "./paths-_BPRx1WO.js";
import { n as readSessionUpdatedAt, o as updateLastRoute, r as recordSessionMetaFromInbound } from "./store-PGV-10Zw.js";
import "./sessions-PfcW1Bpv.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-CycKiUc2.js";
import { u as saveMediaBuffer } from "./store-C25GuYX2.js";
import { a as saveRemoteMedia, i as readRemoteMediaBuffer, o as saveResponseMedia, r as fetchRemoteMedia } from "./fetch-Da3eL7im.js";
import { i as resolveHumanDelayConfig, r as resolveEffectiveMessagesConfig } from "./identity-DO0zSSTT.js";
import { a as chunkText, c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, o as chunkTextWithMode, r as chunkMarkdownText, s as resolveChunkMode, t as chunkByNewline } from "./chunk-o-kwX4lv.js";
import { t as loadChannelOutboundAdapter } from "./load-BTirG7gd.js";
import { i as resolveAgentRoute, t as buildAgentSessionKey } from "./resolve-route-D-Piirct.js";
import { a as createReplyDispatcherWithTyping, c as withReplyDispatcher, o as dispatchReplyFromConfig, s as settleReplyDispatcher } from "./dispatch-CfHXgvga.js";
import { n as shouldHandleTextCommands } from "./commands-text-routing-ZGJQH9P0.js";
import "./commands-registry-Ch-L_eke.js";
import { i as matchesMentionWithExplicit, n as buildMentionRegexes, r as matchesMentionPatterns } from "./mentions-CGLCNLym.js";
import { t as finalizeInboundContext } from "./inbound-context-C-96VDFl.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher-7s5ojGJD.js";
import { i as shouldComputeCommandAuthorized, r as isControlCommandMessage, t as hasControlCommand } from "./command-detection-IWKRBELP.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope, t as formatAgentEnvelope } from "./envelope-DP4ERcPB.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-ClTOMGii.js";
import { i as shouldAckReaction, n as removeAckReactionAfterReply, r as removeAckReactionHandleAfterReply, t as createAckReactionHandle } from "./ack-reactions-CgMtZTWq.js";
import { t as resolveCommandAuthorizedFromAuthorizers } from "./command-gating-C5hbwrrN.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "./mention-gating-wSXgfIYZ.js";
import { n as setChannelConversationBindingMaxAgeBySessionKey, t as setChannelConversationBindingIdleTimeoutBySessionKey } from "./conversation-bindings-6SBrlNYD.js";
import { t as recordInboundSession } from "./session-DTzeXLjt.js";
import { a as runPreparedChannelTurn, i as runChannelTurn, n as dispatchAssembledChannelTurn, o as runResolvedChannelTurn, s as buildChannelInboundEventContext } from "./kernel-ph6FizdQ.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-Dev9d79A.js";
import { n as recordChannelActivity, t as getChannelActivity } from "./channel-activity-D7nD3rrx.js";
import { t as convertMarkdownTables } from "./tables-Byxyxijp.js";
import { t as buildPairingReply } from "./pairing-messages-Cdkd7jkT.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-OcLE1qWa.js";
import { t as createChannelRuntimeContextRegistry } from "./channel-runtime-contexts-BNI0GeIf.js";
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
			readRemoteMediaBuffer,
			fetchRemoteMedia,
			saveRemoteMedia,
			saveResponseMedia,
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
			buildContext: buildChannelInboundEventContext,
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
