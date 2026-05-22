import { u as resolveStorePath } from "./paths-_BPRx1WO.js";
import { n as readSessionUpdatedAt, o as updateLastRoute, r as recordSessionMetaFromInbound } from "./store-BsgW6uVr.js";
import "./sessions-CIOmZmEg.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-BJb0Jx1G.js";
import { u as saveMediaBuffer } from "./store-BdEF_wzT.js";
import { a as saveRemoteMedia, i as readRemoteMediaBuffer, o as saveResponseMedia, r as fetchRemoteMedia } from "./fetch-CtIyN_Xz.js";
import { i as resolveHumanDelayConfig, r as resolveEffectiveMessagesConfig } from "./identity-ByithkmL.js";
import { a as chunkText, c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, o as chunkTextWithMode, r as chunkMarkdownText, s as resolveChunkMode, t as chunkByNewline } from "./chunk-BuS2YcmM.js";
import { t as loadChannelOutboundAdapter } from "./load-DiwgQYO4.js";
import { i as resolveAgentRoute, t as buildAgentSessionKey } from "./resolve-route-5ymExcwi.js";
import { a as createReplyDispatcherWithTyping, c as withReplyDispatcher, o as dispatchReplyFromConfig, s as settleReplyDispatcher } from "./dispatch-BzAKjxzA.js";
import { n as shouldHandleTextCommands } from "./commands-text-routing-5VzJX_qg.js";
import "./commands-registry-Dn9_nAsp.js";
import { i as matchesMentionWithExplicit, n as buildMentionRegexes, r as matchesMentionPatterns } from "./mentions-ClAI6dmh.js";
import { t as finalizeInboundContext } from "./inbound-context-RlFPWjVe.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher-CwyA5IQr.js";
import { i as shouldComputeCommandAuthorized, r as isControlCommandMessage, t as hasControlCommand } from "./command-detection-DqLC40nl.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope, t as formatAgentEnvelope } from "./envelope-DEIcQSf1.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-vhC-Xrbr.js";
import { i as shouldAckReaction, n as removeAckReactionAfterReply, r as removeAckReactionHandleAfterReply, t as createAckReactionHandle } from "./ack-reactions-DUcrYO1y.js";
import { t as resolveCommandAuthorizedFromAuthorizers } from "./command-gating-CVpVWA6-.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "./mention-gating-Dzk9IT-5.js";
import { n as setChannelConversationBindingMaxAgeBySessionKey, t as setChannelConversationBindingIdleTimeoutBySessionKey } from "./conversation-bindings-ntYkTwc0.js";
import { t as recordInboundSession } from "./session-Sgsz9nZ8.js";
import { a as runPreparedChannelTurn, i as runChannelTurn, n as dispatchAssembledChannelTurn, o as runResolvedChannelTurn, s as buildChannelInboundEventContext } from "./kernel-Bw0goxan.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-C-O6uSoi.js";
import { n as recordChannelActivity, t as getChannelActivity } from "./channel-activity-BQnjDCWI.js";
import { t as convertMarkdownTables } from "./tables-Cx1XMsLP.js";
import { t as buildPairingReply } from "./pairing-messages-0QWLuIX7.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-lJ0onwbJ.js";
import { t as createChannelRuntimeContextRegistry } from "./channel-runtime-contexts-CFwz0tWL.js";
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
