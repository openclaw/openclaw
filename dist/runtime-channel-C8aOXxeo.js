import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { a as readSessionUpdatedAt, l as updateLastRoute, o as recordSessionMetaFromInbound } from "./store-BmtchQvp.js";
import "./sessions-CQHHcgC_.js";
import { a as settleReplyDispatcher, i as dispatchReplyFromConfig, o as withReplyDispatcher } from "./dispatch-cQjCJvZr.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-sKF5rlUN.js";
import { i as resolveAgentRoute, t as buildAgentSessionKey } from "./resolve-route-C8IahAyG.js";
import { t as resolveCommandAuthorizedFromAuthorizers } from "./command-gating-BZR3snoF.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-jPMfFWFn.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "./mention-gating-3P8aSD7o.js";
import { u as saveMediaBuffer } from "./store-rQFzzX5P.js";
import { a as saveRemoteMedia, i as readRemoteMediaBuffer, o as saveResponseMedia, r as fetchRemoteMedia } from "./fetch-C0wRQZuz.js";
import { i as resolveHumanDelayConfig, r as resolveEffectiveMessagesConfig } from "./identity-nYw-h8DL.js";
import { a as chunkText, c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, o as chunkTextWithMode, r as chunkMarkdownText, s as resolveChunkMode, t as chunkByNewline } from "./chunk-IIklKK4Y.js";
import { t as loadChannelOutboundAdapter } from "./load-CvxrRePI.js";
import { n as shouldHandleTextCommands } from "./commands-text-routing-C2SuW22t.js";
import "./commands-registry-Bthd8JBl.js";
import { i as matchesMentionWithExplicit, n as buildMentionRegexes, r as matchesMentionPatterns } from "./mentions-DmNrCnsQ.js";
import { n as createReplyDispatcherWithTyping } from "./reply-dispatcher-DPt1UxjJ.js";
import { t as finalizeInboundContext } from "./inbound-context-Cg0uCtqQ.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher-1HiDGh16.js";
import { i as shouldComputeCommandAuthorized, r as isControlCommandMessage, t as hasControlCommand } from "./command-detection-CC0FOFv2.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope, t as formatAgentEnvelope } from "./envelope-DUI2KFD9.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-DQpLvByk.js";
import { i as shouldAckReaction, n as removeAckReactionAfterReply, r as removeAckReactionHandleAfterReply, t as createAckReactionHandle } from "./ack-reactions-BceP3SaE.js";
import { n as setChannelConversationBindingMaxAgeBySessionKey, t as setChannelConversationBindingIdleTimeoutBySessionKey } from "./conversation-bindings-ByEqopTS.js";
import { t as recordInboundSession } from "./session-CCAfHrW1.js";
import { a as runPreparedChannelTurn, i as runChannelTurn, n as dispatchAssembledChannelTurn, o as runResolvedChannelTurn, s as buildChannelInboundEventContext } from "./kernel-BXIm_f4L.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DCRkoyVz.js";
import { n as recordChannelActivity, t as getChannelActivity } from "./channel-activity-eMQlJ3BE.js";
import { t as convertMarkdownTables } from "./tables-D3y68tNR.js";
import { t as buildPairingReply } from "./pairing-messages-C64s5W1x.js";
import { t as createChannelRuntimeContextRegistry } from "./channel-runtime-contexts-DtgjL6nA.js";
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
