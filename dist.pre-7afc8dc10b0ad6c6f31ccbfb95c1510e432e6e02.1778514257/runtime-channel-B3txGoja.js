import { u as resolveStorePath } from "./paths-BnX-evip.js";
import { n as readSessionUpdatedAt, o as updateLastRoute, r as recordSessionMetaFromInbound } from "./store-DjyTbZFp.js";
import "./sessions-DgIxQTHN.js";
import { u as saveMediaBuffer } from "./store-B4S0xbAA.js";
import { r as fetchRemoteMedia } from "./fetch-CcVppDfI.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-DJgcGQu3.js";
import { a as chunkText, c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, o as chunkTextWithMode, r as chunkMarkdownText, s as resolveChunkMode, t as chunkByNewline } from "./chunk-B_CySsI6.js";
import { t as loadChannelOutboundAdapter } from "./load-DdE85if3.js";
import { i as resolveAgentRoute, t as buildAgentSessionKey } from "./resolve-route-B3f0n0oj.js";
import { i as resolveHumanDelayConfig, r as resolveEffectiveMessagesConfig } from "./identity-CuUMUoav.js";
import { a as createReplyDispatcherWithTyping, c as withReplyDispatcher, o as dispatchReplyFromConfig, s as settleReplyDispatcher } from "./dispatch-DqO7pZGl.js";
import { n as shouldHandleTextCommands } from "./commands-text-routing-C7dIThMI.js";
import "./commands-registry-CoRTCP1S.js";
import { i as matchesMentionWithExplicit, n as buildMentionRegexes, r as matchesMentionPatterns } from "./mentions-CkM1hTW0.js";
import { t as finalizeInboundContext } from "./inbound-context-C4rK80S_.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher-B2ae0Njj.js";
import { t as convertMarkdownTables } from "./tables-VJKZtd26.js";
import { i as shouldComputeCommandAuthorized, r as isControlCommandMessage, t as hasControlCommand } from "./command-detection-BIsSbSni.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope, t as formatAgentEnvelope } from "./envelope-CbXsB8K8.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-HY7o7clB.js";
import { i as shouldAckReaction, n as removeAckReactionAfterReply, r as removeAckReactionHandleAfterReply, t as createAckReactionHandle } from "./ack-reactions-B-mxhZsk.js";
import { t as resolveCommandAuthorizedFromAuthorizers } from "./command-gating-CIJ45O2-.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "./mention-gating-l_6-lyMO.js";
import { n as setChannelConversationBindingMaxAgeBySessionKey, t as setChannelConversationBindingIdleTimeoutBySessionKey } from "./conversation-bindings-CdyzbC7Q.js";
import { t as recordInboundSession } from "./session-B1dzm1Dk.js";
import { a as runResolvedChannelTurn, i as runPreparedChannelTurn, n as dispatchAssembledChannelTurn, o as buildChannelTurnContext, r as runChannelTurn } from "./kernel-CokMrRuj.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DdncmC_t.js";
import { n as recordChannelActivity, t as getChannelActivity } from "./channel-activity-DIHw3Wfn.js";
import { t as buildPairingReply } from "./pairing-messages-DroZmsOh.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-hjG6lYPV.js";
import { t as createChannelRuntimeContextRegistry } from "./channel-runtime-contexts-dB83iYF1.js";
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
