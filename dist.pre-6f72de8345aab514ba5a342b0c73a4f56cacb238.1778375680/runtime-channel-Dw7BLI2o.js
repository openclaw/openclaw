import { u as resolveStorePath } from "./paths-BYkpLqJF.js";
import { n as readSessionUpdatedAt, o as updateLastRoute, r as recordSessionMetaFromInbound } from "./store-bHMyvLAj.js";
import "./sessions-BPwe-yj6.js";
import { u as saveMediaBuffer } from "./store-BdZFEXDq.js";
import { r as fetchRemoteMedia } from "./fetch-Bs6Mlqzj.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-Bt8--O0F.js";
import { a as chunkText, c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, o as chunkTextWithMode, r as chunkMarkdownText, s as resolveChunkMode, t as chunkByNewline } from "./chunk-DNRzZy_M.js";
import { t as loadChannelOutboundAdapter } from "./load-CqV-3E2B.js";
import { i as resolveAgentRoute, t as buildAgentSessionKey } from "./resolve-route-uCNcIVb3.js";
import { i as resolveHumanDelayConfig, r as resolveEffectiveMessagesConfig } from "./identity-Kb0CusYZ.js";
import { a as createReplyDispatcherWithTyping, c as withReplyDispatcher, o as dispatchReplyFromConfig, s as settleReplyDispatcher } from "./dispatch-DFCeRfA8.js";
import { n as shouldHandleTextCommands } from "./commands-text-routing-g7mwYGkz.js";
import "./commands-registry-CkLGAYkA.js";
import { i as matchesMentionWithExplicit, n as buildMentionRegexes, r as matchesMentionPatterns } from "./mentions-DTCSrP4q.js";
import { t as finalizeInboundContext } from "./inbound-context-BemHjyn_.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher-3Lf3gVRQ.js";
import { t as convertMarkdownTables } from "./tables-T6VynNYm.js";
import { i as shouldComputeCommandAuthorized, r as isControlCommandMessage, t as hasControlCommand } from "./command-detection-CcXv0O9N.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope, t as formatAgentEnvelope } from "./envelope-Bx3KlDt1.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-DxG5U5dj.js";
import { i as shouldAckReaction, n as removeAckReactionAfterReply, r as removeAckReactionHandleAfterReply, t as createAckReactionHandle } from "./ack-reactions-QdPPZYm0.js";
import { t as resolveCommandAuthorizedFromAuthorizers } from "./command-gating-PjkImS4N.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "./mention-gating-27Z-Dt8E.js";
import { n as setChannelConversationBindingMaxAgeBySessionKey, t as setChannelConversationBindingIdleTimeoutBySessionKey } from "./conversation-bindings-n7p6HKbB.js";
import { t as recordInboundSession } from "./session-BdBKl4mH.js";
import { a as runPreparedChannelTurn, i as runChannelTurn, o as runResolvedChannelTurn, r as dispatchAssembledChannelTurn, s as buildChannelTurnContext } from "./kernel-lSZnRKxU.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-Cuu3Ejmj.js";
import { n as recordChannelActivity, t as getChannelActivity } from "./channel-activity-D0RW8hcU.js";
import { t as buildPairingReply } from "./pairing-messages-DTpYEWrt.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-DJHIOiD3.js";
import { t as createChannelRuntimeContextRegistry } from "./channel-runtime-contexts-Cu2q2fHD.js";
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
