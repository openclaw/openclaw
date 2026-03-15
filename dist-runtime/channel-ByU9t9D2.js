import { h as DEFAULT_ACCOUNT_ID } from "./session-key-BfFG0xOA.js";
import { En as DmPolicySchema, Fn as MarkdownConfigSchema, _n as setAccountEnabledInConfigSection, bn as buildChannelConfigSchema, dn as PAIRING_APPROVED_MESSAGE, fn as buildAccountScopedDmSecurityPolicy, gn as deleteAccountFromConfigSection, kn as GroupPolicySchema, vn as AllowFromListSchema, yn as buildCatchallMultiAccountChannelSchema } from "./resolve-route-BZ4hHpx2.js";
import { c as normalizeSecretInputString, i as hasConfiguredSecretInput } from "./types.secrets-apkw3WZr.js";
import { t as createAccountStatusSink } from "./channel-lifecycle-h2DwjEdV.js";
import { Bu as buildProbeChannelStatusSummary, Cp as mapAllowFromEntries, Sf as ToolPolicySchema, ci as extractToolSend, el as resolveBlueBubblesGroupRequireMention, fr as BLUEBUBBLES_ACTIONS, j as collectOpenGroupPolicyRestrictSendersWarnings, ko as buildSecretInputSchema, pr as BLUEBUBBLES_ACTION_NAMES, tl as resolveBlueBubblesGroupToolPolicy, xt as formatNormalizedAllowFromEntries, zs as readBooleanParam, zu as buildComputedAccountStatusSnapshot } from "./auth-profiles-CuJtivJK.js";
import { C as readReactionParams, E as readStringParam, S as readNumberParam, _ as createActionGate, b as jsonResult } from "./external-content-vZzOHxnd.js";
import { b as collectBlueBubblesStatusIssues } from "./compat-DDXNEdAm.js";
import { _ as listBlueBubblesAccountIds, c as normalizeBlueBubblesMessagingTarget, f as getCachedBlueBubblesPrivateApiStatus, h as isMacOS26OrHigher, o as looksLikeBlueBubblesTargetId, r as extractHandleFromChatGuid, s as normalizeBlueBubblesHandle, u as parseBlueBubblesTarget, v as resolveBlueBubblesAccount, y as resolveDefaultBlueBubblesAccountId } from "./monitor-shared-Bf6JQzrD.js";
import { n as blueBubblesSetupAdapter, t as blueBubblesSetupWizard } from "./setup-surface-DPFugk-t.js";
import { z } from "zod";
//#region extensions/bluebubbles/src/actions.ts
let actionsRuntimePromise = null;
function loadBlueBubblesActionsRuntime() {
	actionsRuntimePromise ??= import("./actions.runtime-D69YHSHR.js");
	return actionsRuntimePromise;
}
const providerId = "bluebubbles";
function mapTarget(raw) {
	const parsed = parseBlueBubblesTarget(raw);
	if (parsed.kind === "chat_guid") {return {
		kind: "chat_guid",
		chatGuid: parsed.chatGuid
	};}
	if (parsed.kind === "chat_id") {return {
		kind: "chat_id",
		chatId: parsed.chatId
	};}
	if (parsed.kind === "chat_identifier") {return {
		kind: "chat_identifier",
		chatIdentifier: parsed.chatIdentifier
	};}
	return {
		kind: "handle",
		address: normalizeBlueBubblesHandle(parsed.to),
		service: parsed.service
	};
}
function readMessageText(params) {
	return readStringParam(params, "text") ?? readStringParam(params, "message");
}
/** Supported action names for BlueBubbles */
const SUPPORTED_ACTIONS = new Set(BLUEBUBBLES_ACTION_NAMES);
const PRIVATE_API_ACTIONS = new Set([
	"react",
	"edit",
	"unsend",
	"reply",
	"sendWithEffect",
	"renameGroup",
	"setGroupIcon",
	"addParticipant",
	"removeParticipant",
	"leaveGroup"
]);
const bluebubblesMessageActions = {
	listActions: ({ cfg }) => {
		const account = resolveBlueBubblesAccount({ cfg });
		if (!account.enabled || !account.configured) {return [];}
		const gate = createActionGate(cfg.channels?.bluebubbles?.actions);
		const actions = /* @__PURE__ */ new Set();
		const macOS26 = isMacOS26OrHigher(account.accountId);
		const privateApiStatus = getCachedBlueBubblesPrivateApiStatus(account.accountId);
		for (const action of BLUEBUBBLES_ACTION_NAMES) {
			const spec = BLUEBUBBLES_ACTIONS[action];
			if (!spec?.gate) {continue;}
			if (privateApiStatus === false && PRIVATE_API_ACTIONS.has(action)) {continue;}
			if ("unsupportedOnMacOS26" in spec && spec.unsupportedOnMacOS26 && macOS26) {continue;}
			if (gate(spec.gate)) {actions.add(action);}
		}
		return Array.from(actions);
	},
	supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
	extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
	handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
		const runtime = await loadBlueBubblesActionsRuntime();
		const account = resolveBlueBubblesAccount({
			cfg,
			accountId: accountId ?? void 0
		});
		const baseUrl = normalizeSecretInputString(account.config.serverUrl);
		const password = normalizeSecretInputString(account.config.password);
		const opts = {
			cfg,
			accountId: accountId ?? void 0
		};
		const assertPrivateApiEnabled = () => {
			if (getCachedBlueBubblesPrivateApiStatus(account.accountId) === false) {throw new Error(`BlueBubbles ${action} requires Private API, but it is disabled on the BlueBubbles server.`);}
		};
		const resolveChatGuid = async () => {
			const chatGuid = readStringParam(params, "chatGuid");
			if (chatGuid?.trim()) {return chatGuid.trim();}
			const chatIdentifier = readStringParam(params, "chatIdentifier");
			const chatId = readNumberParam(params, "chatId", { integer: true });
			const to = readStringParam(params, "to");
			const contextTarget = toolContext?.currentChannelId?.trim();
			const target = chatIdentifier?.trim() ? {
				kind: "chat_identifier",
				chatIdentifier: chatIdentifier.trim()
			} : typeof chatId === "number" ? {
				kind: "chat_id",
				chatId
			} : to ? mapTarget(to) : contextTarget ? mapTarget(contextTarget) : null;
			if (!target) {throw new Error(`BlueBubbles ${action} requires chatGuid, chatIdentifier, chatId, or to.`);}
			if (!baseUrl || !password) {throw new Error(`BlueBubbles ${action} requires serverUrl and password.`);}
			const resolved = await runtime.resolveChatGuidForTarget({
				baseUrl,
				password,
				target
			});
			if (!resolved) {throw new Error(`BlueBubbles ${action} failed: chatGuid not found for target.`);}
			return resolved;
		};
		if (action === "react") {
			assertPrivateApiEnabled();
			const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Emoji is required to remove a BlueBubbles reaction." });
			if (isEmpty && !remove) {throw new Error("BlueBubbles react requires emoji parameter. Use action=react with emoji=<emoji> and messageId=<message_id>.");}
			const rawMessageId = readStringParam(params, "messageId");
			if (!rawMessageId) {throw new Error("BlueBubbles react requires messageId parameter (the message ID to react to). Use action=react with messageId=<message_id>, emoji=<emoji>, and to/chatGuid to identify the chat.");}
			const messageId = runtime.resolveBlueBubblesMessageId(rawMessageId, { requireKnownShortId: true });
			const partIndex = readNumberParam(params, "partIndex", { integer: true });
			const resolvedChatGuid = await resolveChatGuid();
			await runtime.sendBlueBubblesReaction({
				chatGuid: resolvedChatGuid,
				messageGuid: messageId,
				emoji,
				remove: remove || void 0,
				partIndex: typeof partIndex === "number" ? partIndex : void 0,
				opts
			});
			return jsonResult({
				ok: true,
				...remove ? { removed: true } : { added: emoji }
			});
		}
		if (action === "edit") {
			assertPrivateApiEnabled();
			if (isMacOS26OrHigher(accountId ?? void 0)) {throw new Error("BlueBubbles edit is not supported on macOS 26 or higher. Apple removed the ability to edit iMessages in this version.");}
			const rawMessageId = readStringParam(params, "messageId");
			const newText = readStringParam(params, "text") ?? readStringParam(params, "newText") ?? readStringParam(params, "message");
			if (!rawMessageId || !newText) {
				const missing = [];
				if (!rawMessageId) {missing.push("messageId (the message ID to edit)");}
				if (!newText) {missing.push("text (the new message content)");}
				throw new Error(`BlueBubbles edit requires: ${missing.join(", ")}. Use action=edit with messageId=<message_id>, text=<new_content>.`);
			}
			const messageId = runtime.resolveBlueBubblesMessageId(rawMessageId, { requireKnownShortId: true });
			const partIndex = readNumberParam(params, "partIndex", { integer: true });
			const backwardsCompatMessage = readStringParam(params, "backwardsCompatMessage");
			await runtime.editBlueBubblesMessage(messageId, newText, {
				...opts,
				partIndex: typeof partIndex === "number" ? partIndex : void 0,
				backwardsCompatMessage: backwardsCompatMessage ?? void 0
			});
			return jsonResult({
				ok: true,
				edited: rawMessageId
			});
		}
		if (action === "unsend") {
			assertPrivateApiEnabled();
			const rawMessageId = readStringParam(params, "messageId");
			if (!rawMessageId) {throw new Error("BlueBubbles unsend requires messageId parameter (the message ID to unsend). Use action=unsend with messageId=<message_id>.");}
			const messageId = runtime.resolveBlueBubblesMessageId(rawMessageId, { requireKnownShortId: true });
			const partIndex = readNumberParam(params, "partIndex", { integer: true });
			await runtime.unsendBlueBubblesMessage(messageId, {
				...opts,
				partIndex: typeof partIndex === "number" ? partIndex : void 0
			});
			return jsonResult({
				ok: true,
				unsent: rawMessageId
			});
		}
		if (action === "reply") {
			assertPrivateApiEnabled();
			const rawMessageId = readStringParam(params, "messageId");
			const text = readMessageText(params);
			const to = readStringParam(params, "to") ?? readStringParam(params, "target");
			if (!rawMessageId || !text || !to) {
				const missing = [];
				if (!rawMessageId) {missing.push("messageId (the message ID to reply to)");}
				if (!text) {missing.push("text or message (the reply message content)");}
				if (!to) {missing.push("to or target (the chat target)");}
				throw new Error(`BlueBubbles reply requires: ${missing.join(", ")}. Use action=reply with messageId=<message_id>, message=<your reply>, target=<chat_target>.`);
			}
			const messageId = runtime.resolveBlueBubblesMessageId(rawMessageId, { requireKnownShortId: true });
			const partIndex = readNumberParam(params, "partIndex", { integer: true });
			return jsonResult({
				ok: true,
				messageId: (await runtime.sendMessageBlueBubbles(to, text, {
					...opts,
					replyToMessageGuid: messageId,
					replyToPartIndex: typeof partIndex === "number" ? partIndex : void 0
				})).messageId,
				repliedTo: rawMessageId
			});
		}
		if (action === "sendWithEffect") {
			assertPrivateApiEnabled();
			const text = readMessageText(params);
			const to = readStringParam(params, "to") ?? readStringParam(params, "target");
			const effectId = readStringParam(params, "effectId") ?? readStringParam(params, "effect");
			if (!text || !to || !effectId) {
				const missing = [];
				if (!text) {missing.push("text or message (the message content)");}
				if (!to) {missing.push("to or target (the chat target)");}
				if (!effectId) {missing.push("effectId or effect (e.g., slam, loud, gentle, invisible-ink, confetti, lasers, fireworks, balloons, heart)");}
				throw new Error(`BlueBubbles sendWithEffect requires: ${missing.join(", ")}. Use action=sendWithEffect with message=<message>, target=<chat_target>, effectId=<effect_name>.`);
			}
			return jsonResult({
				ok: true,
				messageId: (await runtime.sendMessageBlueBubbles(to, text, {
					...opts,
					effectId
				})).messageId,
				effect: effectId
			});
		}
		if (action === "renameGroup") {
			assertPrivateApiEnabled();
			const resolvedChatGuid = await resolveChatGuid();
			const displayName = readStringParam(params, "displayName") ?? readStringParam(params, "name");
			if (!displayName) {throw new Error("BlueBubbles renameGroup requires displayName or name parameter.");}
			await runtime.renameBlueBubblesChat(resolvedChatGuid, displayName, opts);
			return jsonResult({
				ok: true,
				renamed: resolvedChatGuid,
				displayName
			});
		}
		if (action === "setGroupIcon") {
			assertPrivateApiEnabled();
			const resolvedChatGuid = await resolveChatGuid();
			const base64Buffer = readStringParam(params, "buffer");
			const filename = readStringParam(params, "filename") ?? readStringParam(params, "name") ?? "icon.png";
			const contentType = readStringParam(params, "contentType") ?? readStringParam(params, "mimeType");
			if (!base64Buffer) {throw new Error("BlueBubbles setGroupIcon requires an image. Use action=setGroupIcon with media=<image_url> or path=<local_file_path> to set the group icon.");}
			const buffer = Uint8Array.from(atob(base64Buffer), (c) => c.charCodeAt(0));
			await runtime.setGroupIconBlueBubbles(resolvedChatGuid, buffer, filename, {
				...opts,
				contentType: contentType ?? void 0
			});
			return jsonResult({
				ok: true,
				chatGuid: resolvedChatGuid,
				iconSet: true
			});
		}
		if (action === "addParticipant") {
			assertPrivateApiEnabled();
			const resolvedChatGuid = await resolveChatGuid();
			const address = readStringParam(params, "address") ?? readStringParam(params, "participant");
			if (!address) {throw new Error("BlueBubbles addParticipant requires address or participant parameter.");}
			await runtime.addBlueBubblesParticipant(resolvedChatGuid, address, opts);
			return jsonResult({
				ok: true,
				added: address,
				chatGuid: resolvedChatGuid
			});
		}
		if (action === "removeParticipant") {
			assertPrivateApiEnabled();
			const resolvedChatGuid = await resolveChatGuid();
			const address = readStringParam(params, "address") ?? readStringParam(params, "participant");
			if (!address) {throw new Error("BlueBubbles removeParticipant requires address or participant parameter.");}
			await runtime.removeBlueBubblesParticipant(resolvedChatGuid, address, opts);
			return jsonResult({
				ok: true,
				removed: address,
				chatGuid: resolvedChatGuid
			});
		}
		if (action === "leaveGroup") {
			assertPrivateApiEnabled();
			const resolvedChatGuid = await resolveChatGuid();
			await runtime.leaveBlueBubblesChat(resolvedChatGuid, opts);
			return jsonResult({
				ok: true,
				left: resolvedChatGuid
			});
		}
		if (action === "sendAttachment") {
			const to = readStringParam(params, "to", { required: true });
			const filename = readStringParam(params, "filename", { required: true });
			const caption = readStringParam(params, "caption");
			const contentType = readStringParam(params, "contentType") ?? readStringParam(params, "mimeType");
			const asVoice = readBooleanParam(params, "asVoice");
			const base64Buffer = readStringParam(params, "buffer");
			const filePath = readStringParam(params, "path") ?? readStringParam(params, "filePath");
			let buffer;
			if (base64Buffer) {buffer = Uint8Array.from(atob(base64Buffer), (c) => c.charCodeAt(0));}
			else if (filePath) {throw new Error("BlueBubbles sendAttachment: filePath not supported in action, provide buffer as base64.");}
			else {throw new Error("BlueBubbles sendAttachment requires buffer (base64) parameter.");}
			return jsonResult({
				ok: true,
				messageId: (await runtime.sendBlueBubblesAttachment({
					to,
					buffer,
					filename,
					contentType: contentType ?? void 0,
					caption: caption ?? void 0,
					asVoice: asVoice ?? void 0,
					opts
				})).messageId
			});
		}
		throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
	}
};
//#endregion
//#region extensions/bluebubbles/src/config-schema.ts
const bluebubblesActionSchema = z.object({
	reactions: z.boolean().default(true),
	edit: z.boolean().default(true),
	unsend: z.boolean().default(true),
	reply: z.boolean().default(true),
	sendWithEffect: z.boolean().default(true),
	renameGroup: z.boolean().default(true),
	setGroupIcon: z.boolean().default(true),
	addParticipant: z.boolean().default(true),
	removeParticipant: z.boolean().default(true),
	leaveGroup: z.boolean().default(true),
	sendAttachment: z.boolean().default(true)
}).optional();
const bluebubblesGroupConfigSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema
});
const BlueBubblesConfigSchema = buildCatchallMultiAccountChannelSchema(z.object({
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	markdown: MarkdownConfigSchema,
	serverUrl: z.string().optional(),
	password: buildSecretInputSchema().optional(),
	webhookPath: z.string().optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: AllowFromListSchema,
	groupAllowFrom: AllowFromListSchema,
	groupPolicy: GroupPolicySchema.optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	mediaMaxMb: z.number().int().positive().optional(),
	mediaLocalRoots: z.array(z.string()).optional(),
	sendReadReceipts: z.boolean().optional(),
	allowPrivateNetwork: z.boolean().optional(),
	blockStreaming: z.boolean().optional(),
	groups: z.object({}).catchall(bluebubblesGroupConfigSchema).optional()
}).superRefine((value, ctx) => {
	const serverUrl = value.serverUrl?.trim() ?? "";
	const passwordConfigured = hasConfiguredSecretInput(value.password);
	if (serverUrl && !passwordConfigured) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["password"],
		message: "password is required when serverUrl is configured"
	});}
})).extend({ actions: bluebubblesActionSchema });
//#endregion
//#region extensions/bluebubbles/src/channel.ts
let blueBubblesChannelRuntimePromise = null;
function loadBlueBubblesChannelRuntime() {
	blueBubblesChannelRuntimePromise ??= import("./channel.runtime-BsPTpDO6.js");
	return blueBubblesChannelRuntimePromise;
}
const bluebubblesPlugin = {
	id: "bluebubbles",
	meta: {
		id: "bluebubbles",
		label: "BlueBubbles",
		selectionLabel: "BlueBubbles (macOS app)",
		detailLabel: "BlueBubbles",
		docsPath: "/channels/bluebubbles",
		docsLabel: "bluebubbles",
		blurb: "iMessage via the BlueBubbles mac app + REST API.",
		systemImage: "bubble.left.and.text.bubble.right",
		aliases: ["bb"],
		order: 75,
		preferOver: ["imessage"]
	},
	capabilities: {
		chatTypes: ["direct", "group"],
		media: true,
		reactions: true,
		edit: true,
		unsend: true,
		reply: true,
		effects: true,
		groupManagement: true
	},
	groups: {
		resolveRequireMention: resolveBlueBubblesGroupRequireMention,
		resolveToolPolicy: resolveBlueBubblesGroupToolPolicy
	},
	threading: { buildToolContext: ({ context, hasRepliedRef }) => ({
		currentChannelId: context.To?.trim() || void 0,
		currentThreadTs: context.ReplyToIdFull ?? context.ReplyToId,
		hasRepliedRef
	}) },
	reload: { configPrefixes: ["channels.bluebubbles"] },
	configSchema: buildChannelConfigSchema(BlueBubblesConfigSchema),
	setupWizard: blueBubblesSetupWizard,
	config: {
		listAccountIds: (cfg) => listBlueBubblesAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveBlueBubblesAccount({
			cfg,
			accountId
		}),
		defaultAccountId: (cfg) => resolveDefaultBlueBubblesAccountId(cfg),
		setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledInConfigSection({
			cfg,
			sectionKey: "bluebubbles",
			accountId,
			enabled,
			allowTopLevel: true
		}),
		deleteAccount: ({ cfg, accountId }) => deleteAccountFromConfigSection({
			cfg,
			sectionKey: "bluebubbles",
			accountId,
			clearBaseFields: [
				"serverUrl",
				"password",
				"name",
				"webhookPath"
			]
		}),
		isConfigured: (account) => account.configured,
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: account.configured,
			baseUrl: account.baseUrl
		}),
		resolveAllowFrom: ({ cfg, accountId }) => mapAllowFromEntries(resolveBlueBubblesAccount({
			cfg,
			accountId
		}).config.allowFrom),
		formatAllowFrom: ({ allowFrom }) => formatNormalizedAllowFromEntries({
			allowFrom,
			normalizeEntry: (entry) => normalizeBlueBubblesHandle(entry.replace(/^bluebubbles:/i, ""))
		})
	},
	actions: bluebubblesMessageActions,
	security: {
		resolveDmPolicy: ({ cfg, accountId, account }) => {
			return buildAccountScopedDmSecurityPolicy({
				cfg,
				channelKey: "bluebubbles",
				accountId,
				fallbackAccountId: account.accountId ?? "default",
				policy: account.config.dmPolicy,
				allowFrom: account.config.allowFrom ?? [],
				policyPathSuffix: "dmPolicy",
				normalizeEntry: (raw) => normalizeBlueBubblesHandle(raw.replace(/^bluebubbles:/i, ""))
			});
		},
		collectWarnings: ({ account }) => {
			return collectOpenGroupPolicyRestrictSendersWarnings({
				groupPolicy: account.config.groupPolicy ?? "allowlist",
				surface: "BlueBubbles groups",
				openScope: "any member",
				groupPolicyPath: "channels.bluebubbles.groupPolicy",
				groupAllowFromPath: "channels.bluebubbles.groupAllowFrom",
				mentionGated: false
			});
		}
	},
	messaging: {
		normalizeTarget: normalizeBlueBubblesMessagingTarget,
		targetResolver: {
			looksLikeId: looksLikeBlueBubblesTargetId,
			hint: "<handle|chat_guid:GUID|chat_id:ID|chat_identifier:ID>"
		},
		formatTargetDisplay: ({ target, display }) => {
			const shouldParseDisplay = (value) => {
				if (looksLikeBlueBubblesTargetId(value)) {return true;}
				return /^(bluebubbles:|chat_guid:|chat_id:|chat_identifier:)/i.test(value);
			};
			const extractCleanDisplay = (value) => {
				const trimmed = value?.trim();
				if (!trimmed) {return null;}
				try {
					const parsed = parseBlueBubblesTarget(trimmed);
					if (parsed.kind === "chat_guid") {
						const handle = extractHandleFromChatGuid(parsed.chatGuid);
						if (handle) {return handle;}
					}
					if (parsed.kind === "handle") {return normalizeBlueBubblesHandle(parsed.to);}
				} catch {}
				const stripped = trimmed.replace(/^bluebubbles:/i, "").replace(/^chat_guid:/i, "").replace(/^chat_id:/i, "").replace(/^chat_identifier:/i, "");
				const handle = extractHandleFromChatGuid(stripped);
				if (handle) {return handle;}
				if (stripped.includes(";-;") || stripped.includes(";+;")) {return null;}
				return stripped;
			};
			const trimmedDisplay = display?.trim();
			if (trimmedDisplay) {
				if (!shouldParseDisplay(trimmedDisplay)) {return trimmedDisplay;}
				const cleanDisplay = extractCleanDisplay(trimmedDisplay);
				if (cleanDisplay) {return cleanDisplay;}
			}
			const cleanTarget = extractCleanDisplay(target);
			if (cleanTarget) {return cleanTarget;}
			return display?.trim() || target?.trim() || "";
		}
	},
	setup: blueBubblesSetupAdapter,
	pairing: {
		idLabel: "bluebubblesSenderId",
		normalizeAllowEntry: (entry) => normalizeBlueBubblesHandle(entry.replace(/^bluebubbles:/i, "")),
		notifyApproval: async ({ cfg, id }) => {
			await (await loadBlueBubblesChannelRuntime()).sendMessageBlueBubbles(id, PAIRING_APPROVED_MESSAGE, { cfg });
		}
	},
	outbound: {
		deliveryMode: "direct",
		textChunkLimit: 4e3,
		resolveTarget: ({ to }) => {
			const trimmed = to?.trim();
			if (!trimmed) {return {
				ok: false,
				error: /* @__PURE__ */ new Error("Delivering to BlueBubbles requires --to <handle|chat_guid:GUID>")
			};}
			return {
				ok: true,
				to: trimmed
			};
		},
		sendText: async ({ cfg, to, text, accountId, replyToId }) => {
			const runtime = await loadBlueBubblesChannelRuntime();
			const rawReplyToId = typeof replyToId === "string" ? replyToId.trim() : "";
			const replyToMessageGuid = rawReplyToId ? runtime.resolveBlueBubblesMessageId(rawReplyToId, { requireKnownShortId: true }) : "";
			return {
				channel: "bluebubbles",
				...await runtime.sendMessageBlueBubbles(to, text, {
					cfg,
					accountId: accountId ?? void 0,
					replyToMessageGuid: replyToMessageGuid || void 0
				})
			};
		},
		sendMedia: async (ctx) => {
			const runtime = await loadBlueBubblesChannelRuntime();
			const { cfg, to, text, mediaUrl, accountId, replyToId } = ctx;
			const { mediaPath, mediaBuffer, contentType, filename, caption } = ctx;
			const resolvedCaption = caption ?? text;
			return {
				channel: "bluebubbles",
				...await runtime.sendBlueBubblesMedia({
					cfg,
					to,
					mediaUrl,
					mediaPath,
					mediaBuffer,
					contentType,
					filename,
					caption: resolvedCaption ?? void 0,
					replyToId: replyToId ?? null,
					accountId: accountId ?? void 0
				})
			};
		}
	},
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: false,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null
		},
		collectStatusIssues: collectBlueBubblesStatusIssues,
		buildChannelSummary: ({ snapshot }) => buildProbeChannelStatusSummary(snapshot, { baseUrl: snapshot.baseUrl ?? null }),
		probeAccount: async ({ account, timeoutMs }) => (await loadBlueBubblesChannelRuntime()).probeBlueBubbles({
			baseUrl: account.baseUrl,
			password: account.config.password ?? null,
			timeoutMs
		}),
		buildAccountSnapshot: ({ account, runtime, probe }) => {
			const running = runtime?.running ?? false;
			const probeOk = probe?.ok;
			return {
				...buildComputedAccountStatusSnapshot({
					accountId: account.accountId,
					name: account.name,
					enabled: account.enabled,
					configured: account.configured,
					runtime,
					probe
				}),
				baseUrl: account.baseUrl,
				connected: probeOk ?? running
			};
		}
	},
	gateway: { startAccount: async (ctx) => {
		const runtime = await loadBlueBubblesChannelRuntime();
		const account = ctx.account;
		const webhookPath = runtime.resolveWebhookPathFromConfig(account.config);
		const statusSink = createAccountStatusSink({
			accountId: ctx.accountId,
			setStatus: ctx.setStatus
		});
		statusSink({ baseUrl: account.baseUrl });
		ctx.log?.info(`[${account.accountId}] starting provider (webhook=${webhookPath})`);
		return runtime.monitorBlueBubblesProvider({
			account,
			config: ctx.cfg,
			runtime: ctx.runtime,
			abortSignal: ctx.abortSignal,
			statusSink,
			webhookPath
		});
	} }
};
//#endregion
export { bluebubblesPlugin as t };
