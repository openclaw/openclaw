import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { r as deliverFormattedTextWithAttachments } from "./reply-payload-CAGPnpze.js";
import "./text-runtime-CEUy8PW0.js";
import { n as resolveControlCommandGate } from "./command-gating-Clp6iiy-.js";
import { t as createChannelReplyPipeline } from "./reply-pipeline-DGuKJPhq.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy, t as GROUP_POLICY_BLOCKED_LABEL } from "./runtime-group-policy-D1_R3CVV.js";
import "./channel-policy-BLtDHk3I.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-BZj0n-ZD.js";
import { n as readStoreAllowFromForDmPolicy, s as resolveEffectiveAllowFromLists } from "./dm-policy-shared-DkWXKZ4l.js";
import "./command-auth-D4AuXr2i.js";
import { m as resolveLoggerBackedRuntime } from "./extension-shared-BmNvhM-Y.js";
import "./channel-message-Bzk-dIXe.js";
import { n as createChannelPairingController } from "./channel-pairing-DX2KqVMh.js";
import { a as resolveIrcRequireMention, f as resolveIrcAllowlistMatch, h as makeIrcMessageId, i as resolveIrcMentionGate, m as connectIrcClient, n as resolveIrcGroupMatch, o as sendMessageIrc, p as buildIrcConnectOptions, r as resolveIrcGroupSenderAllowed, s as isChannelTarget, t as resolveIrcGroupAccessGate, u as normalizeIrcAllowlist, y as resolveIrcAccount } from "./policy-DPI9-Kln.js";
import { t as getIrcRuntime } from "./runtime-CbM_m4Z_.js";
//#region extensions/irc/src/inbound.ts
const CHANNEL_ID = "irc";
const escapeIrcRegexLiteral = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function resolveIrcEffectiveAllowlists(params) {
	const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
		allowFrom: params.configAllowFrom,
		groupAllowFrom: params.configGroupAllowFrom,
		storeAllowFrom: params.storeAllowList,
		dmPolicy: params.dmPolicy,
		groupAllowFromFallbackToAllowFrom: false
	});
	return {
		effectiveAllowFrom,
		effectiveGroupAllowFrom
	};
}
async function deliverIrcReply(params) {
	if (!await deliverFormattedTextWithAttachments({
		payload: params.payload,
		send: async ({ text, replyToId }) => {
			if (params.sendReply) await params.sendReply(params.target, text, replyToId);
			else await sendMessageIrc(params.target, text, {
				cfg: params.cfg,
				accountId: params.accountId,
				replyTo: replyToId
			});
			params.statusSink?.({ lastOutboundAt: Date.now() });
		}
	})) return;
}
async function handleIrcInbound(params) {
	const { message, account, config, runtime, connectedNick, statusSink } = params;
	const core = getIrcRuntime();
	const pairing = createChannelPairingController({
		core,
		channel: CHANNEL_ID,
		accountId: account.accountId
	});
	const rawBody = message.text?.trim() ?? "";
	if (!rawBody) return;
	statusSink?.({ lastInboundAt: message.timestamp });
	const senderDisplay = message.senderHost ? `${message.senderNick}!${message.senderUser ?? "?"}@${message.senderHost}` : message.senderNick;
	const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
	const { groupPolicy, providerMissingFallbackApplied } = resolveAllowlistProviderRuntimeGroupPolicy({
		providerConfigPresent: config.channels?.irc !== void 0,
		groupPolicy: account.config.groupPolicy,
		defaultGroupPolicy
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "irc",
		accountId: account.accountId,
		blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
		log: (message) => runtime.log?.(message)
	});
	const configAllowFrom = normalizeIrcAllowlist(account.config.allowFrom);
	const configGroupAllowFrom = normalizeIrcAllowlist(account.config.groupAllowFrom);
	const storeAllowList = normalizeIrcAllowlist(await readStoreAllowFromForDmPolicy({
		provider: CHANNEL_ID,
		accountId: account.accountId,
		dmPolicy,
		readStore: pairing.readStoreForDmPolicy
	}));
	const groupMatch = resolveIrcGroupMatch({
		groups: account.config.groups,
		target: message.target
	});
	if (message.isGroup) {
		const groupAccess = resolveIrcGroupAccessGate({
			groupPolicy,
			groupMatch
		});
		if (!groupAccess.allowed) {
			runtime.log?.(`irc: drop channel ${message.target} (${groupAccess.reason})`);
			return;
		}
	}
	const directGroupAllowFrom = normalizeIrcAllowlist(groupMatch.groupConfig?.allowFrom);
	const wildcardGroupAllowFrom = normalizeIrcAllowlist(groupMatch.wildcardConfig?.allowFrom);
	const groupAllowFrom = directGroupAllowFrom.length > 0 ? directGroupAllowFrom : wildcardGroupAllowFrom;
	const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveIrcEffectiveAllowlists({
		configAllowFrom,
		configGroupAllowFrom,
		storeAllowList,
		dmPolicy
	});
	const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
		cfg: config,
		surface: CHANNEL_ID
	});
	const useAccessGroups = config.commands?.useAccessGroups !== false;
	const senderAllowedForCommands = resolveIrcAllowlistMatch({
		allowFrom: message.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
		message,
		allowNameMatching
	}).allowed;
	const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config);
	const commandGate = resolveControlCommandGate({
		useAccessGroups,
		authorizers: [{
			configured: (message.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom).length > 0,
			allowed: senderAllowedForCommands
		}],
		allowTextCommands,
		hasControlCommand
	});
	const commandAuthorized = commandGate.commandAuthorized;
	if (message.isGroup) {
		if (!resolveIrcGroupSenderAllowed({
			groupPolicy,
			message,
			outerAllowFrom: effectiveGroupAllowFrom,
			innerAllowFrom: groupAllowFrom,
			allowNameMatching
		})) {
			runtime.log?.(`irc: drop group sender ${senderDisplay} (policy=${groupPolicy})`);
			return;
		}
	} else {
		if (dmPolicy === "disabled") {
			runtime.log?.(`irc: drop DM sender=${senderDisplay} (dmPolicy=disabled)`);
			return;
		}
		if (!resolveIrcAllowlistMatch({
			allowFrom: effectiveAllowFrom,
			message,
			allowNameMatching
		}).allowed) {
			if (dmPolicy === "pairing") await pairing.issueChallenge({
				senderId: normalizeLowercaseStringOrEmpty(senderDisplay),
				senderIdLine: `Your IRC id: ${senderDisplay}`,
				meta: { name: message.senderNick || void 0 },
				sendPairingReply: async (text) => {
					await deliverIrcReply({
						payload: { text },
						cfg: config,
						target: message.senderNick,
						accountId: account.accountId,
						sendReply: params.sendReply,
						statusSink
					});
				},
				onReplyError: (err) => {
					runtime.error?.(`irc: pairing reply failed for ${senderDisplay}: ${String(err)}`);
				}
			});
			runtime.log?.(`irc: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
			return;
		}
	}
	if (message.isGroup && commandGate.shouldBlock) {
		const { logInboundDrop } = await import("./plugin-sdk/channel-inbound.js");
		logInboundDrop({
			log: (line) => runtime.log?.(line),
			channel: CHANNEL_ID,
			reason: "control command (unauthorized)",
			target: senderDisplay
		});
		return;
	}
	const mentionRegexes = core.channel.mentions.buildMentionRegexes(config);
	const mentionNick = connectedNick?.trim() || account.nick;
	const explicitMentionRegex = mentionNick ? new RegExp(`\\b${escapeIrcRegexLiteral(mentionNick)}\\b[:,]?`, "i") : null;
	const wasMentioned = core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes) || (explicitMentionRegex ? explicitMentionRegex.test(rawBody) : false);
	const requireMention = message.isGroup ? resolveIrcRequireMention({
		groupConfig: groupMatch.groupConfig,
		wildcardConfig: groupMatch.wildcardConfig
	}) : false;
	const mentionGate = resolveIrcMentionGate({
		isGroup: message.isGroup,
		requireMention,
		wasMentioned,
		hasControlCommand,
		allowTextCommands,
		commandAuthorized
	});
	if (mentionGate.shouldSkip) {
		runtime.log?.(`irc: drop channel ${message.target} (${mentionGate.reason})`);
		return;
	}
	const peerId = message.isGroup ? message.target : message.senderNick;
	const route = core.channel.routing.resolveAgentRoute({
		cfg: config,
		channel: CHANNEL_ID,
		accountId: account.accountId,
		peer: {
			kind: message.isGroup ? "group" : "direct",
			id: peerId
		}
	});
	const fromLabel = message.isGroup ? message.target : senderDisplay;
	const storePath = core.channel.session.resolveStorePath(config.session?.store, { agentId: route.agentId });
	const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
	const previousTimestamp = core.channel.session.readSessionUpdatedAt({
		storePath,
		sessionKey: route.sessionKey
	});
	const body = core.channel.reply.formatAgentEnvelope({
		channel: "IRC",
		from: fromLabel,
		timestamp: message.timestamp,
		previousTimestamp,
		envelope: envelopeOptions,
		body: rawBody
	});
	const groupSystemPrompt = normalizeOptionalString(groupMatch.groupConfig?.systemPrompt);
	const ctxPayload = core.channel.reply.finalizeInboundContext({
		Body: body,
		RawBody: rawBody,
		CommandBody: rawBody,
		From: message.isGroup ? `irc:channel:${message.target}` : `irc:${senderDisplay}`,
		To: `irc:${peerId}`,
		SessionKey: route.sessionKey,
		AccountId: route.accountId,
		ChatType: message.isGroup ? "group" : "direct",
		ConversationLabel: fromLabel,
		SenderName: message.senderNick || void 0,
		SenderId: senderDisplay,
		GroupSubject: message.isGroup ? message.target : void 0,
		GroupSystemPrompt: message.isGroup ? groupSystemPrompt : void 0,
		Provider: CHANNEL_ID,
		Surface: CHANNEL_ID,
		WasMentioned: message.isGroup ? wasMentioned : void 0,
		MessageSid: message.messageId,
		Timestamp: message.timestamp,
		OriginatingChannel: CHANNEL_ID,
		OriginatingTo: `irc:${peerId}`,
		CommandAuthorized: commandAuthorized
	});
	const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
		cfg: config,
		agentId: route.agentId,
		channel: CHANNEL_ID,
		accountId: account.accountId
	});
	await core.channel.turn.runPrepared({
		channel: CHANNEL_ID,
		accountId: account.accountId,
		routeSessionKey: route.sessionKey,
		storePath,
		ctxPayload,
		recordInboundSession: core.channel.session.recordInboundSession,
		runDispatch: async () => await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
			ctx: ctxPayload,
			cfg: config,
			dispatcherOptions: {
				...replyPipeline,
				deliver: async (payload) => {
					await deliverIrcReply({
						payload,
						cfg: config,
						target: peerId,
						accountId: account.accountId,
						sendReply: params.sendReply,
						statusSink
					});
				},
				onError: (err, info) => {
					runtime.error?.(`irc ${info.kind} reply failed: ${String(err)}`);
				}
			},
			replyOptions: {
				onModelSelected,
				skillFilter: groupMatch.groupConfig?.skills,
				disableBlockStreaming: typeof account.config.blockStreaming === "boolean" ? !account.config.blockStreaming : void 0
			}
		}),
		record: { onRecordError: (err) => {
			runtime.error?.(`irc: failed updating session meta: ${String(err)}`);
		} }
	});
}
//#endregion
//#region extensions/irc/src/monitor.ts
function resolveIrcInboundTarget(params) {
	const rawTarget = params.target;
	if (isChannelTarget(rawTarget)) return {
		isGroup: true,
		target: rawTarget,
		rawTarget
	};
	return {
		isGroup: false,
		target: params.senderNick.trim() || rawTarget,
		rawTarget
	};
}
async function monitorIrcProvider(opts) {
	const core = getIrcRuntime();
	const cfg = opts.config ?? core.config.current();
	const account = resolveIrcAccount({
		cfg,
		accountId: opts.accountId
	});
	const runtime = resolveLoggerBackedRuntime(opts.runtime, core.logging.getChildLogger());
	if (!account.configured) throw new Error(`IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`);
	const logger = core.logging.getChildLogger({
		channel: "irc",
		accountId: account.accountId
	});
	let client = null;
	client = await connectIrcClient(buildIrcConnectOptions(account, {
		channels: account.config.channels,
		abortSignal: opts.abortSignal,
		onLine: (line) => {
			if (core.logging.shouldLogVerbose()) logger.debug?.(`[${account.accountId}] << ${line}`);
		},
		onNotice: (text, target) => {
			if (core.logging.shouldLogVerbose()) logger.debug?.(`[${account.accountId}] notice ${target ?? ""}: ${text}`);
		},
		onError: (error) => {
			logger.error(`[${account.accountId}] IRC error: ${error.message}`);
		},
		onPrivmsg: async (event) => {
			if (!client) return;
			if (normalizeLowercaseStringOrEmpty(event.senderNick) === normalizeLowercaseStringOrEmpty(client.nick)) return;
			const inboundTarget = resolveIrcInboundTarget({
				target: event.target,
				senderNick: event.senderNick
			});
			const message = {
				messageId: makeIrcMessageId(),
				target: inboundTarget.target,
				rawTarget: inboundTarget.rawTarget,
				senderNick: event.senderNick,
				senderUser: event.senderUser,
				senderHost: event.senderHost,
				text: event.text,
				timestamp: Date.now(),
				isGroup: inboundTarget.isGroup
			};
			core.channel.activity.record({
				channel: "irc",
				accountId: account.accountId,
				direction: "inbound",
				at: message.timestamp
			});
			if (opts.onMessage) {
				await opts.onMessage(message, client);
				return;
			}
			await handleIrcInbound({
				message,
				account,
				config: cfg,
				runtime,
				connectedNick: client.nick,
				sendReply: async (target, text) => {
					client?.sendPrivmsg(target, text);
					opts.statusSink?.({ lastOutboundAt: Date.now() });
					core.channel.activity.record({
						channel: "irc",
						accountId: account.accountId,
						direction: "outbound"
					});
				},
				statusSink: opts.statusSink
			});
		}
	}));
	logger.info(`[${account.accountId}] connected to ${account.host}:${account.port}${account.tls ? " (tls)" : ""} as ${client.nick}`);
	return { stop: () => {
		client?.quit("shutdown");
		client = null;
	} };
}
//#endregion
export { monitorIrcProvider, sendMessageIrc };
