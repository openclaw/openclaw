import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import { g as DEFAULT_ACCOUNT_ID } from "../../session-key-BSZsryCD.js";
import { Kn as clearAccountEntryFields, Zn as buildChannelConfigSchema } from "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../paths-DAoqckDF.js";
import { Am as createScopedAccountConfigAccessors, Fr as createReceiptCard, Gd as buildComputedAccountStatusSnapshot, Ir as attachFooterText, Jd as buildTokenChannelStatusSummary, Mm as createScopedDmSecurityResolver, Nr as processLineMessage, O as collectAllowlistProviderRestrictSendersWarnings, jm as createScopedChannelConfigBase, y as createPluginRuntimeStore } from "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../resolve-utils-D6VN4BvH.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import "../../compat-CwB8x8Tr.js";
import "../../inbound-envelope-DsYY1Vpm.js";
import "../../run-command-B9zmAfEF.js";
import "../../device-pairing-CsJif6Rb.js";
import { n as lineSetupWizard, r as lineSetupAdapter, t as LineConfigSchema } from "../../line-DvbTO_h3.js";
import "../../upsert-with-lock-BkGBN4WL.js";
import "../../self-hosted-provider-setup-Bgv4n1Xv.js";
import "../../ollama-setup-CXkNt6CA.js";
//#region src/line/flex-templates/basic-cards.ts
/**
* Create an info card with title, body, and optional footer
*
* Editorial design: Clean hierarchy with accent bar, generous spacing,
* and subtle background zones for visual separation.
*/
function createInfoCard(title, body, footer) {
	const bubble = {
		type: "bubble",
		size: "mega",
		body: {
			type: "box",
			layout: "vertical",
			contents: [{
				type: "box",
				layout: "horizontal",
				contents: [{
					type: "box",
					layout: "vertical",
					contents: [],
					width: "4px",
					backgroundColor: "#06C755",
					cornerRadius: "2px"
				}, {
					type: "text",
					text: title,
					weight: "bold",
					size: "xl",
					color: "#111111",
					wrap: true,
					flex: 1,
					margin: "lg"
				}]
			}, {
				type: "box",
				layout: "vertical",
				contents: [{
					type: "text",
					text: body,
					size: "md",
					color: "#444444",
					wrap: true,
					lineSpacing: "6px"
				}],
				margin: "xl",
				paddingAll: "lg",
				backgroundColor: "#F8F9FA",
				cornerRadius: "lg"
			}],
			paddingAll: "xl",
			backgroundColor: "#FFFFFF"
		}
	};
	if (footer) attachFooterText(bubble, footer);
	return bubble;
}
/**
* Create a list card with title and multiple items
*
* Editorial design: Numbered/bulleted list with clear visual hierarchy,
* accent dots for each item, and generous spacing.
*/
function createListCard(title, items) {
	const itemContents = items.slice(0, 8).map((item, index) => {
		const itemContents = [{
			type: "text",
			text: item.title,
			size: "md",
			weight: "bold",
			color: "#1a1a1a",
			wrap: true
		}];
		if (item.subtitle) itemContents.push({
			type: "text",
			text: item.subtitle,
			size: "sm",
			color: "#888888",
			wrap: true,
			margin: "xs"
		});
		const itemBox = {
			type: "box",
			layout: "horizontal",
			contents: [{
				type: "box",
				layout: "vertical",
				contents: [{
					type: "box",
					layout: "vertical",
					contents: [],
					width: "8px",
					height: "8px",
					backgroundColor: index === 0 ? "#06C755" : "#DDDDDD",
					cornerRadius: "4px"
				}],
				width: "20px",
				alignItems: "center",
				paddingTop: "sm"
			}, {
				type: "box",
				layout: "vertical",
				contents: itemContents,
				flex: 1
			}],
			margin: index > 0 ? "lg" : void 0
		};
		if (item.action) itemBox.action = item.action;
		return itemBox;
	});
	return {
		type: "bubble",
		size: "mega",
		body: {
			type: "box",
			layout: "vertical",
			contents: [
				{
					type: "text",
					text: title,
					weight: "bold",
					size: "xl",
					color: "#111111",
					wrap: true
				},
				{
					type: "separator",
					margin: "lg",
					color: "#EEEEEE"
				},
				{
					type: "box",
					layout: "vertical",
					contents: itemContents,
					margin: "lg"
				}
			],
			paddingAll: "xl",
			backgroundColor: "#FFFFFF"
		}
	};
}
/**
* Create an image card with image, title, and optional body text
*/
function createImageCard(imageUrl, title, body, options) {
	const bubble = {
		type: "bubble",
		hero: {
			type: "image",
			url: imageUrl,
			size: "full",
			aspectRatio: options?.aspectRatio ?? "20:13",
			aspectMode: options?.aspectMode ?? "cover",
			action: options?.action
		},
		body: {
			type: "box",
			layout: "vertical",
			contents: [{
				type: "text",
				text: title,
				weight: "bold",
				size: "xl",
				wrap: true
			}],
			paddingAll: "lg"
		}
	};
	if (body && bubble.body) bubble.body.contents.push({
		type: "text",
		text: body,
		size: "md",
		wrap: true,
		margin: "md",
		color: "#666666"
	});
	return bubble;
}
/**
* Create an action card with title, body, and action buttons
*/
function createActionCard(title, body, actions, options) {
	const bubble = {
		type: "bubble",
		body: {
			type: "box",
			layout: "vertical",
			contents: [{
				type: "text",
				text: title,
				weight: "bold",
				size: "xl",
				wrap: true
			}, {
				type: "text",
				text: body,
				size: "md",
				wrap: true,
				margin: "md",
				color: "#666666"
			}],
			paddingAll: "lg"
		},
		footer: {
			type: "box",
			layout: "vertical",
			contents: actions.slice(0, 4).map((action, index) => ({
				type: "button",
				action: action.action,
				style: index === 0 ? "primary" : "secondary",
				margin: index > 0 ? "sm" : void 0
			})),
			paddingAll: "md"
		}
	};
	if (options?.imageUrl) bubble.hero = {
		type: "image",
		url: options.imageUrl,
		size: "full",
		aspectRatio: options.aspectRatio ?? "20:13",
		aspectMode: "cover"
	};
	return bubble;
}
//#endregion
//#region extensions/line/src/card-command.ts
const CARD_USAGE = `Usage: /card <type> "title" "body" [options]

Types:
  info "Title" "Body" ["Footer"]
  image "Title" "Caption" --url <image-url>
  action "Title" "Body" --actions "Btn1|url1,Btn2|text2"
  list "Title" "Item1|Desc1,Item2|Desc2"
  receipt "Title" "Item1:$10,Item2:$20" --total "$30"
  confirm "Question?" --yes "Yes|data" --no "No|data"
  buttons "Title" "Text" --actions "Btn1|url1,Btn2|data2"

Examples:
  /card info "Welcome" "Thanks for joining!"
  /card image "Product" "Check it out" --url https://example.com/img.jpg
  /card action "Menu" "Choose an option" --actions "Order|/order,Help|/help"`;
