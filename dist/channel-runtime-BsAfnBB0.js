import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { r as deliverFormattedTextWithAttachments } from "./reply-payload-DMPQsrQC.js";
import { c as defineStableChannelIngressIdentity, n as createChannelIngressResolver, t as channelIngressRoutes } from "./runtime-BUVuto5K.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy, t as GROUP_POLICY_BLOCKED_LABEL } from "./runtime-group-policy-CmZDlIwd.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-jjAiM0PK.js";
import { r as resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope-DF4N8x5q.js";
import { m as resolveLoggerBackedRuntime } from "./extension-shared-DSIp8QS_.js";
import { n as logInboundDrop } from "./logging-Dr3f0mtP.js";
import "./channel-inbound-C7GtKjtG.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import { n as createChannelPairingController } from "./channel-pairing-N4dBc-K-.js";
import { a as isChannelTarget, d as makeIrcMessageId, h as resolveIrcAccount, i as buildIrcAllowlistCandidates, l as buildIrcConnectOptions, n as resolveIrcRequireMention, r as sendMessageIrc, s as normalizeIrcAllowEntry, t as resolveIrcGroupMatch, u as connectIrcClient } from "./policy-1BzrjRjd.js";
import { t as getIrcRuntime } from "./runtime-D93ZFhUB.js";
//#region extensions/irc/src/inbound.ts
const CHANNEL_ID = "irc";
const IRC_NICK_KIND = "plugin:irc-nick";
const ircIngressIdentity = defineStableChannelIngressIdentity({
	key: "irc-id",
	normalizeEntry: normalizeIrcStableEntry,
	normalizeSubject: normalizeLowercaseStringOrEmpty,
	sensitivity: "pii",
	aliases: [...["irc-id-nick-user", "irc-id-nick-host"].map((key) => ({
		key,
		kind: "stable-id",
		normalizeEntry: () => null,
		normalizeSubject: normalizeLowercaseStringOrEmpty,
		sensitivity: "pii"
	})), {
		key: "irc-nick",
		kind: IRC_NICK_KIND,
		normalizeEntry: normalizeIrcNickEntry,
		normalizeSubject: normalizeLowercaseStringOrEmpty,
		dangerous: true,
		sensitivity: "pii"
	}],
	isWildcardEntry: (entry) => normalizeIrcAllowEntry(entry) === "*",
	resolveEntryId: ({ entryIndex, fieldKey }) => `irc-entry-${entryIndex + 1}:${fieldKey === "irc-nick" ? "nick" : "id"}`
});
const escapeIrcRegexLiteral = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function isBareNick(value) {
	return !value.includes("!") && !value.includes("@");
}
function normalizeIrcStableEntry(value) {
	const normalized = normalizeIrcAllowEntry(value);
	if (!normalized || normalized === "*" || isBareNick(normalized)) return null;
	return normalized;
}
function normalizeIrcNickEntry(value) {
	const normalized = normalizeIrcAllowEntry(value);
	if (!normalized || normalized === "*" || !isBareNick(normalized)) return null;
	return normalized;
}
function hasEntries(entries) {
	return normalizeStringEntries(entries).some((entry) => normalizeIrcAllowEntry(entry));
}
function createIrcIngressSubject(message) {
	const stableCandidates = buildIrcAllowlistCandidates(message, { allowNameMatching: true }).filter((candidate) => !isBareNick(candidate));
	const nick = normalizeLowercaseStringOrEmpty(message.senderNick);
	return {
		stableId: stableCandidates[stableCandidates.length - 1] ?? nick,
		aliases: {
			"irc-id-nick-user": stableCandidates.find((candidate) => candidate.includes("!") && !candidate.includes("@")),
			"irc-id-nick-host": stableCandidates.find((candidate) => !candidate.includes("!") && candidate.includes("@")),
			"irc-nick": nick
		}
	};
}
function routeDescriptorsForIrcGroup(params) {
	if (!params.isGroup) return [];
	return channelIngressRoutes(params.groupPolicy === "allowlist" && {
		id: "irc:channel",
		allowed: params.hasConfiguredGroups && params.groupAllowed,
		precedence: 0,
		matchId: "irc-channel",
		blockReason: "channel_not_allowlisted"
	}, !params.groupEnabled && {
		id: "irc:channel-enabled",
		enabled: false,
		precedence: 10,
		blockReason: "channel_disabled"
	}, hasEntries(params.routeGroupAllowFrom) && {
		id: "irc:channel-sender",
		precedence: 20,
		senderPolicy: "replace",
		senderAllowFrom: params.routeGroupAllowFrom
	});
}
async function deliverIrcReply(params) {
	await deliverFormattedTextWithAttachments({
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
	});
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
	const groupMatch = resolveIrcGroupMatch({
		groups: account.config.groups,
		target: message.target
	});
	const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
		cfg: config,
		surface: CHANNEL_ID
	});
	const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config);
	const mentionRegexes = core.channel.mentions.buildMentionRegexes(config);
	const mentionNick = connectedNick?.trim() || account.nick;
	const explicitMentionRegex = mentionNick ? new RegExp(`\\b${escapeIrcRegexLiteral(mentionNick)}\\b[:,]?`, "i") : null;
	const wasMentioned = core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes) || (explicitMentionRegex ? explicitMentionRegex.test(rawBody) : false);
	const requireMention = message.isGroup ? resolveIrcRequireMention({
		groupConfig: groupMatch.groupConfig,
		wildcardConfig: groupMatch.wildcardConfig
	}) : false;
	const routeGroupAllowFrom = normalizeStringEntries(groupMatch.groupConfig?.allowFrom?.length ? groupMatch.groupConfig.allowFrom : groupMatch.wildcardConfig?.allowFrom);
	const accessGroupPolicy = groupPolicy === "open" && (hasEntries(account.config.groupAllowFrom) || hasEntries(routeGroupAllowFrom)) ? "allowlist" : groupPolicy;
	const access = await createChannelIngressResolver({
		channelId: CHANNEL_ID,
		accountId: account.accountId,
		identity: ircIngressIdentity,
		cfg: config,
		readStoreAllowFrom: async () => await pairing.readAllowFromStore()
	}).message({
		subject: createIrcIngressSubject(message),
		conversation: {
			kind: message.isGroup ? "group" : "direct",
			id: message.target
		},
		route: routeDescriptorsForIrcGroup({
			isGroup: message.isGroup,
			groupPolicy,
			groupAllowed: groupMatch.allowed,
			hasConfiguredGroups: groupMatch.hasConfiguredGroups,
			groupEnabled: groupMatch.groupConfig?.enabled !== false && groupMatch.wildcardConfig?.enabled !== false,
			routeGroupAllowFrom
		}),
		mentionFacts: message.isGroup ? {
			canDetectMention: true,
			wasMentioned,
			hasAnyMention: wasMentioned
		} : void 0,
		dmPolicy,
		groupPolicy: accessGroupPolicy,
		policy: {
			groupAllowFromFallbackToAllowFrom: false,
			mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled",
			activation: {
				requireMention: message.isGroup && requireMention,
				allowTextCommands
			}
		},
		allowFrom: account.config.allowFrom,
		groupAllowFrom: account.config.groupAllowFrom,
		command: {
			allowTextCommands,
			hasControlCommand
		}
	});
	const commandAuthorized = access.commandAccess.authorized;
	if (access.ingress.admission === "pairing-required") {
		await pairing.issueChallenge({
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
	if (access.ingress.admission === "skip") {
		runtime.log?.(`irc: drop channel ${message.target} (missing-mention)`);
		return;
	}
	if (access.ingress.admission !== "dispatch") {
		if (message.isGroup && access.ingress.decisiveGateId === "command" && access.commandAccess.shouldBlockControlCommand) {
			logInboundDrop({
				log: (line) => runtime.log?.(line),
				channel: CHANNEL_ID,
				reason: "control command (unauthorized)",
				target: senderDisplay
			});
			return;
		}
		if (message.isGroup) if (access.routeAccess.reason === "channel_not_allowlisted") runtime.log?.(`irc: drop channel ${message.target} (not allowlisted)`);
		else if (access.routeAccess.reason === "channel_disabled") runtime.log?.(`irc: drop channel ${message.target} (disabled)`);
		else runtime.log?.(`irc: drop group sender ${senderDisplay} (policy=${groupPolicy})`);
		else runtime.log?.(`irc: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
		return;
	}
	const peerId = message.isGroup ? message.target : message.senderNick;
	const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
		cfg: config,
		channel: CHANNEL_ID,
		accountId: account.accountId,
		peer: {
			kind: message.isGroup ? "group" : "direct",
			id: peerId
		},
		runtime: core.channel,
		sessionStore: config.session?.store
	});
	const fromLabel = message.isGroup ? message.target : senderDisplay;
	const { storePath, body } = buildEnvelope({
		channel: "IRC",
		from: fromLabel,
		timestamp: message.timestamp,
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
	await core.channel.turn.runAssembled({
		cfg: config,
		channel: CHANNEL_ID,
		accountId: account.accountId,
		agentId: route.agentId,
		routeSessionKey: route.sessionKey,
		storePath,
		ctxPayload,
		recordInboundSession: core.channel.session.recordInboundSession,
		dispatchReplyWithBufferedBlockDispatcher: core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
		delivery: {
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
		replyPipeline: {},
		replyOptions: {
			skillFilter: groupMatch.groupConfig?.skills,
			disableBlockStreaming: typeof account.config.blockStreaming === "boolean" ? !account.config.blockStreaming : void 0
		},
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
