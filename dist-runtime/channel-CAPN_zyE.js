import { g as DEFAULT_ACCOUNT_ID } from "./session-key-BSZsryCD.js";
import { Hn as PAIRING_APPROVED_MESSAGE, Jn as setAccountEnabledInConfigSection, Un as buildAccountScopedDmSecurityPolicy, Xn as buildCatchallMultiAccountChannelSchema, Yn as AllowFromListSchema, Zn as buildChannelConfigSchema, fr as MarkdownConfigSchema, or as GroupPolicySchema, qn as deleteAccountFromConfigSection, rr as DmPolicySchema } from "./resolve-route-CQsiaDZO.js";
import { l as normalizeSecretInputString } from "./types.secrets-Br5ssFsN.js";
import { t as createAccountStatusSink } from "./channel-lifecycle-h2DwjEdV.js";
import { E as buildOpenGroupPolicyWarning, Fm as mapAllowFromEntries, Jd as buildTokenChannelStatusSummary, M as collectOpenProviderGroupPolicyWarnings, Om as listDirectoryUserEntriesFromAllowFrom, T as buildOpenGroupPolicyRestrictSendersWarning, Ud as buildBaseAccountStatusSnapshot, Xo as buildSecretInputSchema, pi as extractToolSend, wt as formatAllowFromLowercase } from "./auth-profiles-B70DPAVa.js";
import { E as readStringParam, b as jsonResult } from "./external-content-CxoN_TKD.js";
import { _ as buildChannelSendResult, f as sendPayloadWithChunkedTextAndMedia, i as chunkTextForOutbound, l as isNumericTargetId } from "./compat-CwB8x8Tr.js";
import { _ as zaloSetupAdapter, c as sendMessage, d as zaloSetupWizard, f as listEnabledZaloAccounts, g as resolveZaloToken, h as resolveZaloAccount, i as getMe, l as sendPhoto, m as resolveDefaultZaloAccountId, n as ZaloApiError, p as listZaloAccountIds, t as resolveZaloProxyFetch } from "./proxy-B6IQ44kT.js";
import { n as readStatusIssueFields, t as coerceStatusIssueAccountId } from "./status-issues-sZ3QBwkS.js";
import { z } from "zod";
//#region extensions/zalo/src/send.ts
function toZaloSendResult(response) {
	if (response.ok && response.result) return {
		ok: true,
		messageId: response.result.message_id
	};
	return {
		ok: false,
		error: "Failed to send message"
	};
}
async function runZaloSend(failureMessage, send) {
	try {
		const result = toZaloSendResult(await send());
		return result.ok ? result : {
			ok: false,
			error: failureMessage
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
function resolveSendContext(options) {
	if (options.cfg) {
		const account = resolveZaloAccount({
			cfg: options.cfg,
			accountId: options.accountId
		});
		return {
			token: options.token || account.token,
			fetcher: resolveZaloProxyFetch(options.proxy ?? account.config.proxy)
		};
	}
	const token = options.token ?? resolveZaloToken(void 0, options.accountId).token;
	const proxy = options.proxy;
	return {
		token,
		fetcher: resolveZaloProxyFetch(proxy)
	};
}
function resolveValidatedSendContext(chatId, options) {
	const { token, fetcher } = resolveSendContext(options);
	if (!token) return {
		ok: false,
		error: "No Zalo bot token configured"
	};
	const trimmedChatId = chatId?.trim();
	if (!trimmedChatId) return {
		ok: false,
		error: "No chat_id provided"
	};
	return {
		ok: true,
		chatId: trimmedChatId,
		token,
		fetcher
	};
}
function resolveSendContextOrFailure(chatId, options) {
	const context = resolveValidatedSendContext(chatId, options);
	return context.ok ? { context } : { failure: {
		ok: false,
		error: context.error
	} };
}
async function sendMessageZalo(chatId, text, options = {}) {
	const resolved = resolveSendContextOrFailure(chatId, options);
	if ("failure" in resolved) return resolved.failure;
	const { context } = resolved;
	if (options.mediaUrl) return sendPhotoZalo(context.chatId, options.mediaUrl, {
		...options,
		token: context.token,
		caption: text || options.caption
	});
	return await runZaloSend("Failed to send message", () => sendMessage(context.token, {
		chat_id: context.chatId,
		text: text.slice(0, 2e3)
	}, context.fetcher));
}
async function sendPhotoZalo(chatId, photoUrl, options = {}) {
	const resolved = resolveSendContextOrFailure(chatId, options);
	if ("failure" in resolved) return resolved.failure;
	const { context } = resolved;
	if (!photoUrl?.trim()) return {
		ok: false,
		error: "No photo URL provided"
	};
	return await runZaloSend("Failed to send photo", () => sendPhoto(context.token, {
		chat_id: context.chatId,
		photo: photoUrl.trim(),
		caption: options.caption?.slice(0, 2e3)
	}, context.fetcher));
}
//#endregion
//#region extensions/zalo/src/actions.ts
const providerId = "zalo";
function listEnabledAccounts(cfg) {
	return listEnabledZaloAccounts(cfg).filter((account) => account.enabled && account.tokenSource !== "none");
}
const zaloMessageActions = {
	listActions: ({ cfg }) => {
		if (listEnabledAccounts(cfg).length === 0) return [];
		const actions = new Set(["send"]);
		return Array.from(actions);
	},
	getCapabilities: () => [],
	extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
	handleAction: async ({ action, params, cfg, accountId }) => {
		if (action === "send") {
			const to = readStringParam(params, "to", { required: true });
			const content = readStringParam(params, "message", {
				required: true,
				allowEmpty: true
			});
			const mediaUrl = readStringParam(params, "media", { trim: false });
			const result = await sendMessageZalo(to ?? "", content ?? "", {
				accountId: accountId ?? void 0,
				mediaUrl: mediaUrl ?? void 0,
				cfg
			});
			if (!result.ok) return jsonResult({
				ok: false,
				error: result.error ?? "Failed to send Zalo message"
			});
			return jsonResult({
				ok: true,
				to,
				messageId: result.messageId
			});
		}
		throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
	}
};
const ZaloConfigSchema = buildCatchallMultiAccountChannelSchema(z.object({
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	markdown: MarkdownConfigSchema,
	botToken: buildSecretInputSchema().optional(),
	tokenFile: z.string().optional(),
	webhookUrl: z.string().optional(),
	webhookSecret: buildSecretInputSchema().optional(),
	webhookPath: z.string().optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: AllowFromListSchema,
	groupPolicy: GroupPolicySchema.optional(),
	groupAllowFrom: AllowFromListSchema,
	mediaMaxMb: z.number().optional(),
	proxy: z.string().optional(),
	responsePrefix: z.string().optional()
}));
//#endregion
//#region extensions/zalo/src/probe.ts
async function probeZalo(token, timeoutMs = 5e3, fetcher) {
	if (!token?.trim()) return {
		ok: false,
		error: "No token provided",
		elapsedMs: 0
	};
	const startTime = Date.now();
	try {
		const response = await getMe(token.trim(), timeoutMs, fetcher);
		const elapsedMs = Date.now() - startTime;
		if (response.ok && response.result) return {
			ok: true,
			bot: response.result,
			elapsedMs
		};
		return {
			ok: false,
			error: "Invalid response from Zalo API",
			elapsedMs
		};
	} catch (err) {
		const elapsedMs = Date.now() - startTime;
		if (err instanceof ZaloApiError) return {
			ok: false,
			error: err.description ?? err.message,
			elapsedMs
		};
		if (err instanceof Error) {
			if (err.name === "AbortError") return {
				ok: false,
				error: `Request timed out after ${timeoutMs}ms`,
				elapsedMs
			};
			return {
				ok: false,
				error: err.message,
				elapsedMs
			};
		}
		return {
			ok: false,
			error: String(err),
			elapsedMs
		};
	}
}
//#endregion
//#region extensions/zalo/src/status-issues.ts
const ZALO_STATUS_FIELDS = [
	"accountId",
	"enabled",
	"configured",
	"dmPolicy"
];
function collectZaloStatusIssues(accounts) {
	const issues = [];
	for (const entry of accounts) {
		const account = readStatusIssueFields(entry, ZALO_STATUS_FIELDS);
		if (!account) continue;
		const accountId = coerceStatusIssueAccountId(account.accountId) ?? "default";
		const enabled = account.enabled !== false;
		const configured = account.configured === true;
		if (!enabled || !configured) continue;
		if (account.dmPolicy === "open") issues.push({
			channel: "zalo",
			accountId,
			kind: "config",
			message: "Zalo dmPolicy is \"open\", allowing any user to message the bot without pairing.",
			fix: "Set channels.zalo.dmPolicy to \"pairing\" or \"allowlist\" to restrict access."
		});
	}
	return issues;
}
//#endregion
//#region extensions/zalo/src/channel.ts
const meta = {
	id: "zalo",
	label: "Zalo",
	selectionLabel: "Zalo (Bot API)",
	docsPath: "/channels/zalo",
	docsLabel: "zalo",
	blurb: "Vietnam-focused messaging platform with Bot API.",
	aliases: ["zl"],
	order: 80,
	quickstartAllowFrom: true
};
function normalizeZaloMessagingTarget(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) return;
	return trimmed.replace(/^(zalo|zl):/i, "");
}
const zaloPlugin = {
	id: "zalo",
	meta,
	setup: zaloSetupAdapter,
	setupWizard: zaloSetupWizard,
	capabilities: {
		chatTypes: ["direct", "group"],
		media: true,
		reactions: false,
		threads: false,
		polls: false,
		nativeCommands: false,
		blockStreaming: true
	},
	reload: { configPrefixes: ["channels.zalo"] },
	configSchema: buildChannelConfigSchema(ZaloConfigSchema),
	config: {
		listAccountIds: (cfg) => listZaloAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveZaloAccount({
			cfg,
			accountId
		}),
		defaultAccountId: (cfg) => resolveDefaultZaloAccountId(cfg),
		setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledInConfigSection({
			cfg,
			sectionKey: "zalo",
			accountId,
			enabled,
			allowTopLevel: true
		}),
		deleteAccount: ({ cfg, accountId }) => deleteAccountFromConfigSection({
			cfg,
			sectionKey: "zalo",
			accountId,
			clearBaseFields: [
				"botToken",
				"tokenFile",
				"name"
			]
		}),
		isConfigured: (account) => Boolean(account.token?.trim()),
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: Boolean(account.token?.trim()),
			tokenSource: account.tokenSource
		}),
		resolveAllowFrom: ({ cfg, accountId }) => mapAllowFromEntries(resolveZaloAccount({
			cfg,
			accountId
		}).config.allowFrom),
		formatAllowFrom: ({ allowFrom }) => formatAllowFromLowercase({
			allowFrom,
			stripPrefixRe: /^(zalo|zl):/i
		})
	},
	security: {
		resolveDmPolicy: ({ cfg, accountId, account }) => {
			return buildAccountScopedDmSecurityPolicy({
				cfg,
				channelKey: "zalo",
				accountId,
				fallbackAccountId: account.accountId ?? "default",
				policy: account.config.dmPolicy,
				allowFrom: account.config.allowFrom ?? [],
				policyPathSuffix: "dmPolicy",
				normalizeEntry: (raw) => raw.replace(/^(zalo|zl):/i, "")
			});
		},
		collectWarnings: ({ account, cfg }) => {
			return collectOpenProviderGroupPolicyWarnings({
				cfg,
				providerConfigPresent: cfg.channels?.zalo !== void 0,
				configuredGroupPolicy: account.config.groupPolicy,
				collect: (groupPolicy) => {
					if (groupPolicy !== "open") return [];
					const explicitGroupAllowFrom = mapAllowFromEntries(account.config.groupAllowFrom);
					const dmAllowFrom = mapAllowFromEntries(account.config.allowFrom);
					if ((explicitGroupAllowFrom.length > 0 ? explicitGroupAllowFrom : dmAllowFrom).length > 0) return [buildOpenGroupPolicyRestrictSendersWarning({
						surface: "Zalo groups",
						openScope: "any member",
						groupPolicyPath: "channels.zalo.groupPolicy",
						groupAllowFromPath: "channels.zalo.groupAllowFrom"
					})];
					return [buildOpenGroupPolicyWarning({
						surface: "Zalo groups",
						openBehavior: "with no groupAllowFrom/allowFrom allowlist; any member can trigger (mention-gated)",
						remediation: "Set channels.zalo.groupPolicy=\"allowlist\" + channels.zalo.groupAllowFrom"
					})];
				}
			});
		}
	},
	groups: { resolveRequireMention: () => true },
	threading: { resolveReplyToMode: () => "off" },
	actions: zaloMessageActions,
	messaging: {
		normalizeTarget: normalizeZaloMessagingTarget,
		targetResolver: {
			looksLikeId: isNumericTargetId,
			hint: "<chatId>"
		}
	},
	directory: {
		self: async () => null,
		listPeers: async ({ cfg, accountId, query, limit }) => {
			return listDirectoryUserEntriesFromAllowFrom({
				allowFrom: resolveZaloAccount({
					cfg,
					accountId
				}).config.allowFrom,
				query,
				limit,
				normalizeId: (entry) => entry.replace(/^(zalo|zl):/i, "")
			});
		},
		listGroups: async () => []
	},
	pairing: {
		idLabel: "zaloUserId",
		normalizeAllowEntry: (entry) => entry.replace(/^(zalo|zl):/i, ""),
		notifyApproval: async ({ cfg, id }) => {
			const account = resolveZaloAccount({ cfg });
			if (!account.token) throw new Error("Zalo token not configured");
			await sendMessageZalo(id, PAIRING_APPROVED_MESSAGE, { token: account.token });
		}
	},
	outbound: {
		deliveryMode: "direct",
		chunker: chunkTextForOutbound,
		chunkerMode: "text",
		textChunkLimit: 2e3,
		sendPayload: async (ctx) => await sendPayloadWithChunkedTextAndMedia({
			ctx,
			textChunkLimit: zaloPlugin.outbound.textChunkLimit,
			chunker: zaloPlugin.outbound.chunker,
			sendText: (nextCtx) => zaloPlugin.outbound.sendText(nextCtx),
			sendMedia: (nextCtx) => zaloPlugin.outbound.sendMedia(nextCtx),
			emptyResult: {
				channel: "zalo",
				messageId: ""
			}
		}),
		sendText: async ({ to, text, accountId, cfg }) => {
			return buildChannelSendResult("zalo", await sendMessageZalo(to, text, {
				accountId: accountId ?? void 0,
				cfg
			}));
		},
		sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
			return buildChannelSendResult("zalo", await sendMessageZalo(to, text, {
				accountId: accountId ?? void 0,
				mediaUrl,
				cfg
			}));
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
		collectStatusIssues: collectZaloStatusIssues,
		buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
		probeAccount: async ({ account, timeoutMs }) => probeZalo(account.token, timeoutMs, resolveZaloProxyFetch(account.config.proxy)),
		buildAccountSnapshot: ({ account, runtime }) => {
			const configured = Boolean(account.token?.trim());
			return {
				...buildBaseAccountStatusSnapshot({
					account: {
						accountId: account.accountId,
						name: account.name,
						enabled: account.enabled,
						configured
					},
					runtime
				}),
				tokenSource: account.tokenSource,
				mode: account.config.webhookUrl ? "webhook" : "polling",
				dmPolicy: account.config.dmPolicy ?? "pairing"
			};
		}
	},
	gateway: { startAccount: async (ctx) => {
		const account = ctx.account;
		const token = account.token.trim();
		const mode = account.config.webhookUrl ? "webhook" : "polling";
		let zaloBotLabel = "";
		const fetcher = resolveZaloProxyFetch(account.config.proxy);
		try {
			const probe = await probeZalo(token, 2500, fetcher);
			const name = probe.ok ? probe.bot?.name?.trim() : null;
			if (name) zaloBotLabel = ` (${name})`;
			if (!probe.ok) ctx.log?.warn?.(`[${account.accountId}] Zalo probe failed before provider start (${String(probe.elapsedMs)}ms): ${probe.error}`);
			ctx.setStatus({
				accountId: account.accountId,
				bot: probe.bot
			});
		} catch (err) {
			ctx.log?.warn?.(`[${account.accountId}] Zalo probe threw before provider start: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
		}
		const statusSink = createAccountStatusSink({
			accountId: ctx.accountId,
			setStatus: ctx.setStatus
		});
		ctx.log?.info(`[${account.accountId}] starting provider${zaloBotLabel} mode=${mode}`);
		const { monitorZaloProvider } = await import("./monitor-DIHC24Sy.js");
		return monitorZaloProvider({
			token,
			account,
			config: ctx.cfg,
			runtime: ctx.runtime,
			abortSignal: ctx.abortSignal,
			useWebhook: Boolean(account.config.webhookUrl),
			webhookUrl: account.config.webhookUrl,
			webhookSecret: normalizeSecretInputString(account.config.webhookSecret),
			webhookPath: account.config.webhookPath,
			fetcher,
			statusSink
		});
	} }
};
//#endregion
export { zaloPlugin as t };
