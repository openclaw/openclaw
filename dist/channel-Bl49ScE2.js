import { t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { f as resolveOutboundMediaUrls } from "./reply-payload-DMPQsrQC.js";
import { n as resolveChannelGroupRequireMention } from "./group-policy-sKF5rlUN.js";
import { r as createLazyRuntimeModule } from "./lazy-runtime-D-7_JraP.js";
import { t as clearAccountEntryFields } from "./config-helpers-a_k3n5UT.js";
import { s as createScopedChannelConfigAdapter } from "./channel-config-helpers-xZ4-bv2H.js";
import { r as describeWebhookAccountSnapshot } from "./account-helpers-BEXOONiv.js";
import { i as createChatChannelPlugin } from "./core-kXuNbs5U.js";
import "./channel-core-CV-k5W6W.js";
import { r as createRestrictSendersChannelSecurity } from "./channel-policy-pv8ZpZxj.js";
import { n as createEmptyChannelDirectoryAdapter } from "./directory-runtime-wFQhDUBI.js";
import { d as createDefaultChannelRuntimeState, f as createDependentCredentialStatusIssueCollector, o as buildTokenChannelStatusSummary, u as createComputedAccountStatusAdapter } from "./status-helpers-CnvYAK73.js";
import { r as defineChannelMessageAdapter } from "./channel-message-DMGbyII_.js";
import { i as createPairingPrefixStripper } from "./channel-pairing-N4dBc-K-.js";
import { a as createEmptyChannelResult, i as createAttachedChannelResultAdapter } from "./channel-send-result-swFdRKhg.js";
import { i as resolveLineAccount, r as resolveDefaultLineAccountId, t as listLineAccountIds } from "./accounts-B7VHf02h.js";
import { n as lineSetupAdapter, r as hasLineCredentials, t as lineSetupWizard } from "./setup-surface-5fapeplK.js";
import { i as resolveExactLineGroupConfigKey, n as getLineRuntime, t as buildLineQuickReplyFallbackText } from "./quick-reply-fallback-DMrFXvWi.js";
import { n as parseLineDirectives, o as LineChannelConfigSchema, t as hasLineDirectives } from "./reply-payload-transform-B_Zn99GB.js";
import { n as resolveLineOutboundMedia, t as createLineSendReceipt } from "./send-receipt-Db6xPXKP.js";
//#region extensions/line/src/bindings.ts
function normalizeLineConversationId(raw) {
	const trimmed = raw?.trim() ?? "";
	if (!trimmed) return null;
	return (trimmed.match(/^line:(?:(?:user|group|room):)?(.+)$/i)?.[1] ?? trimmed).trim() || null;
}
function resolveLineCommandConversation(params) {
	const conversationId = normalizeLineConversationId(params.originatingTo) ?? normalizeLineConversationId(params.commandTo) ?? normalizeLineConversationId(params.fallbackTo);
	return conversationId ? { conversationId } : null;
}
function resolveLineInboundConversation(params) {
	const conversationId = normalizeLineConversationId(params.conversationId) ?? normalizeLineConversationId(params.to);
	return conversationId ? { conversationId } : null;
}
const lineBindingsAdapter = {
	compileConfiguredBinding: ({ conversationId }) => {
		const normalized = normalizeLineConversationId(conversationId);
		return normalized ? { conversationId: normalized } : null;
	},
	matchInboundConversation: ({ compiledBinding, conversationId }) => {
		const normalizedIncoming = normalizeLineConversationId(conversationId);
		if (!normalizedIncoming || compiledBinding.conversationId !== normalizedIncoming) return null;
		return {
			conversationId: normalizedIncoming,
			matchPriority: 2
		};
	},
	resolveCommandConversation: ({ originatingTo, commandTo, fallbackTo }) => resolveLineCommandConversation({
		originatingTo,
		commandTo,
		fallbackTo
	}),
	resolveInboundConversation: ({ to, conversationId }) => resolveLineInboundConversation({
		to,
		conversationId
	})
};
//#endregion
//#region extensions/line/src/config-adapter.ts
function normalizeLineAllowFrom(entry) {
	return entry.replace(/^line:(?:user:)?/i, "");
}
const lineChannelPluginCommon = {
	meta: {
		id: "line",
		label: "LINE",
		selectionLabel: "LINE (Messaging API)",
		detailLabel: "LINE Bot",
		docsPath: "/channels/line",
		docsLabel: "line",
		blurb: "LINE Messaging API bot for Japan/Taiwan/Thailand markets.",
		systemImage: "message.fill",
		quickstartAllowFrom: true
	},
	capabilities: {
		chatTypes: ["direct", "group"],
		reactions: false,
		threads: false,
		media: true,
		nativeCommands: false,
		blockStreaming: true
	},
	reload: { configPrefixes: ["channels.line"] },
	configSchema: LineChannelConfigSchema,
	config: {
		...createScopedChannelConfigAdapter({
			sectionKey: "line",
			listAccountIds: listLineAccountIds,
			resolveAccount: (cfg, accountId) => resolveLineAccount({
				cfg,
				accountId: accountId ?? void 0
			}),
			defaultAccountId: resolveDefaultLineAccountId,
			clearBaseFields: [
				"channelSecret",
				"tokenFile",
				"secretFile"
			],
			resolveAllowFrom: (account) => account.config.allowFrom,
			formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean).map(normalizeLineAllowFrom)
		}),
		isConfigured: (account) => hasLineCredentials(account),
		describeAccount: (account) => describeWebhookAccountSnapshot({
			account,
			configured: hasLineCredentials(account),
			extra: { tokenSource: account.tokenSource ?? void 0 }
		})
	}
};
//#endregion
//#region extensions/line/src/gateway.ts
const loadLineProbeRuntime$1 = createLazyRuntimeModule(() => import("./probe.runtime-aIg5NNrD.js"));
const loadLineMonitorRuntime = createLazyRuntimeModule(() => import("./monitor.runtime.js"));
const lineGatewayAdapter = {
	startAccount: async (ctx) => {
		const account = ctx.account;
		const token = account.channelAccessToken.trim();
		const secret = account.channelSecret.trim();
		if (!token) throw new Error(`LINE webhook mode requires a non-empty channel access token for account "${account.accountId}".`);
		if (!secret) throw new Error(`LINE webhook mode requires a non-empty channel secret for account "${account.accountId}".`);
		let lineBotLabel = "";
		try {
			const probe = await (await loadLineProbeRuntime$1()).probeLineBot(token, 2500);
			const displayName = probe.ok ? probe.bot?.displayName?.trim() : null;
			if (displayName) lineBotLabel = ` (${displayName})`;
		} catch (err) {
			if (getLineRuntime().logging.shouldLogVerbose()) ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
		}
		ctx.log?.info(`[${account.accountId}] starting LINE provider${lineBotLabel}`);
		return await (getLineRuntime().channel.line?.monitorLineProvider ?? (await loadLineMonitorRuntime()).monitorLineProvider)({
			channelAccessToken: token,
			channelSecret: secret,
			accountId: account.accountId,
			config: ctx.cfg,
			runtime: ctx.runtime,
			abortSignal: ctx.abortSignal,
			webhookPath: account.config.webhookPath
		});
	},
	logoutAccount: async ({ accountId, cfg }) => {
		const envToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim() ?? "";
		const nextCfg = { ...cfg };
		const nextLine = { ...cfg.channels?.line ?? {} };
		let cleared = false;
		let changed = false;
		if (accountId === "default") {
			if (nextLine.channelAccessToken || nextLine.channelSecret || nextLine.tokenFile || nextLine.secretFile) {
				delete nextLine.channelAccessToken;
				delete nextLine.channelSecret;
				delete nextLine.tokenFile;
				delete nextLine.secretFile;
				cleared = true;
				changed = true;
			}
		}
		const accountCleanup = clearAccountEntryFields({
			accounts: nextLine.accounts,
			accountId,
			fields: [
				"channelAccessToken",
				"channelSecret",
				"tokenFile",
				"secretFile"
			],
			markClearedOnFieldPresence: true
		});
		if (accountCleanup.changed) {
			changed = true;
			if (accountCleanup.cleared) cleared = true;
			if (accountCleanup.nextAccounts) nextLine.accounts = accountCleanup.nextAccounts;
			else delete nextLine.accounts;
		}
		if (changed) {
			if (Object.keys(nextLine).length > 0) nextCfg.channels = {
				...nextCfg.channels,
				line: nextLine
			};
			else {
				const nextChannels = { ...nextCfg.channels };
				delete nextChannels.line;
				if (Object.keys(nextChannels).length > 0) nextCfg.channels = nextChannels;
				else delete nextCfg.channels;
			}
			await getLineRuntime().config.replaceConfigFile({
				nextConfig: nextCfg,
				afterWrite: { mode: "auto" }
			});
		}
		const loggedOut = resolveLineAccount({
			cfg: changed ? nextCfg : cfg,
			accountId
		}).tokenSource === "none";
		return {
			cleared,
			envToken: Boolean(envToken),
			loggedOut
		};
	}
};
//#endregion
//#region extensions/line/src/group-policy.ts
function resolveLineGroupRequireMention(params) {
	const exactGroupId = resolveExactLineGroupConfigKey({
		cfg: params.cfg,
		accountId: params.accountId,
		groupId: params.groupId
	});
	return resolveChannelGroupRequireMention({
		cfg: params.cfg,
		channel: "line",
		groupId: exactGroupId ?? params.groupId,
		accountId: params.accountId
	});
}
//#endregion
//#region extensions/line/src/outbound.ts
const loadLineOutboundRuntime = createLazyRuntimeModule(() => import("./outbound.runtime.js"));
function isLineUserTarget(target) {
	const normalized = target.trim().replace(/^line:(group|room|user):/i, "").replace(/^line:/i, "");
	return /^U/i.test(normalized);
}
function hasLineSpecificMediaOptions(lineData) {
	return Boolean(lineData.mediaKind ?? lineData.previewImageUrl?.trim() ?? (typeof lineData.durationMs === "number" ? lineData.durationMs : void 0) ?? lineData.trackingId?.trim());
}
function buildLineMediaMessageObject(resolved, opts) {
	switch (resolved.mediaKind) {
		case "video": {
			const previewImageUrl = resolved.previewImageUrl?.trim();
			if (!previewImageUrl) throw new Error("LINE video messages require previewImageUrl to reference an image URL");
			return {
				type: "video",
				originalContentUrl: resolved.mediaUrl,
				previewImageUrl,
				...opts?.allowTrackingId && resolved.trackingId ? { trackingId: resolved.trackingId } : {}
			};
		}
		case "audio": return {
			type: "audio",
			originalContentUrl: resolved.mediaUrl,
			duration: resolved.durationMs ?? 6e4
		};
		default: return {
			type: "image",
			originalContentUrl: resolved.mediaUrl,
			previewImageUrl: resolved.previewImageUrl ?? resolved.mediaUrl
		};
	}
}
const lineOutboundAdapter = {
	deliveryMode: "direct",
	chunker: (text, limit) => getLineRuntime().channel.text.chunkMarkdownText(text, limit),
	textChunkLimit: 5e3,
	sendPayload: async ({ to, payload, accountId, cfg }) => {
		const runtime = getLineRuntime();
		const outboundRuntime = await loadLineOutboundRuntime();
		const lineData = payload.channelData?.line ?? {};
		const lineRuntime = runtime.channel.line;
		const sendText = lineRuntime?.pushMessageLine ?? outboundRuntime.pushMessageLine;
		const sendBatch = lineRuntime?.pushMessagesLine ?? outboundRuntime.pushMessagesLine;
		const sendFlex = lineRuntime?.pushFlexMessage ?? outboundRuntime.pushFlexMessage;
		const sendTemplate = lineRuntime?.pushTemplateMessage ?? outboundRuntime.pushTemplateMessage;
		const sendLocation = lineRuntime?.pushLocationMessage ?? outboundRuntime.pushLocationMessage;
		const sendQuickReplies = lineRuntime?.pushTextMessageWithQuickReplies ?? outboundRuntime.pushTextMessageWithQuickReplies;
		const buildTemplate = lineRuntime?.buildTemplateMessageFromPayload ?? outboundRuntime.buildTemplateMessageFromPayload;
		let lastResult = null;
		const quickReplies = lineData.quickReplies ?? [];
		const hasQuickReplies = quickReplies.length > 0;
		const quickReply = hasQuickReplies ? (lineRuntime?.createQuickReplyItems ?? outboundRuntime.createQuickReplyItems)(quickReplies) : void 0;
		const sendMessageBatch = async (messages) => {
			if (messages.length === 0) return;
			for (let i = 0; i < messages.length; i += 5) lastResult = await sendBatch(to, messages.slice(i, i + 5), {
				verbose: false,
				cfg,
				accountId: accountId ?? void 0
			});
		};
		const processed = payload.text ? outboundRuntime.processLineMessage(payload.text) : {
			text: "",
			flexMessages: []
		};
		const chunkLimit = runtime.channel.text.resolveTextChunkLimit?.(cfg, "line", accountId ?? void 0, { fallbackLimit: 5e3 }) ?? 5e3;
		const chunks = processed.text ? runtime.channel.text.chunkMarkdownText(processed.text, chunkLimit) : [];
		const mediaUrls = resolveOutboundMediaUrls(payload);
		const useLineSpecificMedia = hasLineSpecificMediaOptions(lineData);
		const shouldSendQuickRepliesInline = chunks.length === 0 && hasQuickReplies;
		const sendMediaMessages = async () => {
			for (const url of mediaUrls) {
				const trimmed = url?.trim();
				if (!trimmed) continue;
				if (!useLineSpecificMedia) {
					lastResult = await (lineRuntime?.sendMessageLine ?? outboundRuntime.sendMessageLine)(to, "", {
						verbose: false,
						mediaUrl: trimmed,
						cfg,
						accountId: accountId ?? void 0
					});
					continue;
				}
				const resolved = await resolveLineOutboundMedia(trimmed, {
					mediaKind: lineData.mediaKind,
					previewImageUrl: lineData.previewImageUrl,
					durationMs: lineData.durationMs,
					trackingId: lineData.trackingId
				});
				lastResult = await (lineRuntime?.sendMessageLine ?? outboundRuntime.sendMessageLine)(to, "", {
					verbose: false,
					mediaUrl: resolved.mediaUrl,
					mediaKind: resolved.mediaKind,
					previewImageUrl: resolved.previewImageUrl,
					durationMs: resolved.durationMs,
					trackingId: resolved.trackingId,
					cfg,
					accountId: accountId ?? void 0
				});
			}
		};
		if (!shouldSendQuickRepliesInline) {
			if (lineData.flexMessage) {
				const flexContents = lineData.flexMessage.contents;
				lastResult = await sendFlex(to, lineData.flexMessage.altText, flexContents, {
					verbose: false,
					cfg,
					accountId: accountId ?? void 0
				});
			}
			if (lineData.templateMessage) {
				const template = buildTemplate(lineData.templateMessage);
				if (template) lastResult = await sendTemplate(to, template, {
					verbose: false,
					cfg,
					accountId: accountId ?? void 0
				});
			}
			if (lineData.location) lastResult = await sendLocation(to, lineData.location, {
				verbose: false,
				cfg,
				accountId: accountId ?? void 0
			});
			for (const flexMsg of processed.flexMessages) {
				const flexContents = flexMsg.contents;
				lastResult = await sendFlex(to, flexMsg.altText, flexContents, {
					verbose: false,
					cfg,
					accountId: accountId ?? void 0
				});
			}
		}
		const sendMediaAfterText = !(hasQuickReplies && chunks.length > 0);
		if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && !sendMediaAfterText) await sendMediaMessages();
		if (chunks.length > 0) for (let i = 0; i < chunks.length; i += 1) if (i === chunks.length - 1 && hasQuickReplies) lastResult = await sendQuickReplies(to, chunks[i], quickReplies, {
			verbose: false,
			cfg,
			accountId: accountId ?? void 0
		});
		else lastResult = await sendText(to, chunks[i], {
			verbose: false,
			cfg,
			accountId: accountId ?? void 0
		});
		else if (shouldSendQuickRepliesInline) {
			const quickReplyMessages = [];
			if (lineData.flexMessage) quickReplyMessages.push({
				type: "flex",
				altText: lineData.flexMessage.altText.slice(0, 400),
				contents: lineData.flexMessage.contents
			});
			if (lineData.templateMessage) {
				const template = buildTemplate(lineData.templateMessage);
				if (template) quickReplyMessages.push(template);
			}
			if (lineData.location) quickReplyMessages.push({
				type: "location",
				title: lineData.location.title.slice(0, 100),
				address: lineData.location.address.slice(0, 100),
				latitude: lineData.location.latitude,
				longitude: lineData.location.longitude
			});
			for (const flexMsg of processed.flexMessages) quickReplyMessages.push({
				type: "flex",
				altText: flexMsg.altText.slice(0, 400),
				contents: flexMsg.contents
			});
			for (const url of mediaUrls) {
				const trimmed = url?.trim();
				if (!trimmed) continue;
				if (!useLineSpecificMedia) {
					quickReplyMessages.push({
						type: "image",
						originalContentUrl: trimmed,
						previewImageUrl: trimmed
					});
					continue;
				}
				const resolved = await resolveLineOutboundMedia(trimmed, {
					mediaKind: lineData.mediaKind,
					previewImageUrl: lineData.previewImageUrl,
					durationMs: lineData.durationMs,
					trackingId: lineData.trackingId
				});
				quickReplyMessages.push(buildLineMediaMessageObject(resolved, { allowTrackingId: isLineUserTarget(to) }));
			}
			if (quickReplyMessages.length > 0 && quickReply) {
				const lastIndex = quickReplyMessages.length - 1;
				quickReplyMessages[lastIndex] = {
					...quickReplyMessages[lastIndex],
					quickReply
				};
				await sendMessageBatch(quickReplyMessages);
			} else if (quickReply) lastResult = await sendQuickReplies(to, buildLineQuickReplyFallbackText(quickReplies), quickReplies, {
				verbose: false,
				cfg,
				accountId: accountId ?? void 0
			});
		}
		if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && sendMediaAfterText) await sendMediaMessages();
		if (lastResult) return createEmptyChannelResult("line", { ...lastResult });
		return createEmptyChannelResult("line", {
			messageId: "empty",
			chatId: to
		});
	},
	...createAttachedChannelResultAdapter({
		channel: "line",
		sendText: async ({ cfg, to, text, accountId }) => {
			const outboundRuntime = await loadLineOutboundRuntime();
			const sendText = outboundRuntime.pushMessageLine;
			const sendFlex = outboundRuntime.pushFlexMessage;
			const processed = outboundRuntime.processLineMessage(text);
			let result;
			if (processed.text.trim()) result = await sendText(to, processed.text, {
				verbose: false,
				cfg,
				accountId: accountId ?? void 0
			});
			else result = {
				messageId: "processed",
				chatId: to,
				receipt: createLineSendReceipt({
					messageId: "processed",
					chatId: to,
					kind: "card"
				})
			};
			for (const flexMsg of processed.flexMessages) {
				const flexContents = flexMsg.contents;
				await sendFlex(to, flexMsg.altText, flexContents, {
					verbose: false,
					cfg,
					accountId: accountId ?? void 0
				});
			}
			return result;
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => await (await loadLineOutboundRuntime()).sendMessageLine(to, text, {
			verbose: false,
			mediaUrl,
			cfg,
			accountId: accountId ?? void 0
		})
	})
};
function toLineMessageSendResult(result, kind) {
	const source = result;
	const receipt = result.receipt ?? (result.messageId ? createLineSendReceipt({
		messageId: result.messageId,
		chatId: source.chatId ?? "",
		kind
	}) : void 0);
	if (!receipt) throw new Error("LINE message adapter send did not return a receipt");
	return {
		messageId: result.messageId || receipt.primaryPlatformMessageId,
		receipt
	};
}
const lineMessageAdapter = defineChannelMessageAdapter({
	id: "line",
	durableFinal: { capabilities: {
		text: true,
		media: true,
		messageSendingHooks: true
	} },
	send: {
		text: async ({ cfg, to, text, accountId }) => {
			return toLineMessageSendResult(await lineOutboundAdapter.sendPayload({
				cfg,
				to,
				text,
				accountId,
				payload: { text }
			}), "text");
		},
		media: async ({ cfg, to, text, mediaUrl, accountId }) => {
			return toLineMessageSendResult(await lineOutboundAdapter.sendPayload({
				cfg,
				to,
				text,
				mediaUrl,
				accountId,
				payload: {
					text,
					mediaUrl
				}
			}), "media");
		}
	},
	receive: {
		defaultAckPolicy: "after_receive_record",
		supportedAckPolicies: ["after_receive_record"]
	}
});
//#endregion
//#region extensions/line/src/status.ts
const loadLineProbeRuntime = createLazyRuntimeModule(() => import("./probe.runtime-aIg5NNrD.js"));
const collectLineStatusIssues = createDependentCredentialStatusIssueCollector({
	channel: "line",
	dependencySourceKey: "tokenSource",
	missingPrimaryMessage: "LINE channel access token not configured",
	missingDependentMessage: "LINE channel secret not configured"
});
const lineStatusAdapter = createComputedAccountStatusAdapter({
	defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
	collectStatusIssues: collectLineStatusIssues,
	buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
	probeAccount: async ({ account, timeoutMs }) => await (await loadLineProbeRuntime()).probeLineBot(account.channelAccessToken, timeoutMs),
	resolveAccountSnapshot: ({ account }) => ({
		accountId: account.accountId,
		name: account.name,
		enabled: account.enabled,
		configured: hasLineCredentials(account),
		extra: {
			tokenSource: account.tokenSource,
			mode: "webhook"
		}
	})
});
//#endregion
//#region extensions/line/src/channel.ts
const loadLineChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime-Bx0GG81a.js"));
const lineSecurityAdapter = createRestrictSendersChannelSecurity({
	channelKey: "line",
	resolveDmPolicy: (account) => account.config.dmPolicy,
	resolveDmAllowFrom: (account) => account.config.allowFrom,
	resolveGroupPolicy: (account) => account.config.groupPolicy,
	surface: "LINE groups",
	openScope: "any member in groups",
	groupPolicyPath: "channels.line.groupPolicy",
	groupAllowFromPath: "channels.line.groupAllowFrom",
	mentionGated: false,
	policyPathSuffix: "dmPolicy",
	approveHint: "openclaw pairing approve line <code>",
	normalizeDmEntry: (raw) => raw.replace(/^line:(?:user:)?/i, "")
});
const linePlugin = createChatChannelPlugin({
	base: {
		id: "line",
		...lineChannelPluginCommon,
		setupWizard: lineSetupWizard,
		groups: { resolveRequireMention: resolveLineGroupRequireMention },
		messaging: {
			targetPrefixes: ["line"],
			normalizeTarget: (target) => {
				const trimmed = target.trim();
				if (!trimmed) return;
				return trimmed.replace(/^line:(group|room|user):/i, "").replace(/^line:/i, "");
			},
			resolveInboundConversation: lineBindingsAdapter.resolveInboundConversation,
			transformReplyPayload: ({ payload }) => {
				if (!payload.text || !hasLineDirectives(payload.text)) return payload;
				return parseLineDirectives(payload);
			},
			targetResolver: {
				looksLikeId: (id) => {
					const trimmed = id?.trim();
					if (!trimmed) return false;
					return /^[UCR][a-f0-9]{32}$/i.test(trimmed) || /^line:/i.test(trimmed);
				},
				hint: "<userId|groupId|roomId>"
			}
		},
		directory: createEmptyChannelDirectoryAdapter(),
		setup: lineSetupAdapter,
		status: lineStatusAdapter,
		gateway: lineGatewayAdapter,
		message: lineMessageAdapter,
		bindings: lineBindingsAdapter,
		conversationBindings: { defaultTopLevelPlacement: "current" },
		agentPrompt: { messageToolHints: () => [
			"",
			"### LINE Rich Messages",
			"LINE supports rich visual messages. Use these directives in your reply when appropriate:",
			"",
			"**Quick Replies** (bottom button suggestions):",
			"  [[quick_replies: Option 1, Option 2, Option 3]]",
			"",
			"**Location** (map pin):",
			"  [[location: Place Name | Address | latitude | longitude]]",
			"",
			"**Confirm Dialog** (yes/no prompt):",
			"  [[confirm: Question text? | Yes Label | No Label]]",
			"",
			"**Button Menu** (title + text + buttons):",
			"  [[buttons: Title | Description | Btn1:action1, Btn2:https://url.com]]",
			"",
			"**Media Player Card** (music status):",
			"  [[media_player: Song Title | Artist Name | Source | https://albumart.url | playing]]",
			"  - Status: 'playing' or 'paused' (optional)",
			"",
			"**Event Card** (calendar events, meetings):",
			"  [[event: Event Title | Date | Time | Location | Description]]",
			"  - Time, Location, Description are optional",
			"",
			"**Agenda Card** (multiple events/schedule):",
			"  [[agenda: Schedule Title | Event1:9:00 AM, Event2:12:00 PM, Event3:3:00 PM]]",
			"",
			"**Device Control Card** (smart devices, TVs, etc.):",
			"  [[device: Device Name | Device Type | Status | Control1:data1, Control2:data2]]",
			"",
			"**Apple TV Remote** (full D-pad + transport):",
			"  [[appletv_remote: Apple TV | Playing]]",
			"",
			"**Auto-converted**: Markdown tables become Flex cards, code blocks become styled cards.",
			"",
			"When to use rich messages:",
			"- Use [[quick_replies:...]] when offering 2-4 clear options",
			"- Use [[confirm:...]] for yes/no decisions",
			"- Use [[buttons:...]] for menus with actions/links",
			"- Use [[location:...]] when sharing a place",
			"- Use [[media_player:...]] when showing what's playing",
			"- Use [[event:...]] for calendar event details",
			"- Use [[agenda:...]] for a day's schedule or event list",
			"- Use [[device:...]] for smart device status/controls",
			"- Tables/code in your response auto-convert to visual cards"
		] }
	},
	pairing: { text: {
		idLabel: "lineUserId",
		message: "OpenClaw: your access has been approved.",
		normalizeAllowEntry: createPairingPrefixStripper(/^line:(?:user:)?/i),
		notify: async ({ cfg, id, message }) => {
			const account = (getLineRuntime().channel.line?.resolveLineAccount ?? resolveLineAccount)({ cfg });
			if (!account.channelAccessToken) throw new Error("LINE channel access token not configured");
			await (getLineRuntime().channel.line?.pushMessageLine ?? (await loadLineChannelRuntime()).pushMessageLine)(id, message, {
				cfg,
				accountId: account.accountId,
				channelAccessToken: account.channelAccessToken
			});
		}
	} },
	security: lineSecurityAdapter,
	outbound: lineOutboundAdapter
});
//#endregion
export { lineChannelPluginCommon as n, linePlugin as t };