function buildLineReply(lineData) {
	return { channelData: { line: lineData } };
}
/**
* Parse action string format: "Label|data,Label2|data2"
* Data can be a URL (uri action) or plain text (message action) or key=value (postback)
*/
function parseActions(actionsStr) {
	if (!actionsStr) return [];
	const results = [];
	for (const part of actionsStr.split(",")) {
		const [label, data] = part.trim().split("|").map((s) => s.trim());
		if (!label) continue;
		const actionData = data || label;
		if (actionData.startsWith("http://") || actionData.startsWith("https://")) results.push({
			label,
			action: {
				type: "uri",
				label: label.slice(0, 20),
				uri: actionData
			}
		});
		else if (actionData.includes("=")) results.push({
			label,
			action: {
				type: "postback",
				label: label.slice(0, 20),
				data: actionData.slice(0, 300),
				displayText: label
			}
		});
		else results.push({
			label,
			action: {
				type: "message",
				label: label.slice(0, 20),
				text: actionData
			}
		});
	}
	return results;
}
/**
* Parse list items format: "Item1|Subtitle1,Item2|Subtitle2"
*/
function parseListItems(itemsStr) {
	return itemsStr.split(",").map((part) => {
		const [title, subtitle] = part.trim().split("|").map((s) => s.trim());
		return {
			title: title || "",
			subtitle
		};
	}).filter((item) => item.title);
}
/**
* Parse receipt items format: "Item1:$10,Item2:$20"
*/
function parseReceiptItems(itemsStr) {
	return itemsStr.split(",").map((part) => {
		const colonIndex = part.lastIndexOf(":");
		if (colonIndex === -1) return {
			name: part.trim(),
			value: ""
		};
		return {
			name: part.slice(0, colonIndex).trim(),
			value: part.slice(colonIndex + 1).trim()
		};
	}).filter((item) => item.name);
}
/**
* Parse quoted arguments from command string
* Supports: /card type "arg1" "arg2" "arg3" --flag value
*/
function parseCardArgs(argsStr) {
	const result = {
		type: "",
		args: [],
		flags: {}
	};
	const typeMatch = argsStr.match(/^(\w+)/);
	if (typeMatch) {
		result.type = typeMatch[1].toLowerCase();
		argsStr = argsStr.slice(typeMatch[0].length).trim();
	}
	const quotedRegex = /"([^"]*?)"/g;
	let match;
	while ((match = quotedRegex.exec(argsStr)) !== null) result.args.push(match[1]);
	const flagRegex = /--(\w+)\s+(?:"([^"]*?)"|(\S+))/g;
	while ((match = flagRegex.exec(argsStr)) !== null) result.flags[match[1]] = match[2] ?? match[3];
	return result;
}
function registerLineCardCommand(api) {
	api.registerCommand({
		name: "card",
		description: "Send a rich card message (LINE).",
		acceptsArgs: true,
		requireAuth: false,
		handler: async (ctx) => {
			const argsStr = ctx.args?.trim() ?? "";
			if (!argsStr) return { text: CARD_USAGE };
			const { type, args, flags } = parseCardArgs(argsStr);
			if (!type) return { text: CARD_USAGE };
			if (ctx.channel !== "line") return { text: `[${type} card] ${args.join(" - ")}`.trim() };
			try {
				switch (type) {
					case "info": {
						const [title = "Info", body = "", footer] = args;
						const bubble = createInfoCard(title, body, footer);
						return buildLineReply({ flexMessage: {
							altText: `${title}: ${body}`.slice(0, 400),
							contents: bubble
						} });
					}
					case "image": {
						const [title = "Image", caption = ""] = args;
						const imageUrl = flags.url || flags.image;
						if (!imageUrl) return { text: "Error: Image card requires --url <image-url>" };
						const bubble = createImageCard(imageUrl, title, caption);
						return buildLineReply({ flexMessage: {
							altText: `${title}: ${caption}`.slice(0, 400),
							contents: bubble
						} });
					}
					case "action": {
						const [title = "Actions", body = ""] = args;
						const actions = parseActions(flags.actions);
						if (actions.length === 0) return { text: "Error: Action card requires --actions \"Label1|data1,Label2|data2\"" };
						const bubble = createActionCard(title, body, actions, { imageUrl: flags.url || flags.image });
						return buildLineReply({ flexMessage: {
							altText: `${title}: ${body}`.slice(0, 400),
							contents: bubble
						} });
					}
					case "list": {
						const [title = "List", itemsStr = ""] = args;
						const items = parseListItems(itemsStr || flags.items || "");
						if (items.length === 0) return { text: "Error: List card requires items. Usage: /card list \"Title\" \"Item1|Desc1,Item2|Desc2\"" };
						const bubble = createListCard(title, items);
						return buildLineReply({ flexMessage: {
							altText: `${title}: ${items.map((i) => i.title).join(", ")}`.slice(0, 400),
							contents: bubble
						} });
					}
					case "receipt": {
						const [title = "Receipt", itemsStr = ""] = args;
						const items = parseReceiptItems(itemsStr || flags.items || "");
						const total = flags.total ? {
							label: "Total",
							value: flags.total
						} : void 0;
						const footer = flags.footer;
						if (items.length === 0) return { text: "Error: Receipt card requires items. Usage: /card receipt \"Title\" \"Item1:$10,Item2:$20\" --total \"$30\"" };
						const bubble = createReceiptCard({
							title,
							items,
							total,
							footer
						});
						return buildLineReply({ flexMessage: {
							altText: `${title}: ${items.map((i) => `${i.name} ${i.value}`).join(", ")}`.slice(0, 400),
							contents: bubble
						} });
					}
					case "confirm": {
						const [question = "Confirm?"] = args;
						const yesStr = flags.yes || "Yes|yes";
						const noStr = flags.no || "No|no";
						const [yesLabel, yesData] = yesStr.split("|").map((s) => s.trim());
						const [noLabel, noData] = noStr.split("|").map((s) => s.trim());
						return buildLineReply({ templateMessage: {
							type: "confirm",
							text: question,
							confirmLabel: yesLabel || "Yes",
							confirmData: yesData || "yes",
							cancelLabel: noLabel || "No",
							cancelData: noData || "no",
							altText: question
						} });
					}
					case "buttons": {
						const [title = "Menu", text = "Choose an option"] = args;
						const actionParts = parseActions(flags.actions || "");
						if (actionParts.length === 0) return { text: "Error: Buttons card requires --actions \"Label1|data1,Label2|data2\"" };
						const templateActions = actionParts.map((a) => {
							const action = a.action;
							const label = action.label ?? a.label;
							if (action.type === "uri") return {
								type: "uri",
								label,
								uri: action.uri
							};
							if (action.type === "postback") return {
								type: "postback",
								label,
								data: action.data
							};
							return {
								type: "message",
								label,
								data: action.text
							};
						});
						return buildLineReply({ templateMessage: {
							type: "buttons",
							title,
							text,
							thumbnailImageUrl: flags.url || flags.image,
							actions: templateActions
						} });
					}
					default: return { text: `Unknown card type: "${type}". Available types: info, image, action, list, receipt, confirm, buttons` };
				}
			} catch (err) {
				return { text: `Error creating card: ${String(err)}` };
			}
		}
	});
}
//#endregion
//#region extensions/line/src/runtime.ts
const { setRuntime: setLineRuntime, getRuntime: getLineRuntime } = createPluginRuntimeStore("LINE runtime not initialized - plugin not registered");
//#endregion
//#region extensions/line/src/channel.ts
const meta = {
	id: "line",
	label: "LINE",
	selectionLabel: "LINE (Messaging API)",
	detailLabel: "LINE Bot",
	docsPath: "/channels/line",
	docsLabel: "line",
	blurb: "LINE Messaging API bot for Japan/Taiwan/Thailand markets.",
	systemImage: "message.fill"
};
const lineConfigAccessors = createScopedAccountConfigAccessors({
	resolveAccount: ({ cfg, accountId }) => getLineRuntime().channel.line.resolveLineAccount({
		cfg,
		accountId: accountId ?? void 0
	}),
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => entry.replace(/^line:(?:user:)?/i, ""))
});
const lineConfigBase = createScopedChannelConfigBase({
	sectionKey: "line",
	listAccountIds: (cfg) => getLineRuntime().channel.line.listLineAccountIds(cfg),
	resolveAccount: (cfg, accountId) => getLineRuntime().channel.line.resolveLineAccount({
		cfg,
		accountId: accountId ?? void 0
	}),
	defaultAccountId: (cfg) => getLineRuntime().channel.line.resolveDefaultLineAccountId(cfg),
	clearBaseFields: [
		"channelSecret",
		"tokenFile",
		"secretFile"
	]
});
const resolveLineDmPolicy = createScopedDmSecurityResolver({
	channelKey: "line",
	resolvePolicy: (account) => account.config.dmPolicy,
	resolveAllowFrom: (account) => account.config.allowFrom,
	policyPathSuffix: "dmPolicy",
	approveHint: "openclaw pairing approve line <code>",
	normalizeEntry: (raw) => raw.replace(/^line:(?:user:)?/i, "")
});
const linePlugin = {
	id: "line",
	meta: {
		...meta,
		quickstartAllowFrom: true
	},
	pairing: {
		idLabel: "lineUserId",
		normalizeAllowEntry: (entry) => {
			return entry.replace(/^line:(?:user:)?/i, "");
		},
		notifyApproval: async ({ cfg, id }) => {
			const line = getLineRuntime().channel.line;
			const account = line.resolveLineAccount({ cfg });
			if (!account.channelAccessToken) throw new Error("LINE channel access token not configured");
			await line.pushMessageLine(id, "OpenClaw: your access has been approved.", { channelAccessToken: account.channelAccessToken });
		}
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
	configSchema: buildChannelConfigSchema(LineConfigSchema),
	setupWizard: lineSetupWizard,
	config: {
		...lineConfigBase,
		isConfigured: (account) => Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim()),
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim()),
			tokenSource: account.tokenSource ?? void 0
		}),
		...lineConfigAccessors
	},
	security: {
		resolveDmPolicy: resolveLineDmPolicy,
		collectWarnings: ({ account, cfg }) => {
			return collectAllowlistProviderRestrictSendersWarnings({
				cfg,
				providerConfigPresent: cfg.channels?.line !== void 0,
				configuredGroupPolicy: account.config.groupPolicy,
				surface: "LINE groups",
				openScope: "any member in groups",
				groupPolicyPath: "channels.line.groupPolicy",
				groupAllowFromPath: "channels.line.groupAllowFrom",
				mentionGated: false
			});
		}
	},
	groups: { resolveRequireMention: ({ cfg, accountId, groupId }) => {
		const groups = getLineRuntime().channel.line.resolveLineAccount({
			cfg,
			accountId: accountId ?? void 0
		}).config.groups;
		if (!groups || !groupId) return false;
		return (groups[groupId] ?? groups["*"])?.requireMention ?? false;
	} },
	messaging: {
		normalizeTarget: (target) => {
			const trimmed = target.trim();
			if (!trimmed) return;
			return trimmed.replace(/^line:(group|room|user):/i, "").replace(/^line:/i, "");
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
	directory: {
		self: async () => null,
		listPeers: async () => [],
		listGroups: async () => []
	},
	setup: lineSetupAdapter,
	outbound: {
		deliveryMode: "direct",
		chunker: (text, limit) => getLineRuntime().channel.text.chunkMarkdownText(text, limit),
		textChunkLimit: 5e3,
		sendPayload: async ({ to, payload, accountId, cfg }) => {
			const runtime = getLineRuntime();
			const lineData = payload.channelData?.line ?? {};
			const sendText = runtime.channel.line.pushMessageLine;
			const sendBatch = runtime.channel.line.pushMessagesLine;
			const sendFlex = runtime.channel.line.pushFlexMessage;
			const sendTemplate = runtime.channel.line.pushTemplateMessage;
			const sendLocation = runtime.channel.line.pushLocationMessage;
			const sendQuickReplies = runtime.channel.line.pushTextMessageWithQuickReplies;
			const buildTemplate = runtime.channel.line.buildTemplateMessageFromPayload;
			const createQuickReplyItems = runtime.channel.line.createQuickReplyItems;
			let lastResult = null;
			const quickReplies = lineData.quickReplies ?? [];
			const hasQuickReplies = quickReplies.length > 0;
			const quickReply = hasQuickReplies ? createQuickReplyItems(quickReplies) : void 0;
			const sendMessageBatch = async (messages) => {
				if (messages.length === 0) return;
				for (let i = 0; i < messages.length; i += 5) {
					const result = await sendBatch(to, messages.slice(i, i + 5), {
						verbose: false,
						cfg,
						accountId: accountId ?? void 0
					});
					lastResult = {
						messageId: result.messageId,
						chatId: result.chatId
					};
				}
			};
			const processed = payload.text ? processLineMessage(payload.text) : {
				text: "",
				flexMessages: []
			};
			const chunkLimit = runtime.channel.text.resolveTextChunkLimit?.(cfg, "line", accountId ?? void 0, { fallbackLimit: 5e3 }) ?? 5e3;
			const chunks = processed.text ? runtime.channel.text.chunkMarkdownText(processed.text, chunkLimit) : [];
			const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
			const shouldSendQuickRepliesInline = chunks.length === 0 && hasQuickReplies;
			const sendMediaMessages = async () => {
				for (const url of mediaUrls) lastResult = await runtime.channel.line.sendMessageLine(to, "", {
					verbose: false,
					mediaUrl: url,
					cfg,
					accountId: accountId ?? void 0
				});
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
					quickReplyMessages.push({
						type: "image",
						originalContentUrl: trimmed,
						previewImageUrl: trimmed
					});
				}
				if (quickReplyMessages.length > 0 && quickReply) {
					const lastIndex = quickReplyMessages.length - 1;
					quickReplyMessages[lastIndex] = {
						...quickReplyMessages[lastIndex],
						quickReply
					};
					await sendMessageBatch(quickReplyMessages);
				}
			}
			if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && sendMediaAfterText) await sendMediaMessages();
			if (lastResult) return {
				channel: "line",
				...lastResult
			};
			return {
				channel: "line",
				messageId: "empty",
				chatId: to
			};
		},
		sendText: async ({ cfg, to, text, accountId }) => {
			const runtime = getLineRuntime();
			const sendText = runtime.channel.line.pushMessageLine;
			const sendFlex = runtime.channel.line.pushFlexMessage;
			const processed = processLineMessage(text);
			let result;
			if (processed.text.trim()) result = await sendText(to, processed.text, {
				verbose: false,
				cfg,
				accountId: accountId ?? void 0
			});
			else result = {
				messageId: "processed",
				chatId: to
			};
			for (const flexMsg of processed.flexMessages) {
				const flexContents = flexMsg.contents;
				await sendFlex(to, flexMsg.altText, flexContents, {
					verbose: false,
					cfg,
					accountId: accountId ?? void 0
				});
			}
			return {
				channel: "line",
				...result
			};
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
			const send = getLineRuntime().channel.line.sendMessageLine;
			return {
				channel: "line",
				...await send(to, text, {
					verbose: false,
					mediaUrl,
					cfg,
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
		collectStatusIssues: (accounts) => {
			const issues = [];
			for (const account of accounts) {
				const accountId = account.accountId ?? "default";
				if (!account.channelAccessToken?.trim()) issues.push({
					channel: "line",
					accountId,
					kind: "config",
					message: "LINE channel access token not configured"
				});
				if (!account.channelSecret?.trim()) issues.push({
					channel: "line",
					accountId,
					kind: "config",
					message: "LINE channel secret not configured"
				});
			}
			return issues;
		},
		buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
		probeAccount: async ({ account, timeoutMs }) => getLineRuntime().channel.line.probeLineBot(account.channelAccessToken, timeoutMs),
		buildAccountSnapshot: ({ account, runtime, probe }) => {
			const configured = Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim());
			return {
				...buildComputedAccountStatusSnapshot({
					accountId: account.accountId,
					name: account.name,
					enabled: account.enabled,
					configured,
					runtime,
					probe
				}),
				tokenSource: account.tokenSource,
				mode: "webhook"
			};
		}
	},
	gateway: {
		startAccount: async (ctx) => {
			const account = ctx.account;
			const token = account.channelAccessToken.trim();
			const secret = account.channelSecret.trim();
			if (!token) throw new Error(`LINE webhook mode requires a non-empty channel access token for account "${account.accountId}".`);
			if (!secret) throw new Error(`LINE webhook mode requires a non-empty channel secret for account "${account.accountId}".`);
			let lineBotLabel = "";
			try {
				const probe = await getLineRuntime().channel.line.probeLineBot(token, 2500);
				const displayName = probe.ok ? probe.bot?.displayName?.trim() : null;
				if (displayName) lineBotLabel = ` (${displayName})`;
			} catch (err) {
				if (getLineRuntime().logging.shouldLogVerbose()) ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
			}
			ctx.log?.info(`[${account.accountId}] starting LINE provider${lineBotLabel}`);
			return await getLineRuntime().channel.line.monitorLineProvider({
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
				await getLineRuntime().config.writeConfigFile(nextCfg);
			}
			const loggedOut = getLineRuntime().channel.line.resolveLineAccount({
				cfg: changed ? nextCfg : cfg,
				accountId
			}).tokenSource === "none";
			return {
				cleared,
				envToken: Boolean(envToken),
				loggedOut
			};
		}
	},
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
};
//#endregion
//#region extensions/line/index.ts
const plugin = {
	id: "line",
	name: "LINE",
	description: "LINE Messaging API channel plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		setLineRuntime(api.runtime);
		api.registerChannel({ plugin: linePlugin });
		if (api.registrationMode !== "full") return;
		registerLineCardCommand(api);
	}
};
//#endregion
export { plugin as default };
