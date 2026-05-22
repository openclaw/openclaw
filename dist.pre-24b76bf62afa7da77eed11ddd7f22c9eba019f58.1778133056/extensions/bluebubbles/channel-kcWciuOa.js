import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "../../string-coerce-Bje8XVt9.js";
import { t as formatDocsLink } from "../../links-BszRQhGa.js";
import { o as hasConfiguredSecretInput, u as normalizeSecretInputString } from "../../types.secrets-CyuYZNvB.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-05Z3mmpO.js";
import { i as createLazyRuntimeNamedExport } from "../../lazy-runtime-D4HntnKe.js";
import { a as createActionGate, f as readNumberParam, g as readStringParam, l as jsonResult, p as readReactionParams } from "../../common-DZqX8QYm.js";
import { t as readBooleanParam } from "../../boolean-param-5HFHw8DG.js";
import { l as createScopedDmSecurityResolver, s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "../../channel-config-helpers-LfEE_4Xc.js";
import "../../text-runtime-C_zPTqpT.js";
import { r as describeWebhookAccountSnapshot } from "../../account-helpers-D2uz6wWy.js";
import { a as createSetupInputPresenceValidator, l as patchScopedAccountConfig, u as prepareScopedSetupConfig } from "../../setup-helpers-D5cShzie.js";
import { i as createChatChannelPlugin, t as buildChannelOutboundSessionRoute, u as stripChannelTargetPrefix } from "../../core-BsEhQ_g7.js";
import "../../channel-core-BASvgwzh.js";
import { t as createAccountStatusSink } from "../../channel-lifecycle.core-gZjBaPFF.js";
import { n as formatNormalizedAllowFromEntries } from "../../allow-from-eZ6uedD3.js";
import { T as projectAccountWarningCollector, x as createOpenGroupPolicyRestrictSendersWarningCollector } from "../../channel-policy-CJIN_g7f.js";
import { a as createAllowFromSection, d as createPromptParsedAllowFromForAccount, f as createStandardChannelSetupStatus, t as addWildcardAllowFrom } from "../../setup-wizard-helpers-BmlH_00g.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DDuxp0PB.js";
import { i as createPairingPrefixStripper } from "../../channel-pairing-CWWMPhAh.js";
import { d as createDefaultChannelRuntimeState, h as collectIssuesForEnabledAccounts, i as buildProbeChannelStatusSummary, u as createComputedAccountStatusAdapter } from "../../status-helpers-CaAM_77P.js";
import { t as extractToolSend } from "../../tool-send-cy5l8oyc.js";
import "../../setup-DKguekh2.js";
import { o as isPrivateNetworkOptInEnabled } from "../../ssrf-policy-CrjaYWnM.js";
import "../../ssrf-runtime-BoUUJCOc.js";
import "../../channel-status-Bs_3DYkc.js";
import "../../channel-actions-Dvpzx5Sm.js";
import "../../channel-lifecycle-Cabry67M.js";
import { A as parseBlueBubblesAllowTarget, B as normalizeBlueBubblesServerUrl, D as looksLikeBlueBubblesTargetId, E as looksLikeBlueBubblesExplicitTargetId, F as resolveBlueBubblesEffectiveAllowPrivateNetwork, I as resolveDefaultBlueBubblesAccountId, N as listBlueBubblesAccountIds, O as normalizeBlueBubblesHandle, P as resolveBlueBubblesAccount, S as extractHandleFromChatGuid, a as isMacOS26OrHigher, j as parseBlueBubblesTarget, k as normalizeBlueBubblesMessagingTarget, n as getCachedBlueBubblesPrivateApiStatus, u as asRecord, w as inferBlueBubblesTargetChatType, x as buildBlueBubblesChatContextFromTarget, y as resolveGroupFlagFromChatGuid } from "./probe-95uA8cJS.js";
import "./secret-input-DH8366MN.js";
import { t as BlueBubblesChannelConfigSchema } from "./config-schema-D7J72r7U.js";
import { n as createBlueBubblesConversationBindingManager } from "./conversation-bindings-CZelxcto.js";
import { n as normalizeBlueBubblesAcpConversationId, r as resolveBlueBubblesConversationIdFromTarget, t as matchBlueBubblesAcpConversation } from "./conversation-id-9VBWhVPr.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "./doctor-contract-Cvkc5ZDT.js";
import { n as resolveBlueBubblesGroupToolPolicy, t as resolveBlueBubblesGroupRequireMention } from "./group-policy-B3E9PYP1.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "./secret-contract-BFk2Yza7.js";
import { t as DEFAULT_WEBHOOK_PATH } from "./webhook-shared-3-6rt6ap.js";
//#region extensions/bluebubbles/src/actions-contract.ts
const BLUEBUBBLES_ACTIONS = {
	react: { gate: "reactions" },
	edit: {
		gate: "edit",
		unsupportedOnMacOS26: true
	},
	unsend: { gate: "unsend" },
	reply: { gate: "reply" },
	sendWithEffect: { gate: "sendWithEffect" },
	renameGroup: {
		gate: "renameGroup",
		groupOnly: true
	},
	setGroupIcon: {
		gate: "setGroupIcon",
		groupOnly: true
	},
	addParticipant: {
		gate: "addParticipant",
		groupOnly: true
	},
	removeParticipant: {
		gate: "removeParticipant",
		groupOnly: true
	},
	leaveGroup: {
		gate: "leaveGroup",
		groupOnly: true
	},
	sendAttachment: { gate: "sendAttachment" }
};
const BLUEBUBBLES_ACTION_NAMES = Object.keys(BLUEBUBBLES_ACTIONS);
//#endregion
//#region extensions/bluebubbles/src/actions.ts
const loadBlueBubblesActionsRuntime = createLazyRuntimeNamedExport(() => import("./actions.runtime-dq8aFITy.js"), "blueBubblesActionsRuntime");
const providerId = "bluebubbles";
function mapTarget(raw) {
	const parsed = parseBlueBubblesTarget(raw);
	if (parsed.kind === "chat_guid") return {
		kind: "chat_guid",
		chatGuid: parsed.chatGuid
	};
	if (parsed.kind === "chat_id") return {
		kind: "chat_id",
		chatId: parsed.chatId
	};
	if (parsed.kind === "chat_identifier") return {
		kind: "chat_identifier",
		chatIdentifier: parsed.chatIdentifier
	};
	return {
		kind: "handle",
		address: normalizeBlueBubblesHandle(parsed.to),
		service: parsed.service
	};
}
/**
* Collect any chat-identifying hints the action caller supplied, so short
* message id resolution can reject cross-chat collisions. The order of
* precedence mirrors resolveChatGuid: explicit chat* params first, then the
* `to`/`target` param, then the current session channel as a last resort.
*/
function buildChatContextFromActionParams(params) {
	const explicitChatGuid = readStringParam(params.actionParams, "chatGuid")?.trim();
	const explicitChatIdentifier = readStringParam(params.actionParams, "chatIdentifier")?.trim();
	const explicitChatId = readNumberParam(params.actionParams, "chatId", { integer: true });
	const targetContext = buildBlueBubblesChatContextFromTarget(readStringParam(params.actionParams, "to") ?? readStringParam(params.actionParams, "target") ?? params.currentChannelId ?? void 0);
	return {
		chatGuid: explicitChatGuid || targetContext.chatGuid,
		chatIdentifier: explicitChatIdentifier || targetContext.chatIdentifier,
		chatId: typeof explicitChatId === "number" ? explicitChatId : targetContext.chatId
	};
}
function readMessageText(params) {
	return readStringParam(params, "text") ?? readStringParam(params, "message");
}
/** Supported action names for BlueBubbles */
const SUPPORTED_ACTIONS = new Set([...BLUEBUBBLES_ACTION_NAMES, "upload-file"]);
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
	describeMessageTool: ({ cfg, accountId, currentChannelId }) => {
		const account = resolveBlueBubblesAccount({
			cfg,
			accountId
		});
		if (!account.enabled || !account.configured) return null;
		const gate = createActionGate(account.config.actions);
		const actions = /* @__PURE__ */ new Set();
		const macOS26 = isMacOS26OrHigher(account.accountId);
		const privateApiStatus = getCachedBlueBubblesPrivateApiStatus(account.accountId);
		for (const action of BLUEBUBBLES_ACTION_NAMES) {
			const spec = BLUEBUBBLES_ACTIONS[action];
			if (!spec?.gate) continue;
			if (privateApiStatus === false && PRIVATE_API_ACTIONS.has(action)) continue;
			if ("unsupportedOnMacOS26" in spec && spec.unsupportedOnMacOS26 && macOS26) continue;
			if (gate(spec.gate)) actions.add(action);
		}
		const lowered = normalizeOptionalLowercaseString(currentChannelId ? normalizeBlueBubblesMessagingTarget(currentChannelId) : void 0) ?? "";
		if (!(lowered.startsWith("chat_guid:") || lowered.startsWith("chat_id:") || lowered.startsWith("chat_identifier:") || lowered.startsWith("group:"))) {
			for (const action of BLUEBUBBLES_ACTION_NAMES) if ("groupOnly" in BLUEBUBBLES_ACTIONS[action] && BLUEBUBBLES_ACTIONS[action].groupOnly) actions.delete(action);
		}
		if (actions.delete("sendAttachment")) actions.add("upload-file");
		return { actions: Array.from(actions) };
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
			if (getCachedBlueBubblesPrivateApiStatus(account.accountId) === false) throw new Error(`BlueBubbles ${action} requires Private API, but it is disabled on the BlueBubbles server.`);
		};
		const resolveChatGuid = async () => {
			const chatGuid = readStringParam(params, "chatGuid");
			if (chatGuid?.trim()) return chatGuid.trim();
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
			if (!target) throw new Error(`BlueBubbles ${action} requires chatGuid, chatIdentifier, chatId, or to.`);
			if (!baseUrl || !password) throw new Error(`BlueBubbles ${action} requires serverUrl and password.`);
			const resolved = await runtime.resolveChatGuidForTarget({
				baseUrl,
				password,
				target,
				allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config)
			});
			if (!resolved) throw new Error(`BlueBubbles ${action} failed: chatGuid not found for target.`);
			return resolved;
		};
		if (action === "react") {
			assertPrivateApiEnabled();
			const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Emoji is required to remove a BlueBubbles reaction." });
			if (isEmpty && !remove) throw new Error("BlueBubbles react requires emoji parameter. Use action=react with emoji=<emoji> and messageId=<message_id>.");
			const rawMessageId = readStringParam(params, "messageId");
			if (!rawMessageId) throw new Error("BlueBubbles react requires messageId parameter (the message ID to react to). Use action=react with messageId=<message_id>, emoji=<emoji>, and to/chatGuid to identify the chat.");
			const messageId = runtime.resolveBlueBubblesMessageId(rawMessageId, {
				requireKnownShortId: true,
				chatContext: buildChatContextFromActionParams({
					actionParams: params,
					currentChannelId: toolContext?.currentChannelId
				})
			});
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
			if (isMacOS26OrHigher(accountId ?? void 0)) throw new Error("BlueBubbles edit is not supported on macOS 26 or higher. Apple removed the ability to edit iMessages in this version.");
			const rawMessageId = readStringParam(params, "messageId");
			const newText = readStringParam(params, "text") ?? readStringParam(params, "newText") ?? readStringParam(params, "message");
			if (!rawMessageId || !newText) {
				const missing = [];
				if (!rawMessageId) missing.push("messageId (the message ID to edit)");
				if (!newText) missing.push("text (the new message content)");
				throw new Error(`BlueBubbles edit requires: ${missing.join(", ")}. Use action=edit with messageId=<message_id>, text=<new_content>.`);
			}
			const messageId = runtime.resolveBlueBubblesMessageId(rawMessageId, {
				requireKnownShortId: true,
				chatContext: buildChatContextFromActionParams({
					actionParams: params,
					currentChannelId: toolContext?.currentChannelId
				})
			});
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
			if (!rawMessageId) throw new Error("BlueBubbles unsend requires messageId parameter (the message ID to unsend). Use action=unsend with messageId=<message_id>.");
			const messageId = runtime.resolveBlueBubblesMessageId(rawMessageId, {
				requireKnownShortId: true,
				chatContext: buildChatContextFromActionParams({
					actionParams: params,
					currentChannelId: toolContext?.currentChannelId
				})
			});
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
				if (!rawMessageId) missing.push("messageId (the message ID to reply to)");
				if (!text) missing.push("text or message (the reply message content)");
				if (!to) missing.push("to or target (the chat target)");
				throw new Error(`BlueBubbles reply requires: ${missing.join(", ")}. Use action=reply with messageId=<message_id>, message=<your reply>, target=<chat_target>.`);
			}
			const messageId = runtime.resolveBlueBubblesMessageId(rawMessageId, {
				requireKnownShortId: true,
				chatContext: buildChatContextFromActionParams({
					actionParams: params,
					currentChannelId: toolContext?.currentChannelId
				})
			});
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
				if (!text) missing.push("text or message (the message content)");
				if (!to) missing.push("to or target (the chat target)");
				if (!effectId) missing.push("effectId or effect (e.g., slam, loud, gentle, invisible-ink, confetti, lasers, fireworks, balloons, heart)");
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
			if (!displayName) throw new Error("BlueBubbles renameGroup requires displayName or name parameter.");
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
			if (!base64Buffer) throw new Error("BlueBubbles setGroupIcon requires an image. Use action=setGroupIcon with media=<image_url> or path=<local_file_path> to set the group icon.");
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
			if (!address) throw new Error("BlueBubbles addParticipant requires address or participant parameter.");
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
			if (!address) throw new Error("BlueBubbles removeParticipant requires address or participant parameter.");
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
		if (action === "sendAttachment" || action === "upload-file") {
			const to = readStringParam(params, "to", { required: true });
			const filename = readStringParam(params, "filename", { required: true });
			const caption = readStringParam(params, "caption") ?? readStringParam(params, "message");
			const contentType = readStringParam(params, "contentType") ?? readStringParam(params, "mimeType");
			const asVoice = readBooleanParam(params, "asVoice");
			const base64Buffer = readStringParam(params, "buffer");
			const filePath = readStringParam(params, "path") ?? readStringParam(params, "filePath");
			let buffer;
			if (base64Buffer) buffer = Uint8Array.from(atob(base64Buffer), (c) => c.charCodeAt(0));
			else if (filePath) throw new Error(`BlueBubbles ${action}: filePath not supported in action, provide buffer as base64.`);
			else throw new Error(`BlueBubbles ${action} requires buffer (base64) parameter.`);
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
//#region extensions/bluebubbles/src/channel-shared.ts
const bluebubblesMeta = {
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
};
const bluebubblesCapabilities = {
	chatTypes: ["direct", "group"],
	media: true,
	tts: { voice: {
		synthesisTarget: "audio-file",
		audioFileFormats: [
			"mp3",
			"caf",
			"audio/mpeg",
			"audio/x-caf"
		],
		preferAudioFileFormat: "caf"
	} },
	reactions: true,
	edit: true,
	unsend: true,
	reply: true,
	effects: true,
	groupManagement: true
};
const bluebubblesReload = { configPrefixes: ["channels.bluebubbles"] };
const bluebubblesConfigSchema = BlueBubblesChannelConfigSchema;
const bluebubblesConfigAdapter = createScopedChannelConfigAdapter({
	sectionKey: "bluebubbles",
	listAccountIds: listBlueBubblesAccountIds,
	resolveAccount: adaptScopedAccountAccessor(resolveBlueBubblesAccount),
	defaultAccountId: resolveDefaultBlueBubblesAccountId,
	clearBaseFields: [
		"serverUrl",
		"password",
		"name",
		"webhookPath"
	],
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => formatNormalizedAllowFromEntries({
		allowFrom,
		normalizeEntry: (entry) => normalizeBlueBubblesHandle(entry.replace(/^bluebubbles:/i, ""))
	})
});
function describeBlueBubblesAccount(account) {
	return describeWebhookAccountSnapshot({
		account,
		configured: account.configured,
		extra: { baseUrl: account.baseUrl }
	});
}
//#endregion
//#region extensions/bluebubbles/src/doctor.ts
const bluebubblesDoctor = {
	legacyConfigRules,
	normalizeCompatibilityConfig
};
//#endregion
//#region extensions/bluebubbles/src/pairing.ts
function createBlueBubblesPairingText(sendMessageBlueBubbles) {
	return {
		idLabel: "bluebubblesSenderId",
		message: PAIRING_APPROVED_MESSAGE,
		normalizeAllowEntry: createPairingPrefixStripper(/^bluebubbles:/i, normalizeBlueBubblesHandle),
		notify: async ({ cfg, id, message, accountId }) => {
			await sendMessageBlueBubbles(id, message, {
				cfg,
				accountId
			});
		}
	};
}
//#endregion
//#region extensions/bluebubbles/src/session-route.ts
function resolveBlueBubblesOutboundSessionRoute(params) {
	const stripped = stripChannelTargetPrefix(params.target, "bluebubbles");
	if (!stripped) return null;
	const parsed = parseBlueBubblesTarget(stripped);
	const groupFromChatGuid = parsed.kind === "chat_guid" ? resolveGroupFlagFromChatGuid(parsed.chatGuid) : void 0;
	const isGroup = parsed.kind === "chat_id" || parsed.kind === "chat_identifier" ? true : parsed.kind === "chat_guid" ? groupFromChatGuid ?? true : false;
	const dmHandleFromChatGuid = parsed.kind === "chat_guid" && groupFromChatGuid === false ? extractHandleFromChatGuid(parsed.chatGuid) : null;
	const peerId = parsed.kind === "chat_id" ? String(parsed.chatId) : parsed.kind === "chat_guid" ? dmHandleFromChatGuid ?? parsed.chatGuid : parsed.kind === "chat_identifier" ? parsed.chatIdentifier : parsed.to;
	return buildChannelOutboundSessionRoute({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "bluebubbles",
		accountId: params.accountId,
		peer: {
			kind: isGroup ? "group" : "direct",
			id: peerId
		},
		chatType: isGroup ? "group" : "direct",
		from: isGroup ? `group:${peerId}` : `bluebubbles:${peerId}`,
		to: `bluebubbles:${stripped}`
	});
}
//#endregion
//#region extensions/bluebubbles/src/config-apply.ts
function normalizePatch(patch, onlyDefinedFields) {
	if (!onlyDefinedFields) return patch;
	const next = {};
	if (patch.serverUrl !== void 0) next.serverUrl = patch.serverUrl;
	if (patch.password !== void 0) next.password = patch.password;
	if (patch.webhookPath !== void 0) next.webhookPath = patch.webhookPath;
	return next;
}
function applyBlueBubblesConnectionConfig(params) {
	const patch = normalizePatch(params.patch, params.onlyDefinedFields === true);
	if (params.accountId === "default") return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			bluebubbles: {
				...params.cfg.channels?.bluebubbles,
				enabled: true,
				...patch
			}
		}
	};
	const currentAccount = params.cfg.channels?.bluebubbles?.accounts?.[params.accountId];
	const enabled = params.accountEnabled === "preserve-or-true" ? currentAccount?.enabled ?? true : params.accountEnabled ?? true;
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			bluebubbles: {
				...params.cfg.channels?.bluebubbles,
				enabled: true,
				accounts: {
					...params.cfg.channels?.bluebubbles?.accounts,
					[params.accountId]: {
						...currentAccount,
						enabled,
						...patch
					}
				}
			}
		}
	};
}
//#endregion
//#region extensions/bluebubbles/src/setup-core.ts
const channel$1 = "bluebubbles";
function setBlueBubblesDmPolicy(cfg, accountId, dmPolicy) {
	const resolvedAccountId = normalizeAccountId(accountId);
	const existingAllowFrom = resolvedAccountId === "default" ? cfg.channels?.bluebubbles?.allowFrom : (cfg.channels?.bluebubbles?.accounts?.[resolvedAccountId])?.allowFrom ?? cfg.channels?.bluebubbles?.allowFrom;
	return patchScopedAccountConfig({
		cfg,
		channelKey: channel$1,
		accountId: resolvedAccountId,
		patch: {
			dmPolicy,
			...dmPolicy === "open" ? { allowFrom: addWildcardAllowFrom(existingAllowFrom) } : {}
		},
		ensureChannelEnabled: false,
		ensureAccountEnabled: false
	});
}
function setBlueBubblesAllowFrom(cfg, accountId, allowFrom) {
	return patchScopedAccountConfig({
		cfg,
		channelKey: channel$1,
		accountId,
		patch: { allowFrom },
		ensureChannelEnabled: false,
		ensureAccountEnabled: false
	});
}
const blueBubblesSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => prepareScopedSetupConfig({
		cfg,
		channelKey: channel$1,
		accountId,
		name
	}),
	validateInput: createSetupInputPresenceValidator({ validate: ({ input }) => {
		if (!input.httpUrl && !input.password) return "BlueBubbles requires --http-url and --password.";
		if (!input.httpUrl) return "BlueBubbles requires --http-url.";
		if (!input.password) return "BlueBubbles requires --password.";
		return null;
	} }),
	applyAccountConfig: ({ cfg, accountId, input }) => {
		return applyBlueBubblesConnectionConfig({
			cfg: prepareScopedSetupConfig({
				cfg,
				channelKey: channel$1,
				accountId,
				name: input.name,
				migrateBaseName: true
			}),
			accountId,
			patch: {
				serverUrl: input.httpUrl,
				password: input.password,
				webhookPath: input.webhookPath
			},
			onlyDefinedFields: true
		});
	}
};
//#endregion
//#region extensions/bluebubbles/src/setup-surface.ts
const channel = "bluebubbles";
const CONFIGURE_CUSTOM_WEBHOOK_FLAG = "__bluebubblesConfigureCustomWebhookPath";
function parseBlueBubblesAllowFromInput(raw) {
	return raw.split(/[\n,]+/g).map((entry) => entry.trim()).filter(Boolean);
}
function validateBlueBubblesAllowFromEntry(value) {
	try {
		if (value === "*") return value;
		const parsed = parseBlueBubblesAllowTarget(value);
		if (parsed.kind === "handle" && !parsed.handle) return null;
		return normalizeOptionalString(value) ?? null;
	} catch {
		return null;
	}
}
const promptBlueBubblesAllowFrom = createPromptParsedAllowFromForAccount({
	defaultAccountId: (cfg) => resolveDefaultBlueBubblesAccountId(cfg),
	noteTitle: "BlueBubbles allowlist",
	noteLines: [
		"Allowlist BlueBubbles DMs by handle or chat target.",
		"Examples:",
		"- +15555550123",
		"- user@example.com",
		"- chat_id:123",
		"- chat_guid:iMessage;-;+15555550123",
		"Multiple entries: comma- or newline-separated.",
		`Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`
	],
	message: "BlueBubbles allowFrom (handle or chat_id)",
	placeholder: "+15555550123, user@example.com, chat_id:123",
	parseEntries: (raw) => {
		const entries = parseBlueBubblesAllowFromInput(raw);
		for (const entry of entries) if (!validateBlueBubblesAllowFromEntry(entry)) return {
			entries: [],
			error: `Invalid entry: ${entry}`
		};
		return { entries };
	},
	getExistingAllowFrom: ({ cfg, accountId }) => resolveBlueBubblesAccount({
		cfg,
		accountId
	}).config.allowFrom ?? [],
	applyAllowFrom: ({ cfg, accountId, allowFrom }) => setBlueBubblesAllowFrom(cfg, accountId, allowFrom)
});
function validateBlueBubblesServerUrlInput(value) {
	const trimmed = normalizeOptionalString(value) ?? "";
	if (!trimmed) return "Required";
	try {
		const normalized = normalizeBlueBubblesServerUrl(trimmed);
		if (!URL.canParse(normalized)) return "Invalid URL format";
		return;
	} catch {
		return "Invalid URL format";
	}
}
function applyBlueBubblesSetupPatch(cfg, accountId, patch) {
	return applyBlueBubblesConnectionConfig({
		cfg,
		accountId,
		patch,
		onlyDefinedFields: true,
		accountEnabled: "preserve-or-true"
	});
}
function validateBlueBubblesWebhookPath(value) {
	const trimmed = value.trim();
	if (!trimmed) return "Required";
	if (!trimmed.startsWith("/")) return "Path must start with /";
}
const dmPolicy = {
	label: "BlueBubbles",
	channel,
	policyKey: "channels.bluebubbles.dmPolicy",
	allowFromKey: "channels.bluebubbles.allowFrom",
	resolveConfigKeys: (cfg, accountId) => (accountId ?? resolveDefaultBlueBubblesAccountId(cfg)) !== "default" ? {
		policyKey: `channels.bluebubbles.accounts.${accountId ?? resolveDefaultBlueBubblesAccountId(cfg)}.dmPolicy`,
		allowFromKey: `channels.bluebubbles.accounts.${accountId ?? resolveDefaultBlueBubblesAccountId(cfg)}.allowFrom`
	} : {
		policyKey: "channels.bluebubbles.dmPolicy",
		allowFromKey: "channels.bluebubbles.allowFrom"
	},
	getCurrent: (cfg, accountId) => resolveBlueBubblesAccount({
		cfg,
		accountId: accountId ?? resolveDefaultBlueBubblesAccountId(cfg)
	}).config.dmPolicy ?? "pairing",
	setPolicy: (cfg, policy, accountId) => setBlueBubblesDmPolicy(cfg, accountId ?? resolveDefaultBlueBubblesAccountId(cfg), policy),
	promptAllowFrom: promptBlueBubblesAllowFrom
};
const blueBubblesSetupWizard = {
	channel,
	stepOrder: "text-first",
	status: {
		...createStandardChannelSetupStatus({
			channelLabel: "BlueBubbles",
			configuredLabel: "configured",
			unconfiguredLabel: "needs setup",
			configuredHint: "configured",
			unconfiguredHint: "iMessage via BlueBubbles app",
			configuredScore: 1,
			unconfiguredScore: 0,
			includeStatusLine: true,
			resolveConfigured: ({ cfg, accountId }) => resolveBlueBubblesAccount({
				cfg,
				accountId
			}).configured
		}),
		resolveSelectionHint: ({ configured }) => configured ? "configured" : "iMessage via BlueBubbles app"
	},
	prepare: async ({ cfg, accountId, prompter, credentialValues }) => {
		const existingWebhookPath = normalizeOptionalString(resolveBlueBubblesAccount({
			cfg,
			accountId
		}).config.webhookPath);
		const wantsCustomWebhook = await prompter.confirm({
			message: `Configure a custom webhook path? (default: ${DEFAULT_WEBHOOK_PATH})`,
			initialValue: Boolean(existingWebhookPath && existingWebhookPath !== "/bluebubbles-webhook")
		});
		return {
			cfg: wantsCustomWebhook ? cfg : applyBlueBubblesSetupPatch(cfg, accountId, { webhookPath: DEFAULT_WEBHOOK_PATH }),
			credentialValues: {
				...credentialValues,
				[CONFIGURE_CUSTOM_WEBHOOK_FLAG]: wantsCustomWebhook ? "1" : "0"
			}
		};
	},
	credentials: [{
		inputKey: "password",
		providerHint: channel,
		credentialLabel: "server password",
		helpTitle: "BlueBubbles password",
		helpLines: ["Enter the BlueBubbles server password.", "Find this in the BlueBubbles Server app under Settings."],
		envPrompt: "",
		keepPrompt: "BlueBubbles password already set. Keep it?",
		inputPrompt: "BlueBubbles password",
		inspect: ({ cfg, accountId }) => {
			const existingPassword = resolveBlueBubblesAccount({
				cfg,
				accountId
			}).config.password;
			return {
				accountConfigured: resolveBlueBubblesAccount({
					cfg,
					accountId
				}).configured,
				hasConfiguredValue: hasConfiguredSecretInput(existingPassword),
				resolvedValue: normalizeSecretInputString(existingPassword) ?? void 0
			};
		},
		applySet: async ({ cfg, accountId, value }) => applyBlueBubblesSetupPatch(cfg, accountId, { password: value })
	}],
	textInputs: [{
		inputKey: "httpUrl",
		message: "BlueBubbles server URL",
		placeholder: "http://192.168.1.100:1234",
		helpTitle: "BlueBubbles server URL",
		helpLines: [
			"Enter the BlueBubbles server URL (e.g., http://192.168.1.100:1234).",
			"Find this in the BlueBubbles Server app under Connection.",
			`Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`
		],
		currentValue: ({ cfg, accountId }) => normalizeOptionalString(resolveBlueBubblesAccount({
			cfg,
			accountId
		}).config.serverUrl),
		validate: ({ value }) => validateBlueBubblesServerUrlInput(value),
		normalizeValue: ({ value }) => value.trim(),
		applySet: async ({ cfg, accountId, value }) => applyBlueBubblesSetupPatch(cfg, accountId, { serverUrl: value })
	}, {
		inputKey: "webhookPath",
		message: "Webhook path",
		placeholder: DEFAULT_WEBHOOK_PATH,
		currentValue: ({ cfg, accountId }) => {
			const value = normalizeOptionalString(resolveBlueBubblesAccount({
				cfg,
				accountId
			}).config.webhookPath);
			return value && value !== "/bluebubbles-webhook" ? value : void 0;
		},
		shouldPrompt: ({ credentialValues }) => credentialValues[CONFIGURE_CUSTOM_WEBHOOK_FLAG] === "1",
		validate: ({ value }) => validateBlueBubblesWebhookPath(value),
		normalizeValue: ({ value }) => value.trim(),
		applySet: async ({ cfg, accountId, value }) => applyBlueBubblesSetupPatch(cfg, accountId, { webhookPath: value })
	}],
	completionNote: {
		title: "BlueBubbles next steps",
		lines: [
			"Configure the webhook URL in BlueBubbles Server:",
			"1. Open BlueBubbles Server -> Settings -> Webhooks",
			"2. Add your OpenClaw gateway URL + webhook path",
			`   Example: https://your-gateway-host:3000${DEFAULT_WEBHOOK_PATH}`,
			"3. Enable the webhook and save",
			"",
			`Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`
		]
	},
	dmPolicy,
	allowFrom: createAllowFromSection({
		helpTitle: "BlueBubbles allowlist",
		helpLines: [
			"Allowlist BlueBubbles DMs by handle or chat target.",
			"Examples:",
			"- +15555550123",
			"- user@example.com",
			"- chat_id:123",
			"- chat_guid:iMessage;-;+15555550123",
			"Multiple entries: comma- or newline-separated.",
			`Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`
		],
		message: "BlueBubbles allowFrom (handle or chat_id)",
		placeholder: "+15555550123, user@example.com, chat_id:123",
		invalidWithoutCredentialNote: "Use a BlueBubbles handle or chat target like +15555550123 or chat_id:123.",
		parseInputs: parseBlueBubblesAllowFromInput,
		parseId: (raw) => validateBlueBubblesAllowFromEntry(raw),
		apply: async ({ cfg, accountId, allowFrom }) => setBlueBubblesAllowFrom(cfg, accountId, allowFrom)
	}),
	disable: (cfg) => ({
		...cfg,
		channels: {
			...cfg.channels,
			bluebubbles: {
				...cfg.channels?.bluebubbles,
				enabled: false
			}
		}
	})
};
//#endregion
//#region extensions/bluebubbles/src/status-issues.ts
function asString(value) {
	return typeof value === "string" && value.length > 0 ? value : null;
}
function readBlueBubblesAccountStatus(value) {
	const record = asRecord(value);
	if (!record) return null;
	return {
		accountId: record.accountId,
		enabled: record.enabled,
		configured: record.configured,
		running: record.running,
		baseUrl: record.baseUrl,
		lastError: record.lastError,
		probe: record.probe
	};
}
function readBlueBubblesProbeResult(value) {
	const record = asRecord(value);
	if (!record) return null;
	return {
		ok: typeof record.ok === "boolean" ? record.ok : void 0,
		status: typeof record.status === "number" ? record.status : null,
		error: asString(record.error) ?? null
	};
}
function collectBlueBubblesStatusIssues(accounts) {
	return collectIssuesForEnabledAccounts({
		accounts,
		readAccount: readBlueBubblesAccountStatus,
		collectIssues: ({ account, accountId, issues }) => {
			const configured = account.configured === true;
			const running = account.running === true;
			const lastError = asString(account.lastError);
			const probe = readBlueBubblesProbeResult(account.probe);
			if (!configured) {
				issues.push({
					channel: "bluebubbles",
					accountId,
					kind: "config",
					message: "Not configured (missing serverUrl or password).",
					fix: "Run: openclaw channels add bluebubbles --http-url <server-url> --password <password>"
				});
				return;
			}
			if (probe && probe.ok === false) {
				const errorDetail = probe.error ? `: ${probe.error}` : probe.status ? ` (HTTP ${probe.status})` : "";
				issues.push({
					channel: "bluebubbles",
					accountId,
					kind: "runtime",
					message: `BlueBubbles server unreachable${errorDetail}`,
					fix: "Check that the BlueBubbles server is running and accessible. Verify serverUrl and password in your config."
				});
			}
			if (running && lastError) issues.push({
				channel: "bluebubbles",
				accountId,
				kind: "runtime",
				message: `Channel error: ${lastError}`,
				fix: "Check gateway logs for details. If the webhook is failing, verify the webhook URL is configured in BlueBubbles server settings."
			});
		}
	});
}
//#endregion
//#region extensions/bluebubbles/src/channel.ts
const loadBlueBubblesChannelRuntime = createLazyRuntimeNamedExport(() => import("./channel.runtime-DEtCVjYF.js"), "blueBubblesChannelRuntime");
const resolveBlueBubblesDmPolicy = createScopedDmSecurityResolver({
	channelKey: "bluebubbles",
	resolvePolicy: (account) => account.config.dmPolicy,
	resolveAllowFrom: (account) => account.config.allowFrom,
	policyPathSuffix: "dmPolicy",
	normalizeEntry: (raw) => normalizeBlueBubblesHandle(raw.replace(/^bluebubbles:/i, ""))
});
const collectBlueBubblesSecurityWarnings = createOpenGroupPolicyRestrictSendersWarningCollector({
	resolveGroupPolicy: (account) => account.config.groupPolicy,
	defaultGroupPolicy: "allowlist",
	surface: "BlueBubbles groups",
	openScope: "any member",
	groupPolicyPath: "channels.bluebubbles.groupPolicy",
	groupAllowFromPath: "channels.bluebubbles.groupAllowFrom",
	mentionGated: false
});
const bluebubblesPlugin = createChatChannelPlugin({
	base: {
		id: "bluebubbles",
		meta: bluebubblesMeta,
		capabilities: bluebubblesCapabilities,
		groups: {
			resolveRequireMention: resolveBlueBubblesGroupRequireMention,
			resolveToolPolicy: resolveBlueBubblesGroupToolPolicy
		},
		reload: bluebubblesReload,
		configSchema: bluebubblesConfigSchema,
		setupWizard: blueBubblesSetupWizard,
		config: {
			...bluebubblesConfigAdapter,
			isConfigured: (account) => account.configured,
			describeAccount: (account) => describeBlueBubblesAccount(account)
		},
		doctor: bluebubblesDoctor,
		conversationBindings: {
			supportsCurrentConversationBinding: true,
			createManager: ({ cfg, accountId }) => createBlueBubblesConversationBindingManager({
				cfg,
				accountId: accountId ?? void 0
			})
		},
		actions: bluebubblesMessageActions,
		secrets: {
			secretTargetRegistryEntries,
			collectRuntimeConfigAssignments
		},
		bindings: {
			compileConfiguredBinding: ({ conversationId }) => normalizeBlueBubblesAcpConversationId(conversationId),
			matchInboundConversation: ({ compiledBinding, conversationId }) => matchBlueBubblesAcpConversation({
				bindingConversationId: compiledBinding.conversationId,
				conversationId
			}),
			resolveCommandConversation: ({ originatingTo, commandTo, fallbackTo }) => {
				const conversationId = resolveBlueBubblesConversationIdFromTarget(originatingTo ?? "") ?? resolveBlueBubblesConversationIdFromTarget(commandTo ?? "") ?? resolveBlueBubblesConversationIdFromTarget(fallbackTo ?? "");
				return conversationId ? { conversationId } : null;
			}
		},
		messaging: {
			targetPrefixes: ["bluebubbles"],
			normalizeTarget: normalizeBlueBubblesMessagingTarget,
			inferTargetChatType: ({ to }) => inferBlueBubblesTargetChatType(to),
			resolveOutboundSessionRoute: (params) => resolveBlueBubblesOutboundSessionRoute(params),
			targetResolver: {
				looksLikeId: looksLikeBlueBubblesExplicitTargetId,
				hint: "<handle|chat_guid:GUID|chat_id:ID|chat_identifier:ID>",
				resolveTarget: async ({ normalized }) => {
					const to = normalizeOptionalString(normalized);
					if (!to) return null;
					const chatType = inferBlueBubblesTargetChatType(to);
					if (!chatType) return null;
					return {
						to,
						kind: chatType === "direct" ? "user" : "group",
						source: "normalized"
					};
				}
			},
			formatTargetDisplay: ({ target, display }) => {
				const shouldParseDisplay = (value) => {
					if (looksLikeBlueBubblesTargetId(value)) return true;
					return /^(bluebubbles:|chat_guid:|chat_id:|chat_identifier:)/i.test(value);
				};
				const extractCleanDisplay = (value) => {
					const trimmed = normalizeOptionalString(value);
					if (!trimmed) return null;
					try {
						const parsed = parseBlueBubblesTarget(trimmed);
						if (parsed.kind === "chat_guid") {
							const handle = extractHandleFromChatGuid(parsed.chatGuid);
							if (handle) return handle;
						}
						if (parsed.kind === "handle") return normalizeBlueBubblesHandle(parsed.to);
					} catch {}
					const stripped = trimmed.replace(/^bluebubbles:/i, "").replace(/^chat_guid:/i, "").replace(/^chat_id:/i, "").replace(/^chat_identifier:/i, "");
					const handle = extractHandleFromChatGuid(stripped);
					if (handle) return handle;
					if (stripped.includes(";-;") || stripped.includes(";+;")) return null;
					return stripped;
				};
				const trimmedDisplay = normalizeOptionalString(display);
				if (trimmedDisplay) {
					if (!shouldParseDisplay(trimmedDisplay)) return trimmedDisplay;
					const cleanDisplay = extractCleanDisplay(trimmedDisplay);
					if (cleanDisplay) return cleanDisplay;
				}
				const cleanTarget = extractCleanDisplay(target);
				if (cleanTarget) return cleanTarget;
				return normalizeOptionalString(display) || normalizeOptionalString(target) || "";
			}
		},
		setup: blueBubblesSetupAdapter,
		status: createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
			collectStatusIssues: collectBlueBubblesStatusIssues,
			buildChannelSummary: ({ snapshot }) => buildProbeChannelStatusSummary(snapshot, { baseUrl: snapshot.baseUrl ?? null }),
			probeAccount: async ({ account, timeoutMs }) => (await loadBlueBubblesChannelRuntime()).probeBlueBubbles({
				baseUrl: account.baseUrl,
				password: account.config.password ?? null,
				timeoutMs,
				allowPrivateNetwork: resolveBlueBubblesEffectiveAllowPrivateNetwork({
					baseUrl: account.baseUrl,
					config: account.config
				})
			}),
			resolveAccountSnapshot: ({ account, runtime, probe }) => {
				const running = runtime?.running ?? false;
				const probeOk = probe?.ok;
				return {
					accountId: account.accountId,
					name: account.name,
					enabled: account.enabled,
					configured: account.configured,
					extra: {
						baseUrl: account.baseUrl,
						connected: probeOk ?? running
					}
				};
			}
		}),
		gateway: { startAccount: async (ctx) => {
			const runtime = await loadBlueBubblesChannelRuntime();
			const account = ctx.account;
			const conversationBindings = createBlueBubblesConversationBindingManager({
				cfg: ctx.cfg,
				accountId: ctx.accountId
			});
			const webhookPath = runtime.resolveWebhookPathFromConfig(account.config);
			const statusSink = createAccountStatusSink({
				accountId: ctx.accountId,
				setStatus: ctx.setStatus
			});
			statusSink({ baseUrl: account.baseUrl });
			ctx.log?.info(`[${account.accountId}] starting provider (webhook=${webhookPath})`);
			try {
				return await runtime.monitorBlueBubblesProvider({
					account,
					config: ctx.cfg,
					runtime: ctx.runtime,
					abortSignal: ctx.abortSignal,
					statusSink,
					webhookPath
				});
			} finally {
				conversationBindings.stop();
			}
		} }
	},
	security: {
		resolveDmPolicy: resolveBlueBubblesDmPolicy,
		collectWarnings: projectAccountWarningCollector(collectBlueBubblesSecurityWarnings)
	},
	threading: { buildToolContext: ({ context, hasRepliedRef }) => ({
		currentChannelId: normalizeOptionalString(context.To),
		currentThreadTs: context.ReplyToIdFull ?? context.ReplyToId,
		hasRepliedRef
	}) },
	pairing: { text: createBlueBubblesPairingText(async (id, message, params) => {
		await (await loadBlueBubblesChannelRuntime()).sendMessageBlueBubbles(id, message, params);
	}) },
	outbound: {
		base: {
			deliveryMode: "direct",
			textChunkLimit: 4e3,
			resolveTarget: ({ to }) => {
				const trimmed = normalizeOptionalString(to);
				if (!trimmed) return {
					ok: false,
					error: /* @__PURE__ */ new Error("Delivering to BlueBubbles requires --to <handle|chat_guid:GUID>")
				};
				return {
					ok: true,
					to: trimmed
				};
			}
		},
		attachedResults: {
			channel: "bluebubbles",
			sendText: async ({ cfg, to, text, accountId, replyToId }) => {
				const runtime = await loadBlueBubblesChannelRuntime();
				const rawReplyToId = normalizeOptionalString(replyToId) ?? "";
				const replyToMessageGuid = rawReplyToId ? runtime.resolveBlueBubblesMessageId(rawReplyToId, {
					requireKnownShortId: true,
					chatContext: buildBlueBubblesChatContextFromTarget(to)
				}) : "";
				return await runtime.sendMessageBlueBubbles(to, text, {
					cfg,
					accountId: accountId ?? void 0,
					replyToMessageGuid: replyToMessageGuid || void 0
				});
			},
			sendMedia: async (ctx) => {
				const runtime = await loadBlueBubblesChannelRuntime();
				const { cfg, to, text, mediaUrl, accountId, replyToId, audioAsVoice } = ctx;
				const { mediaPath, mediaBuffer, contentType, filename, caption } = ctx;
				return await runtime.sendBlueBubblesMedia({
					cfg,
					to,
					mediaUrl,
					mediaPath,
					mediaBuffer,
					contentType,
					filename,
					caption: caption ?? text ?? void 0,
					replyToId: replyToId ?? null,
					accountId: accountId ?? void 0,
					asVoice: audioAsVoice === true
				});
			}
		}
	}
});
//#endregion
export { bluebubblesCapabilities as a, bluebubblesMeta as c, blueBubblesSetupAdapter as i, bluebubblesReload as l, collectBlueBubblesStatusIssues as n, bluebubblesConfigAdapter as o, blueBubblesSetupWizard as r, bluebubblesConfigSchema as s, bluebubblesPlugin as t, describeBlueBubblesAccount as u };
