import { u as resolveStorePath } from "./paths-CJq5T6t4.js";
import { a as updateLastRoute, n as readSessionUpdatedAt, r as recordSessionMetaFromInbound } from "./store-C0WV070A.js";
import "./sessions-hf7PWp-q.js";
import { l as saveMediaBuffer } from "./store-BhTQkKvz.js";
import { r as fetchRemoteMedia } from "./fetch-Dq0yQNGS.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-8N18KwaE.js";
import { a as chunkText, c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, o as chunkTextWithMode, r as chunkMarkdownText, s as resolveChunkMode, t as chunkByNewline } from "./chunk-DVhbCEt5.js";
import { t as loadChannelOutboundAdapter } from "./load-D_ZHVHK-.js";
import { i as resolveAgentRoute, t as buildAgentSessionKey } from "./resolve-route-Bkg1dQTn.js";
import { i as resolveHumanDelayConfig, r as resolveEffectiveMessagesConfig } from "./identity-lKkG3jFv.js";
import { t as finalizeInboundContext } from "./inbound-context-DuPz1jiT.js";
import { t as convertMarkdownTables } from "./tables-B1LDzewv.js";
import { i as shouldComputeCommandAuthorized, r as isControlCommandMessage, t as hasControlCommand } from "./command-detection-LMD1CkRB.js";
import { n as shouldHandleTextCommands } from "./commands-text-routing-C_gxu6k1.js";
import "./commands-registry-Bm3jh0xy.js";
import { a as createReplyDispatcherWithTyping, c as withReplyDispatcher, o as dispatchReplyFromConfig, s as settleReplyDispatcher } from "./dispatch-DiIqrYyv.js";
import { i as matchesMentionWithExplicit, n as buildMentionRegexes, r as matchesMentionPatterns } from "./mentions-twkEffVW.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope, t as formatAgentEnvelope } from "./envelope-BJMioFxU.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-b8nZYGXt.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher-D9sg1NAk.js";
import { i as shouldAckReaction, n as removeAckReactionAfterReply, r as removeAckReactionHandleAfterReply, t as createAckReactionHandle } from "./ack-reactions-CMnMxK63.js";
import { t as resolveCommandAuthorizedFromAuthorizers } from "./command-gating-BT60r_ii.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "./mention-gating-iDY39sMv.js";
import { n as setChannelConversationBindingMaxAgeBySessionKey, t as setChannelConversationBindingIdleTimeoutBySessionKey } from "./conversation-bindings-CBdLEG_5.js";
import { t as recordInboundSession } from "./session-DiXXaF8K.js";
import { a as buildChannelTurnContext, i as runResolvedChannelTurn, n as runChannelTurn, r as runPreparedChannelTurn, t as dispatchAssembledChannelTurn } from "./kernel-l3pzFTAa.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DnrmZDER.js";
import { n as recordChannelActivity, t as getChannelActivity } from "./channel-activity-2mNrAZrc.js";
import { t as buildPairingReply } from "./pairing-messages-B_aJ3669.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-DFgmKCqc.js";
import { t as createChannelRuntimeContextRegistry } from "./channel-runtime-contexts-myVpcAEE.js";
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
