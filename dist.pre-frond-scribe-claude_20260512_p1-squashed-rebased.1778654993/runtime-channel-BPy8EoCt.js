import { u as resolveStorePath } from "./paths-B3IZXng3.js";
import { n as readSessionUpdatedAt, o as updateLastRoute, r as recordSessionMetaFromInbound } from "./store-Dn6p-fz_.js";
import "./sessions-CaK_EJUM.js";
import { u as saveMediaBuffer } from "./store-CMDlTGZ-.js";
import { r as fetchRemoteMedia } from "./fetch-z8qFy6I6.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-Di2ksX-X.js";
import { a as chunkText, c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, o as chunkTextWithMode, r as chunkMarkdownText, s as resolveChunkMode, t as chunkByNewline } from "./chunk-CVo5aUOt.js";
import { t as loadChannelOutboundAdapter } from "./load-DgT-8rZH.js";
import { i as resolveAgentRoute, t as buildAgentSessionKey } from "./resolve-route-_9VOy7HK.js";
import { i as resolveHumanDelayConfig, r as resolveEffectiveMessagesConfig } from "./identity-DHXLdIz3.js";
import { a as createReplyDispatcherWithTyping, c as withReplyDispatcher, o as dispatchReplyFromConfig, s as settleReplyDispatcher } from "./dispatch-Cfv0JGnG.js";
import { n as shouldHandleTextCommands } from "./commands-text-routing-C_zGmmKf.js";
import "./commands-registry-Cjd1Byru.js";
import { i as matchesMentionWithExplicit, n as buildMentionRegexes, r as matchesMentionPatterns } from "./mentions-Z5qZrdeH.js";
import { t as finalizeInboundContext } from "./inbound-context-D88Oby0c.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher-D6FDNG-M.js";
import { i as shouldComputeCommandAuthorized, r as isControlCommandMessage, t as hasControlCommand } from "./command-detection-CbwOxntJ.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope, t as formatAgentEnvelope } from "./envelope-ChW7_JdU.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-B_5Bfp9J.js";
import { i as shouldAckReaction, n as removeAckReactionAfterReply, r as removeAckReactionHandleAfterReply, t as createAckReactionHandle } from "./ack-reactions-CN6tf_Fl.js";
import { t as resolveCommandAuthorizedFromAuthorizers } from "./command-gating-Bcq03LED.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "./mention-gating-BYeneFQd.js";
import { n as setChannelConversationBindingMaxAgeBySessionKey, t as setChannelConversationBindingIdleTimeoutBySessionKey } from "./conversation-bindings-DhTNmBgA.js";
import { t as recordInboundSession } from "./session-CRcoQBFH.js";
import { a as runResolvedChannelTurn, i as runPreparedChannelTurn, n as dispatchAssembledChannelTurn, o as buildChannelTurnContext, r as runChannelTurn } from "./kernel-DeohMOkK.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-haWSROdU.js";
import { n as recordChannelActivity, t as getChannelActivity } from "./channel-activity-D9vDVJu1.js";
import { t as convertMarkdownTables } from "./tables-o4c5CUUm.js";
import { t as buildPairingReply } from "./pairing-messages-BcwZVXK2.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-qjmvsU_d.js";
import { t as createChannelRuntimeContextRegistry } from "./channel-runtime-contexts-N5VaPvak.js";
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
