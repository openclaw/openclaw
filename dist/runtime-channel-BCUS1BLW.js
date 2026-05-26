import { u as resolveStorePath } from "./paths-kGAxo7MN.js";
import { n as readSessionUpdatedAt, o as updateLastRoute, r as recordSessionMetaFromInbound } from "./store-3qAZ3Zl6.js";
import "./sessions-BhOk6siH.js";
import { a as createReplyDispatcherWithTyping, c as withReplyDispatcher, o as dispatchReplyFromConfig, s as settleReplyDispatcher } from "./dispatch-CvimgVpK.js";
import { u as saveMediaBuffer } from "./store-b792nN7l.js";
import { r as fetchRemoteMedia } from "./fetch-zuIYqxzf.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-DONyxmU9.js";
import { a as chunkText, c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, o as chunkTextWithMode, r as chunkMarkdownText, s as resolveChunkMode, t as chunkByNewline } from "./chunk-CGVwhsnj.js";
import { t as loadChannelOutboundAdapter } from "./load-2C_RdRhW.js";
import { i as resolveAgentRoute, t as buildAgentSessionKey } from "./resolve-route-DQZZzDyD.js";
import { i as resolveHumanDelayConfig, r as resolveEffectiveMessagesConfig } from "./identity-CRZts9Qd.js";
import { n as shouldHandleTextCommands } from "./commands-text-routing-BeJyCrpU.js";
import "./commands-registry-CPSWhUW1.js";
import { i as matchesMentionWithExplicit, n as buildMentionRegexes, r as matchesMentionPatterns } from "./mentions-C1aKJ5EP.js";
import { t as finalizeInboundContext } from "./inbound-context-DC32Bk5a.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher-DQPy-Nwy.js";
import { i as shouldComputeCommandAuthorized, r as isControlCommandMessage, t as hasControlCommand } from "./command-detection-bZlW0Mh2.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope, t as formatAgentEnvelope } from "./envelope-DNto3K3h.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-CCEcGa_J.js";
import { i as shouldAckReaction, n as removeAckReactionAfterReply, r as removeAckReactionHandleAfterReply, t as createAckReactionHandle } from "./ack-reactions-D6S-dTdd.js";
import { t as resolveCommandAuthorizedFromAuthorizers } from "./command-gating-W-KFjDzR.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "./mention-gating-Bq0XC9aB.js";
import { n as setChannelConversationBindingMaxAgeBySessionKey, t as setChannelConversationBindingIdleTimeoutBySessionKey } from "./conversation-bindings-BS8psrBb.js";
import { t as recordInboundSession } from "./session-BGECYHCy.js";
import { a as runResolvedChannelTurn, i as runPreparedChannelTurn, n as dispatchAssembledChannelTurn, o as buildChannelTurnContext, r as runChannelTurn } from "./kernel-5-rDHkvC.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-CCZPL3sp.js";
import { n as recordChannelActivity, t as getChannelActivity } from "./channel-activity-zWUQ9Yny.js";
import { t as convertMarkdownTables } from "./tables-Bk81cN4I.js";
import { t as buildPairingReply } from "./pairing-messages-HbijGONx.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-DKcswb9w.js";
import { t as createChannelRuntimeContextRegistry } from "./channel-runtime-contexts-mtMRBVkJ.js";
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
