import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { t as KeyedAsyncQueue } from "./keyed-async-queue-CBv-Vhmc.js";
import { i as deliverTextOrMediaReply, m as resolveSendableOutboundReplyParts } from "./reply-payload-DMPQsrQC.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "./mention-gating-3P8aSD7o.js";
import { o as resolveStableChannelMessageIngress } from "./runtime-BUVuto5K.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "./runtime-group-policy-CmZDlIwd.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./core-kXuNbs5U.js";
import "./history-BD_TtuvO.js";
import { t as createChannelHistoryWindow } from "./history-window-Gy0CzEef.js";
import { f as summarizeMapping, u as mergeAllowlist } from "./allow-from-CvE3rvhy.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-jjAiM0PK.js";
import "./reply-history-Dd_Mx-HZ.js";
import { o as createDeferred } from "./extension-shared-DSIp8QS_.js";
import "./channel-inbound-C7GtKjtG.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import { n as createChannelPairingController } from "./channel-pairing-N4dBc-K-.js";
import { c as isZalouserGroupEntryAllowed, i as resolveZalouserMessageSid, o as buildZalouserGroupCandidates, r as formatZalouserMessageSidFull, s as findZalouserGroupEntry, t as getZalouserRuntime } from "./runtime-lnIj-JW9.js";
import { o as listZaloGroups, r as listZaloFriends, u as resolveZaloGroupContext, v as startZaloListener } from "./zalo-js-DWwYy3d3.js";
import { i as sendMessageZalouser, o as sendSeenZalouser, s as sendTypingZalouser, t as sendDeliveredZalouser } from "./send-sxoudwn5.js";
//#region extensions/zalouser/src/monitor.ts
const ZALOUSER_TEXT_LIMIT = 2e3;
function buildNameIndex(items, nameFn) {
	const index = /* @__PURE__ */ new Map();
	for (const item of items) {
		const name = normalizeOptionalLowercaseString(nameFn(item));
		if (!name) continue;
		const list = index.get(name) ?? [];
		list.push(item);
		index.set(name, list);
	}
	return index;
}
function resolveUserAllowlistEntries(entries, byName) {
	const additions = [];
	const mapping = [];
	const unresolved = [];
	for (const entry of entries) {
		if (/^\d+$/.test(entry)) {
			additions.push(entry);
			continue;
		}
		const id = (byName.get(normalizeLowercaseStringOrEmpty(entry)) ?? [])[0]?.userId;
		if (id) {
			additions.push(id);
			mapping.push(`${entry}->${id}`);
		} else unresolved.push(entry);
	}
	return {
		additions,
		mapping,
		unresolved
	};
}
function normalizeZalouserAllowEntry(entry) {
	return entry.replace(/^(zalouser|zlu):/i, "").trim();
}
function normalizeZalouserSender(value) {
	return normalizeOptionalLowercaseString(normalizeZalouserAllowEntry(value)) || null;
}
function resolveInboundQueueKey(message) {
	const threadId = message.threadId?.trim() || "unknown";
	if (message.isGroup) return `group:${threadId}`;
	return `direct:${message.senderId?.trim() || threadId}`;
}
function resolveZalouserDmSessionScope(config) {
	const configured = config.session?.dmScope;
	return configured === "main" || !configured ? "per-channel-peer" : configured;
}
function resolveZalouserRouteAccess(params) {
	if (params.groupPolicy === "disabled") return {
		allowed: false,
		reason: "disabled"
	};
	if (params.matched && params.enabled === false) return {
		allowed: false,
		reason: "route_disabled"
	};
	if (params.groupPolicy !== "allowlist") return { allowed: true };
	if (!params.configured) return {
		allowed: false,
		reason: "empty_allowlist"
	};
	return params.matched ? { allowed: true } : {
		allowed: false,
		reason: "route_not_allowlisted"
	};
}
function senderScopedZalouserGroupPolicy(params) {
	if (params.groupPolicy === "disabled") return "disabled";
	return params.groupAllowFrom.length > 0 ? "allowlist" : "open";
}
function resolveZalouserInboundSessionKey(params) {
	if (params.isGroup) return params.route.sessionKey;
	const directSessionKey = normalizeLowercaseStringOrEmpty(params.core.channel.routing.buildAgentSessionKey({
		agentId: params.route.agentId,
		channel: "zalouser",
		accountId: params.route.accountId,
		peer: {
			kind: "direct",
			id: params.senderId
		},
		dmScope: resolveZalouserDmSessionScope(params.config),
		identityLinks: params.config.session?.identityLinks
	}));
	const legacySessionKey = normalizeLowercaseStringOrEmpty(params.core.channel.routing.buildAgentSessionKey({
		agentId: params.route.agentId,
		channel: "zalouser",
		accountId: params.route.accountId,
		peer: {
			kind: "group",
			id: params.senderId
		}
	}));
	const hasDirectSession = params.core.channel.session.readSessionUpdatedAt({
		storePath: params.storePath,
		sessionKey: directSessionKey
	}) !== void 0;
	return params.core.channel.session.readSessionUpdatedAt({
		storePath: params.storePath,
		sessionKey: legacySessionKey
	}) !== void 0 && !hasDirectSession ? legacySessionKey : directSessionKey;
}
function logVerbose(core, runtime, message) {
	if (core.logging.shouldLogVerbose()) runtime.log(`[zalouser] ${message}`);
}
function resolveGroupRequireMention(params) {
	const entry = findZalouserGroupEntry(params.groups ?? {}, buildZalouserGroupCandidates({
		groupId: params.groupId,
		groupName: params.groupName,
		includeGroupIdAlias: true,
		includeWildcard: true,
		allowNameMatching: params.allowNameMatching
	}));
	if (typeof entry?.requireMention === "boolean") return entry.requireMention;
	return true;
}
async function sendZalouserDeliveryAcks(params) {
	await sendDeliveredZalouser({
		profile: params.profile,
		isGroup: params.isGroup,
		message: params.message,
		isSeen: true
	});
	await sendSeenZalouser({
		profile: params.profile,
		isGroup: params.isGroup,
		message: params.message
	});
}
async function processMessage(message, account, config, core, runtime, historyState, statusSink) {
	const pairing = createChannelPairingController({
		core,
		channel: "zalouser",
		accountId: account.accountId
	});
	const rawBody = message.content?.trim();
	if (!rawBody) return;
	const commandBody = message.commandContent?.trim() || rawBody;
	const isGroup = message.isGroup;
	const chatId = message.threadId;
	const senderId = message.senderId?.trim();
	if (!senderId) {
		logVerbose(core, runtime, `zalouser: drop message ${chatId} (missing senderId)`);
		return;
	}
	const senderName = message.senderName ?? "";
	const configuredGroupName = message.groupName?.trim() || "";
	const groupContext = isGroup && !configuredGroupName ? await resolveZaloGroupContext(account.profile, chatId).catch((err) => {
		logVerbose(core, runtime, `zalouser: group context lookup failed for ${chatId}: ${String(err)}`);
		return null;
	}) : null;
	const groupName = configuredGroupName || groupContext?.name?.trim() || "";
	const groupMembers = groupContext?.members?.slice(0, 20).join(", ") || void 0;
	if (message.eventMessage) try {
		await sendZalouserDeliveryAcks({
			profile: account.profile,
			isGroup,
			message: message.eventMessage
		});
	} catch (err) {
		logVerbose(core, runtime, `zalouser: delivery/seen ack failed for ${chatId}: ${String(err)}`);
	}
	const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
	const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: config.channels?.zalouser !== void 0,
		groupPolicy: account.config.groupPolicy,
		defaultGroupPolicy
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "zalouser",
		accountId: account.accountId,
		log: (entry) => logVerbose(core, runtime, entry)
	});
	const groups = account.config.groups ?? {};
	const routeAllowlistConfigured = Object.keys(groups).length > 0;
	const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
	if (isGroup) {
		const groupEntry = findZalouserGroupEntry(groups, buildZalouserGroupCandidates({
			groupId: chatId,
			groupName,
			includeGroupIdAlias: true,
			includeWildcard: true,
			allowNameMatching
		}));
		const routeAccess = resolveZalouserRouteAccess({
			groupPolicy,
			configured: routeAllowlistConfigured,
			matched: Boolean(groupEntry),
			enabled: isZalouserGroupEntryAllowed(groupEntry)
		});
		if (!routeAccess.allowed) {
			if (routeAccess.reason === "disabled") logVerbose(core, runtime, `zalouser: drop group ${chatId} (groupPolicy=disabled)`);
			else if (routeAccess.reason === "empty_allowlist") logVerbose(core, runtime, `zalouser: drop group ${chatId} (groupPolicy=allowlist, no allowlist)`);
			else if (routeAccess.reason === "route_not_allowlisted") logVerbose(core, runtime, `zalouser: drop group ${chatId} (not allowlisted)`);
			else if (routeAccess.reason === "route_disabled") logVerbose(core, runtime, `zalouser: drop group ${chatId} (group disabled)`);
			return;
		}
	}
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const configAllowFrom = normalizeStringEntries(account.config.allowFrom);
	const configGroupAllowFrom = normalizeStringEntries(account.config.groupAllowFrom);
	const senderGroupPolicy = routeAllowlistConfigured && configGroupAllowFrom.length === 0 ? groupPolicy : senderScopedZalouserGroupPolicy({
		groupPolicy,
		groupAllowFrom: configGroupAllowFrom
	});
	const shouldComputeCommandAuth = core.channel.commands.shouldComputeCommandAuthorized(commandBody, config);
	const accessDecision = await resolveStableChannelMessageIngress({
		channelId: "zalouser",
		accountId: account.accountId,
		identity: {
			normalize: normalizeZalouserSender,
			sensitivity: "pii",
			entryIdPrefix: "zalouser-entry"
		},
		cfg: config,
		readStoreAllowFrom: async () => await pairing.readAllowFromStore(),
		subject: { stableId: senderId },
		conversation: {
			kind: isGroup ? "group" : "direct",
			id: isGroup ? "group" : senderId
		},
		dmPolicy,
		groupPolicy: senderGroupPolicy,
		policy: { groupAllowFromFallbackToAllowFrom: false },
		allowFrom: configAllowFrom,
		groupAllowFrom: configGroupAllowFrom,
		command: shouldComputeCommandAuth ? {
			directGroupAllowFrom: "effective",
			commandGroupAllowFromFallbackToAllowFrom: true
		} : void 0
	});
	if (isGroup && accessDecision.senderAccess.decision !== "allow") {
		if (accessDecision.senderAccess.reasonCode === "group_policy_empty_allowlist") logVerbose(core, runtime, "Blocked zalouser group message (no group allowlist)");
		else if (accessDecision.senderAccess.reasonCode === "group_policy_not_allowlisted") logVerbose(core, runtime, `Blocked zalouser sender ${senderId} (not in groupAllowFrom/allowFrom)`);
		return;
	}
	if (!isGroup && accessDecision.senderAccess.decision !== "allow") {
		if (accessDecision.senderAccess.decision === "pairing") {
			await pairing.issueChallenge({
				senderId,
				senderIdLine: `Your Zalo user id: ${senderId}`,
				meta: { name: senderName || void 0 },
				onCreated: () => {
					logVerbose(core, runtime, `zalouser pairing request sender=${senderId}`);
				},
				sendPairingReply: async (text) => {
					await sendMessageZalouser(chatId, text, { profile: account.profile });
					statusSink?.({ lastOutboundAt: Date.now() });
				},
				onReplyError: (err) => {
					logVerbose(core, runtime, `zalouser pairing reply failed for ${senderId}: ${String(err)}`);
				}
			});
			return;
		}
		if (accessDecision.senderAccess.reasonCode === "dm_policy_disabled") logVerbose(core, runtime, `Blocked zalouser DM from ${senderId} (dmPolicy=disabled)`);
		else logVerbose(core, runtime, `Blocked unauthorized zalouser sender ${senderId} (dmPolicy=${dmPolicy})`);
		return;
	}
	const commandAuthorized = accessDecision.commandAccess.requested ? accessDecision.commandAccess.authorized : void 0;
	const hasControlCommand = core.channel.commands.isControlCommandMessage(commandBody, config);
	if (isGroup && hasControlCommand && commandAuthorized !== true) {
		logVerbose(core, runtime, `zalouser: drop control command from unauthorized sender ${senderId}`);
		return;
	}
	const peer = isGroup ? {
		kind: "group",
		id: chatId
	} : {
		kind: "direct",
		id: senderId
	};
	const route = core.channel.routing.resolveAgentRoute({
		cfg: config,
		channel: "zalouser",
		accountId: account.accountId,
		peer: {
			kind: peer.kind,
			id: peer.id
		}
	});
	const historyKey = isGroup ? route.sessionKey : void 0;
	const channelHistory = createChannelHistoryWindow({ historyMap: historyState.groupHistories });
	const requireMention = isGroup ? resolveGroupRequireMention({
		groupId: chatId,
		groupName,
		groups,
		allowNameMatching
	}) : false;
	const mentionRegexes = core.channel.mentions.buildMentionRegexes(config, route.agentId);
	const explicitMention = {
		hasAnyMention: message.hasAnyMention === true,
		isExplicitlyMentioned: message.wasExplicitlyMentioned === true,
		canResolveExplicit: message.canResolveExplicitMention === true
	};
	const wasMentioned = isGroup ? core.channel.mentions.matchesMentionWithExplicit({
		text: rawBody,
		mentionRegexes,
		explicit: explicitMention
	}) : true;
	const canDetectMention = mentionRegexes.length > 0 || explicitMention.canResolveExplicit;
	const mentionDecision = resolveInboundMentionDecision({
		facts: {
			canDetectMention,
			wasMentioned,
			hasAnyMention: explicitMention.hasAnyMention,
			implicitMentionKinds: implicitMentionKindWhen("quoted_bot", message.implicitMention === true)
		},
		policy: {
			isGroup,
			requireMention,
			allowTextCommands: core.channel.commands.shouldHandleTextCommands({
				cfg: config,
				surface: "zalouser"
			}),
			hasControlCommand,
			commandAuthorized: commandAuthorized === true
		}
	});
	if (isGroup && requireMention && !canDetectMention && !mentionDecision.effectiveWasMentioned) {
		runtime.error?.(`[${account.accountId}] zalouser mention required but detection unavailable (missing mention regexes and bot self id); dropping group ${chatId}`);
		return;
	}
	if (isGroup && mentionDecision.shouldSkip) {
		channelHistory.record({
			historyKey: historyKey ?? "",
			limit: historyState.historyLimit,
			entry: historyKey && rawBody ? {
				sender: senderName || senderId,
				body: rawBody,
				timestamp: message.timestampMs,
				messageId: resolveZalouserMessageSid({
					msgId: message.msgId,
					cliMsgId: message.cliMsgId,
					fallback: `${message.timestampMs}`
				})
			} : null
		});
		logVerbose(core, runtime, `zalouser: skip group ${chatId} (mention required, not mentioned)`);
		return;
	}
	const fromLabel = isGroup ? groupName || `group:${chatId}` : senderName || `user:${senderId}`;
	const storePath = core.channel.session.resolveStorePath(config.session?.store, { agentId: route.agentId });
	const inboundSessionKey = resolveZalouserInboundSessionKey({
		core,
		config,
		route,
		storePath,
		isGroup,
		senderId
	});
	const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
	const previousTimestamp = core.channel.session.readSessionUpdatedAt({
		storePath,
		sessionKey: inboundSessionKey
	});
	const body = core.channel.reply.formatAgentEnvelope({
		channel: "Zalo Personal",
		from: fromLabel,
		timestamp: message.timestampMs,
		previousTimestamp,
		envelope: envelopeOptions,
		body: rawBody
	});
	const combinedBody = isGroup && historyKey ? channelHistory.buildPendingContext({
		historyKey,
		limit: historyState.historyLimit,
		currentMessage: body,
		formatEntry: (entry) => core.channel.reply.formatAgentEnvelope({
			channel: "Zalo Personal",
			from: fromLabel,
			timestamp: entry.timestamp,
			envelope: envelopeOptions,
			body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`
		})
	}) : body;
	const inboundHistory = isGroup && historyKey && historyState.historyLimit > 0 ? channelHistory.buildInboundHistory({
		historyKey,
		limit: historyState.historyLimit
	}) : void 0;
	const normalizedTo = isGroup ? `zalouser:group:${chatId}` : `zalouser:${chatId}`;
	const messageSid = resolveZalouserMessageSid({
		msgId: message.msgId,
		cliMsgId: message.cliMsgId,
		fallback: `${message.timestampMs}`
	});
	const messageSidFull = formatZalouserMessageSidFull({
		msgId: message.msgId,
		cliMsgId: message.cliMsgId
	});
	const ctxPayload = core.channel.turn.buildContext({
		channel: "zalouser",
		accountId: route.accountId,
		messageId: messageSid,
		messageIdFull: messageSidFull,
		timestamp: message.timestampMs,
		from: isGroup ? `zalouser:group:${chatId}` : `zalouser:${senderId}`,
		sender: {
			id: senderId,
			name: senderName || void 0
		},
		conversation: {
			kind: isGroup ? "group" : "direct",
			id: chatId,
			label: fromLabel,
			routePeer: {
				kind: isGroup ? "group" : "direct",
				id: chatId
			}
		},
		route: {
			agentId: route.agentId,
			accountId: route.accountId,
			routeSessionKey: route.sessionKey,
			dispatchSessionKey: inboundSessionKey
		},
		reply: {
			to: normalizedTo,
			originatingTo: normalizedTo
		},
		message: {
			body: combinedBody,
			bodyForAgent: rawBody,
			rawBody,
			commandBody,
			inboundHistory,
			envelopeFrom: fromLabel
		},
		extra: {
			BodyForCommands: commandBody,
			GroupSubject: isGroup ? groupName || void 0 : void 0,
			GroupChannel: isGroup ? groupName || void 0 : void 0,
			GroupMembers: isGroup ? groupMembers : void 0,
			WasMentioned: isGroup ? mentionDecision.effectiveWasMentioned : void 0,
			CommandAuthorized: commandAuthorized
		}
	});
	await core.channel.turn.runAssembled({
		channel: "zalouser",
		accountId: account.accountId,
		cfg: config,
		agentId: route.agentId,
		routeSessionKey: route.sessionKey,
		storePath,
		ctxPayload,
		recordInboundSession: core.channel.session.recordInboundSession,
		dispatchReplyWithBufferedBlockDispatcher: core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
		delivery: {
			preparePayload: (payload) => {
				if (payload.text === void 0) return payload;
				return {
					...payload,
					text: core.channel.text.convertMarkdownTables(payload.text, core.channel.text.resolveMarkdownTableMode({
						cfg: config,
						channel: "zalouser",
						accountId: account.accountId
					}))
				};
			},
			durable: () => ({ to: normalizedTo }),
			deliver: async (payload) => {
				return await deliverZalouserReply({
					payload,
					profile: account.profile,
					chatId,
					isGroup,
					runtime,
					core,
					config,
					accountId: account.accountId,
					tableMode: "off"
				});
			},
			onDelivered: (_payload, _info, result) => {
				if (result?.visibleReplySent !== false) statusSink?.({ lastOutboundAt: Date.now() });
			},
			onError: (err, info) => {
				runtime.error(`[${account.accountId}] Zalouser ${info.kind} reply failed: ${String(err)}`);
			}
		},
		replyPipeline: { typing: {
			start: async () => {
				await sendTypingZalouser(chatId, {
					profile: account.profile,
					isGroup
				});
			},
			onStartError: (err) => {
				runtime.error?.(`[${account.accountId}] zalouser typing start failed for ${chatId}: ${String(err)}`);
				logVerbose(core, runtime, `zalouser typing failed for ${chatId}: ${String(err)}`);
			}
		} },
		record: { onRecordError: (err) => {
			runtime.error?.(`zalouser: failed updating session meta: ${String(err)}`);
		} }
	});
	if (isGroup && historyKey) channelHistory.clear({
		historyKey,
		limit: historyState.historyLimit
	});
}
async function deliverZalouserReply(params) {
	const { payload, profile, chatId, isGroup, runtime, core, config, accountId } = params;
	const tableMode = params.tableMode ?? "code";
	let visibleReplySent = false;
	const reply = resolveSendableOutboundReplyParts(payload, { text: core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode) });
	const chunkMode = core.channel.text.resolveChunkMode(config, "zalouser", accountId);
	const textChunkLimit = core.channel.text.resolveTextChunkLimit(config, "zalouser", accountId, { fallbackLimit: ZALOUSER_TEXT_LIMIT });
	await deliverTextOrMediaReply({
		payload,
		text: reply.text,
		sendText: async (chunk) => {
			try {
				await sendMessageZalouser(chatId, chunk, {
					profile,
					isGroup,
					textMode: "markdown",
					textChunkMode: chunkMode,
					textChunkLimit
				});
				visibleReplySent = true;
			} catch (err) {
				runtime.error(`Zalouser message send failed: ${String(err)}`);
			}
		},
		sendMedia: async ({ mediaUrl, caption }) => {
			logVerbose(core, runtime, `Sending media to ${chatId}`);
			await sendMessageZalouser(chatId, caption ?? "", {
				profile,
				mediaUrl,
				isGroup,
				textMode: "markdown",
				textChunkMode: chunkMode,
				textChunkLimit
			});
			visibleReplySent = true;
		},
		onMediaError: (error) => {
			runtime.error(`Zalouser media send failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
		}
	});
	return { visibleReplySent };
}
async function monitorZalouserProvider(options) {
	let { account, config } = options;
	const { abortSignal, statusSink, runtime } = options;
	const core = getZalouserRuntime();
	const inboundQueue = new KeyedAsyncQueue();
	const historyLimit = Math.max(0, account.config.historyLimit ?? config.messages?.groupChat?.historyLimit ?? 50);
	const groupHistories = /* @__PURE__ */ new Map();
	try {
		const profile = account.profile;
		const allowFromEntries = (account.config.allowFrom ?? []).map((entry) => normalizeZalouserAllowEntry(String(entry))).filter((entry) => entry && entry !== "*");
		const groupAllowFromEntries = (account.config.groupAllowFrom ?? []).map((entry) => normalizeZalouserAllowEntry(String(entry))).filter((entry) => entry && entry !== "*");
		const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
		if (allowNameMatching && (allowFromEntries.length > 0 || groupAllowFromEntries.length > 0)) {
			const byName = buildNameIndex(await listZaloFriends(profile), (friend) => friend.displayName);
			if (allowFromEntries.length > 0) {
				const { additions, mapping, unresolved } = resolveUserAllowlistEntries(allowFromEntries, byName);
				const allowFrom = mergeAllowlist({
					existing: account.config.allowFrom,
					additions
				});
				account = {
					...account,
					config: {
						...account.config,
						allowFrom
					}
				};
				summarizeMapping("zalouser users", mapping, unresolved, runtime);
			}
			if (groupAllowFromEntries.length > 0) {
				const { additions, mapping, unresolved } = resolveUserAllowlistEntries(groupAllowFromEntries, byName);
				const groupAllowFrom = mergeAllowlist({
					existing: account.config.groupAllowFrom,
					additions
				});
				account = {
					...account,
					config: {
						...account.config,
						groupAllowFrom
					}
				};
				summarizeMapping("zalouser group users", mapping, unresolved, runtime);
			}
		}
		const groupsConfig = account.config.groups ?? {};
		const groupKeys = Object.keys(groupsConfig).filter((key) => key !== "*");
		if (allowNameMatching && groupKeys.length > 0) {
			const byName = buildNameIndex(await listZaloGroups(profile), (group) => group.name);
			const mapping = [];
			const unresolved = [];
			const nextGroups = { ...groupsConfig };
			for (const entry of groupKeys) {
				const cleaned = normalizeZalouserAllowEntry(entry);
				if (/^\d+$/.test(cleaned)) {
					if (!nextGroups[cleaned]) nextGroups[cleaned] = groupsConfig[entry];
					mapping.push(`${entry}→${cleaned}`);
					continue;
				}
				const id = (byName.get(normalizeLowercaseStringOrEmpty(cleaned)) ?? [])[0]?.groupId;
				if (id) {
					if (!nextGroups[id]) nextGroups[id] = groupsConfig[entry];
					mapping.push(`${entry}→${id}`);
				} else unresolved.push(entry);
			}
			account = {
				...account,
				config: {
					...account.config,
					groups: nextGroups
				}
			};
			summarizeMapping("zalouser groups", mapping, unresolved, runtime);
		}
	} catch (err) {
		runtime.log?.(`zalouser resolve failed; using config entries. ${String(err)}`);
	}
	let listenerStop = null;
	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		listenerStop?.();
		listenerStop = null;
	};
	let settled = false;
	const { promise: waitForExit, resolve: resolveRun, reject: rejectRun } = createDeferred();
	const settleSuccess = () => {
		if (settled) return;
		settled = true;
		stop();
		resolveRun();
	};
	const settleFailure = (error) => {
		if (settled) return;
		settled = true;
		stop();
		rejectRun(error instanceof Error ? error : new Error(String(error)));
	};
	const onAbort = () => {
		settleSuccess();
	};
	abortSignal.addEventListener("abort", onAbort, { once: true });
	let listener;
	try {
		listener = await startZaloListener({
			accountId: account.accountId,
			profile: account.profile,
			abortSignal,
			onMessage: (msg) => {
				if (stopped) return;
				logVerbose(core, runtime, `[${account.accountId}] inbound message`);
				statusSink?.({ lastInboundAt: Date.now() });
				const queueKey = resolveInboundQueueKey(msg);
				inboundQueue.enqueue(queueKey, async () => {
					if (stopped || abortSignal.aborted) return;
					await processMessage(msg, account, config, core, runtime, {
						historyLimit,
						groupHistories
					}, statusSink);
				}).catch((err) => {
					runtime.error(`[${account.accountId}] Failed to process message: ${String(err)}`);
				});
			},
			onError: (err) => {
				if (stopped || abortSignal.aborted) return;
				runtime.error(`[${account.accountId}] Zalo listener error: ${String(err)}`);
				settleFailure(err);
			}
		});
	} catch (error) {
		abortSignal.removeEventListener("abort", onAbort);
		throw error;
	}
	listenerStop = listener.stop;
	if (stopped) {
		listenerStop();
		listenerStop = null;
	}
	if (abortSignal.aborted) settleSuccess();
	try {
		await waitForExit;
	} finally {
		abortSignal.removeEventListener("abort", onAbort);
	}
	return { stop };
}
//#endregion
export { monitorZalouserProvider };
