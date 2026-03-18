import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import { g as DEFAULT_ACCOUNT_ID } from "../../session-key-BSZsryCD.js";
import { Un as buildAccountScopedDmSecurityPolicy, Zn as buildChannelConfigSchema, f as getChatChannelMeta } from "../../resolve-route-CQsiaDZO.js";
import { t as formatCliCommand } from "../../command-format-ZZqKRRhR.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import { p as normalizeE164, u as isRecord } from "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../core-CUbPSeQH.js";
import "../../paths-DAoqckDF.js";
import { Bc as asString, C as resolveWhatsAppOutboundTarget, D as collectAllowlistProviderGroupPolicyWarnings, Hm as trimMessagingTarget, Pm as formatWhatsAppConfigAllowFromEntries, Rm as resolveWhatsAppConfigAllowFrom, S as resolveWhatsAppMentionStripRegexes, Um as isWhatsAppGroupJid, Vc as collectIssuesForEnabledAccounts, Vm as looksLikeHandleOrPhoneTarget, Wm as normalizeWhatsAppTarget, X as resolveWhatsAppHeartbeatRecipients, am as resolveDefaultWhatsAppAccountId, b as createWhatsAppOutboundBase, bm as listWhatsAppDirectoryGroupsFromConfig, im as listWhatsAppAccountIds, j as collectOpenGroupPolicyRouteAllowlistWarnings, mu as resolveWhatsAppGroupToolPolicy, om as resolveWhatsAppAccount, pu as resolveWhatsAppGroupRequireMention, vp as WhatsAppConfigSchema, x as resolveWhatsAppGroupIntroHint, xm as listWhatsAppDirectoryPeersFromConfig, y as createPluginRuntimeStore, zm as resolveWhatsAppConfigDefaultTo } from "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import { E as readStringParam, _ as createActionGate } from "../../external-content-CxoN_TKD.js";
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
import { g as buildAccountScopedAllowlistConfigEditor } from "../../compat-CwB8x8Tr.js";
import "../../inbound-envelope-DsYY1Vpm.js";
import "../../run-command-B9zmAfEF.js";
import "../../device-pairing-CsJif6Rb.js";
import "../../line-DvbTO_h3.js";
import "../../upsert-with-lock-BkGBN4WL.js";
import "../../self-hosted-provider-setup-Bgv4n1Xv.js";
import "../../ollama-setup-CXkNt6CA.js";
import "../../whatsapp-CtQSo8tE.js";
import { t as whatsappSetupAdapter } from "../../setup-core-Db6UrHEy.js";
//#region extensions/whatsapp/src/normalize.ts
function normalizeWhatsAppMessagingTarget(raw) {
	const trimmed = trimMessagingTarget(raw);
	if (!trimmed) return;
	return normalizeWhatsAppTarget(trimmed) ?? void 0;
}
function looksLikeWhatsAppTargetId(raw) {
	return looksLikeHandleOrPhoneTarget({
		raw,
		prefixPattern: /^whatsapp:/i
	});
}
//#endregion
//#region extensions/whatsapp/src/runtime.ts
const { setRuntime: setWhatsAppRuntime, getRuntime: getWhatsAppRuntime } = createPluginRuntimeStore("WhatsApp runtime not initialized");
//#endregion
//#region extensions/whatsapp/src/status-issues.ts
function readWhatsAppAccountStatus(value) {
	if (!isRecord(value)) return null;
	return {
		accountId: value.accountId,
		enabled: value.enabled,
		linked: value.linked,
		connected: value.connected,
		running: value.running,
		reconnectAttempts: value.reconnectAttempts,
		lastError: value.lastError
	};
}
function collectWhatsAppStatusIssues(accounts) {
	return collectIssuesForEnabledAccounts({
		accounts,
		readAccount: readWhatsAppAccountStatus,
		collectIssues: ({ account, accountId, issues }) => {
			const linked = account.linked === true;
			const running = account.running === true;
			const connected = account.connected === true;
			const reconnectAttempts = typeof account.reconnectAttempts === "number" ? account.reconnectAttempts : null;
			const lastError = asString(account.lastError);
			if (!linked) {
				issues.push({
					channel: "whatsapp",
					accountId,
					kind: "auth",
					message: "Not linked (no WhatsApp Web session).",
					fix: `Run: ${formatCliCommand("openclaw channels login")} (scan QR on the gateway host).`
				});
				return;
			}
			if (running && !connected) issues.push({
				channel: "whatsapp",
				accountId,
				kind: "runtime",
				message: `Linked but disconnected${reconnectAttempts != null ? ` (reconnectAttempts=${reconnectAttempts})` : ""}${lastError ? `: ${lastError}` : "."}`,
				fix: `Run: ${formatCliCommand("openclaw doctor")} (or restart the gateway). If it persists, relink via channels login and check logs.`
			});
		}
	});
}
//#endregion
//#region extensions/whatsapp/src/channel.ts
const meta = getChatChannelMeta("whatsapp");
async function loadWhatsAppChannelRuntime() {
	return await import("../../channel.runtime-CGhraMFU.js");
}
function normalizeWhatsAppPayloadText(text) {
	return (text ?? "").replace(/^(?:[ \t]*\r?\n)+/, "");
}
function parseWhatsAppExplicitTarget(raw) {
	const normalized = normalizeWhatsAppTarget(raw);
	if (!normalized) return null;
	return {
		to: normalized,
		chatType: isWhatsAppGroupJid(normalized) ? "group" : "direct"
	};
}
const whatsappSetupWizardProxy = {
	channel: "whatsapp",
	status: {
		configuredLabel: "linked",
		unconfiguredLabel: "not linked",
		configuredHint: "linked",
		unconfiguredHint: "not linked",
		configuredScore: 5,
		unconfiguredScore: 4,
		resolveConfigured: async ({ cfg }) => await (await loadWhatsAppChannelRuntime()).whatsappSetupWizard.status.resolveConfigured({ cfg }),
		resolveStatusLines: async ({ cfg, configured }) => await (await loadWhatsAppChannelRuntime()).whatsappSetupWizard.status.resolveStatusLines?.({
			cfg,
			configured
		}) ?? []
	},
	resolveShouldPromptAccountIds: (params) => (params.shouldPromptAccountIds || params.options?.promptWhatsAppAccountId) ?? false,
	credentials: [],
	finalize: async (params) => await (await loadWhatsAppChannelRuntime()).whatsappSetupWizard.finalize(params),
	disable: (cfg) => ({
		...cfg,
		channels: {
			...cfg.channels,
			whatsapp: {
				...cfg.channels?.whatsapp,
				enabled: false
			}
		}
	}),
	onAccountRecorded: (accountId, options) => {
		options?.onWhatsAppAccountId?.(accountId);
	}
};
const whatsappPlugin = {
	id: "whatsapp",
	meta: {
		...meta,
		showConfigured: false,
		quickstartAllowFrom: true,
		forceAccountBinding: true,
		preferSessionLookupForAnnounceTarget: true
	},
	setupWizard: whatsappSetupWizardProxy,
	agentTools: () => [getWhatsAppRuntime().channel.whatsapp.createLoginTool()],
	pairing: { idLabel: "whatsappSenderId" },
	capabilities: {
		chatTypes: ["direct", "group"],
		polls: true,
		reactions: true,
		media: true
	},
	reload: {
		configPrefixes: ["web"],
		noopPrefixes: ["channels.whatsapp"]
	},
	gatewayMethods: ["web.login.start", "web.login.wait"],
	configSchema: buildChannelConfigSchema(WhatsAppConfigSchema),
	config: {
		listAccountIds: (cfg) => listWhatsAppAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveWhatsAppAccount({
			cfg,
			accountId
		}),
		defaultAccountId: (cfg) => resolveDefaultWhatsAppAccountId(cfg),
		setAccountEnabled: ({ cfg, accountId, enabled }) => {
			const accountKey = accountId || "default";
			const accounts = { ...cfg.channels?.whatsapp?.accounts };
			const existing = accounts[accountKey] ?? {};
			return {
				...cfg,
				channels: {
					...cfg.channels,
					whatsapp: {
						...cfg.channels?.whatsapp,
						accounts: {
							...accounts,
							[accountKey]: {
								...existing,
								enabled
							}
						}
					}
				}
			};
		},
		deleteAccount: ({ cfg, accountId }) => {
			const accountKey = accountId || "default";
			const accounts = { ...cfg.channels?.whatsapp?.accounts };
			delete accounts[accountKey];
			return {
				...cfg,
				channels: {
					...cfg.channels,
					whatsapp: {
						...cfg.channels?.whatsapp,
						accounts: Object.keys(accounts).length ? accounts : void 0
					}
				}
			};
		},
		isEnabled: (account, cfg) => account.enabled && cfg.web?.enabled !== false,
		disabledReason: () => "disabled",
		isConfigured: async (account) => await getWhatsAppRuntime().channel.whatsapp.webAuthExists(account.authDir),
		unconfiguredReason: () => "not linked",
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: Boolean(account.authDir),
			linked: Boolean(account.authDir),
			dmPolicy: account.dmPolicy,
			allowFrom: account.allowFrom
		}),
		resolveAllowFrom: ({ cfg, accountId }) => resolveWhatsAppConfigAllowFrom({
			cfg,
			accountId
		}),
		formatAllowFrom: ({ allowFrom }) => formatWhatsAppConfigAllowFromEntries(allowFrom),
		resolveDefaultTo: ({ cfg, accountId }) => resolveWhatsAppConfigDefaultTo({
			cfg,
			accountId
		})
	},
	allowlist: {
		supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
		readConfig: ({ cfg, accountId }) => {
			const account = resolveWhatsAppAccount({
				cfg,
				accountId
			});
			return {
				dmAllowFrom: (account.allowFrom ?? []).map(String),
				groupAllowFrom: (account.groupAllowFrom ?? []).map(String),
				dmPolicy: account.dmPolicy,
				groupPolicy: account.groupPolicy
			};
		},
		applyConfigEdit: buildAccountScopedAllowlistConfigEditor({
			channelId: "whatsapp",
			normalize: ({ values }) => formatWhatsAppConfigAllowFromEntries(values),
			resolvePaths: (scope) => ({
				readPaths: [[scope === "dm" ? "allowFrom" : "groupAllowFrom"]],
				writePath: [scope === "dm" ? "allowFrom" : "groupAllowFrom"]
			})
		})
	},
	security: {
		resolveDmPolicy: ({ cfg, accountId, account }) => {
			return buildAccountScopedDmSecurityPolicy({
				cfg,
				channelKey: "whatsapp",
				accountId,
				fallbackAccountId: account.accountId ?? "default",
				policy: account.dmPolicy,
				allowFrom: account.allowFrom ?? [],
				policyPathSuffix: "dmPolicy",
				normalizeEntry: (raw) => normalizeE164(raw)
			});
		},
		collectWarnings: ({ account, cfg }) => {
			const groupAllowlistConfigured = Boolean(account.groups) && Object.keys(account.groups ?? {}).length > 0;
			return collectAllowlistProviderGroupPolicyWarnings({
				cfg,
				providerConfigPresent: cfg.channels?.whatsapp !== void 0,
				configuredGroupPolicy: account.groupPolicy,
				collect: (groupPolicy) => collectOpenGroupPolicyRouteAllowlistWarnings({
					groupPolicy,
					routeAllowlistConfigured: groupAllowlistConfigured,
					restrictSenders: {
						surface: "WhatsApp groups",
						openScope: "any member in allowed groups",
						groupPolicyPath: "channels.whatsapp.groupPolicy",
						groupAllowFromPath: "channels.whatsapp.groupAllowFrom"
					},
					noRouteAllowlist: {
						surface: "WhatsApp groups",
						routeAllowlistPath: "channels.whatsapp.groups",
						routeScope: "group",
						groupPolicyPath: "channels.whatsapp.groupPolicy",
						groupAllowFromPath: "channels.whatsapp.groupAllowFrom"
					}
				})
			});
		}
	},
	setup: whatsappSetupAdapter,
	groups: {
		resolveRequireMention: resolveWhatsAppGroupRequireMention,
		resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
		resolveGroupIntroHint: resolveWhatsAppGroupIntroHint
	},
	mentions: { stripRegexes: ({ ctx }) => resolveWhatsAppMentionStripRegexes(ctx) },
	commands: {
		enforceOwnerForCommands: true,
		skipWhenConfigEmpty: true
	},
	messaging: {
		normalizeTarget: normalizeWhatsAppMessagingTarget,
		parseExplicitTarget: ({ raw }) => parseWhatsAppExplicitTarget(raw),
		inferTargetChatType: ({ to }) => parseWhatsAppExplicitTarget(to)?.chatType,
		targetResolver: {
			looksLikeId: looksLikeWhatsAppTargetId,
			hint: "<E.164|group JID>"
		}
	},
	directory: {
		self: async ({ cfg, accountId }) => {
			const account = resolveWhatsAppAccount({
				cfg,
				accountId
			});
			const { e164, jid } = getWhatsAppRuntime().channel.whatsapp.readWebSelfId(account.authDir);
			const id = e164 ?? jid;
			if (!id) return null;
			return {
				kind: "user",
				id,
				name: account.name,
				raw: {
					e164,
					jid
				}
			};
		},
		listPeers: async (params) => listWhatsAppDirectoryPeersFromConfig(params),
		listGroups: async (params) => listWhatsAppDirectoryGroupsFromConfig(params)
	},
	actions: {
		listActions: ({ cfg }) => {
			if (!cfg.channels?.whatsapp) return [];
			const gate = createActionGate(cfg.channels.whatsapp.actions);
			const actions = /* @__PURE__ */ new Set();
			if (gate("reactions")) actions.add("react");
			if (gate("polls")) actions.add("poll");
			return Array.from(actions);
		},
		supportsAction: ({ action }) => action === "react",
		handleAction: async ({ action, params, cfg, accountId }) => {
			if (action !== "react") throw new Error(`Action ${action} is not supported for provider ${meta.id}.`);
			const messageId = readStringParam(params, "messageId", { required: true });
			const emoji = readStringParam(params, "emoji", { allowEmpty: true });
			const remove = typeof params.remove === "boolean" ? params.remove : void 0;
			return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction({
				action: "react",
				chatJid: readStringParam(params, "chatJid") ?? readStringParam(params, "to", { required: true }),
				messageId,
				emoji,
				remove,
				participant: readStringParam(params, "participant"),
				accountId: accountId ?? void 0,
				fromMe: typeof params.fromMe === "boolean" ? params.fromMe : void 0
			}, cfg);
		}
	},
	outbound: {
		...createWhatsAppOutboundBase({
			chunker: (text, limit) => getWhatsAppRuntime().channel.text.chunkText(text, limit),
			sendMessageWhatsApp: async (...args) => await getWhatsAppRuntime().channel.whatsapp.sendMessageWhatsApp(...args),
			sendPollWhatsApp: async (...args) => await getWhatsAppRuntime().channel.whatsapp.sendPollWhatsApp(...args),
			shouldLogVerbose: () => getWhatsAppRuntime().logging.shouldLogVerbose(),
			resolveTarget: ({ to, allowFrom, mode }) => resolveWhatsAppOutboundTarget({
				to,
				allowFrom,
				mode
			})
		}),
		normalizePayload: ({ payload }) => ({
			...payload,
			text: normalizeWhatsAppPayloadText(payload.text)
		})
	},
	auth: { login: async ({ cfg, accountId, runtime, verbose }) => {
		const resolvedAccountId = accountId?.trim() || resolveDefaultWhatsAppAccountId(cfg);
		await getWhatsAppRuntime().channel.whatsapp.loginWeb(Boolean(verbose), void 0, runtime, resolvedAccountId);
	} },
	heartbeat: {
		checkReady: async ({ cfg, accountId, deps }) => {
			if (cfg.web?.enabled === false) return {
				ok: false,
				reason: "whatsapp-disabled"
			};
			const account = resolveWhatsAppAccount({
				cfg,
				accountId
			});
			if (!await (deps?.webAuthExists ?? getWhatsAppRuntime().channel.whatsapp.webAuthExists)(account.authDir)) return {
				ok: false,
				reason: "whatsapp-not-linked"
			};
			if (!(deps?.hasActiveWebListener ? deps.hasActiveWebListener() : Boolean(getWhatsAppRuntime().channel.whatsapp.getActiveWebListener()))) return {
				ok: false,
				reason: "whatsapp-not-running"
			};
			return {
				ok: true,
				reason: "ok"
			};
		},
		resolveRecipients: ({ cfg, opts }) => resolveWhatsAppHeartbeatRecipients(cfg, opts)
	},
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: false,
			connected: false,
			reconnectAttempts: 0,
			lastConnectedAt: null,
			lastDisconnect: null,
			lastMessageAt: null,
			lastEventAt: null,
			lastError: null
		},
		collectStatusIssues: collectWhatsAppStatusIssues,
		buildChannelSummary: async ({ account, snapshot }) => {
			const authDir = account.authDir;
			const linked = typeof snapshot.linked === "boolean" ? snapshot.linked : authDir ? await getWhatsAppRuntime().channel.whatsapp.webAuthExists(authDir) : false;
			return {
				configured: linked,
				linked,
				authAgeMs: linked && authDir ? getWhatsAppRuntime().channel.whatsapp.getWebAuthAgeMs(authDir) : null,
				self: linked && authDir ? getWhatsAppRuntime().channel.whatsapp.readWebSelfId(authDir) : {
					e164: null,
					jid: null
				},
				running: snapshot.running ?? false,
				connected: snapshot.connected ?? false,
				lastConnectedAt: snapshot.lastConnectedAt ?? null,
				lastDisconnect: snapshot.lastDisconnect ?? null,
				reconnectAttempts: snapshot.reconnectAttempts,
				lastMessageAt: snapshot.lastMessageAt ?? null,
				lastEventAt: snapshot.lastEventAt ?? null,
				lastError: snapshot.lastError ?? null
			};
		},
		buildAccountSnapshot: async ({ account, runtime }) => {
			const linked = await getWhatsAppRuntime().channel.whatsapp.webAuthExists(account.authDir);
			return {
				accountId: account.accountId,
				name: account.name,
				enabled: account.enabled,
				configured: true,
				linked,
				running: runtime?.running ?? false,
				connected: runtime?.connected ?? false,
				reconnectAttempts: runtime?.reconnectAttempts,
				lastConnectedAt: runtime?.lastConnectedAt ?? null,
				lastDisconnect: runtime?.lastDisconnect ?? null,
				lastMessageAt: runtime?.lastMessageAt ?? null,
				lastEventAt: runtime?.lastEventAt ?? null,
				lastError: runtime?.lastError ?? null,
				dmPolicy: account.dmPolicy,
				allowFrom: account.allowFrom
			};
		},
		resolveAccountState: ({ configured }) => configured ? "linked" : "not linked",
		logSelfId: ({ account, runtime, includeChannelPrefix }) => {
			getWhatsAppRuntime().channel.whatsapp.logWebSelfId(account.authDir, runtime, includeChannelPrefix);
		}
	},
	gateway: {
		startAccount: async (ctx) => {
			const account = ctx.account;
			const { e164, jid } = getWhatsAppRuntime().channel.whatsapp.readWebSelfId(account.authDir);
			const identity = e164 ? e164 : jid ? `jid ${jid}` : "unknown";
			ctx.log?.info(`[${account.accountId}] starting provider (${identity})`);
			return getWhatsAppRuntime().channel.whatsapp.monitorWebChannel(getWhatsAppRuntime().logging.shouldLogVerbose(), void 0, true, void 0, ctx.runtime, ctx.abortSignal, {
				statusSink: (next) => ctx.setStatus({
					accountId: ctx.accountId,
					...next
				}),
				accountId: account.accountId
			});
		},
		loginWithQrStart: async ({ accountId, force, timeoutMs, verbose }) => await getWhatsAppRuntime().channel.whatsapp.startWebLoginWithQr({
			accountId,
			force,
			timeoutMs,
			verbose
		}),
		loginWithQrWait: async ({ accountId, timeoutMs }) => await getWhatsAppRuntime().channel.whatsapp.waitForWebLogin({
			accountId,
			timeoutMs
		}),
		logoutAccount: async ({ account, runtime }) => {
			const cleared = await getWhatsAppRuntime().channel.whatsapp.logoutWeb({
				authDir: account.authDir,
				isLegacyAuthDir: account.isLegacyAuthDir,
				runtime
			});
			return {
				cleared,
				loggedOut: cleared
			};
		}
	}
};
//#endregion
//#region extensions/whatsapp/index.ts
const plugin = {
	id: "whatsapp",
	name: "WhatsApp",
	description: "WhatsApp channel plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		setWhatsAppRuntime(api.runtime);
		api.registerChannel({ plugin: whatsappPlugin });
	}
};
//#endregion
export { plugin as default };
