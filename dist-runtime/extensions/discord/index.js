import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import { f as resolveThreadSessionKeys, g as DEFAULT_ACCOUNT_ID } from "../../session-key-BSZsryCD.js";
import { Hn as PAIRING_APPROVED_MESSAGE, Un as buildAccountScopedDmSecurityPolicy, Zn as buildChannelConfigSchema, _t as init_targets, dn as init_accounts, f as getChatChannelMeta, fn as listDiscordAccountIds, gn as resolveDiscordAccount, hn as resolveDefaultDiscordAccountId, t as buildAgentSessionKey, vt as parseDiscordTarget } from "../../resolve-route-CQsiaDZO.js";
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
import "../../core-CUbPSeQH.js";
import "../../paths-DAoqckDF.js";
import { $l as normalizeDiscordMessagingTarget, Ac as discordSetupAdapter, Am as createScopedAccountConfigAccessors, Gd as buildComputedAccountStatusSnapshot, Jd as buildTokenChannelStatusSummary, Kl as fetchChannelPermissionsDiscord, M as collectOpenProviderGroupPolicyWarnings, Ql as looksLikeDiscordTargetId, Uc as collectDiscordAuditChannelIds, Wp as normalizeMessageChannel, au as resolveDiscordGroupToolPolicy, cf as projectCredentialSnapshotFields, eu as normalizeDiscordOutboundTarget, fc as autoBindSpawnedDiscordSubagent, hc as unbindThreadBindingsBySessionKey, hm as listDiscordDirectoryPeersFromConfig, iu as resolveDiscordGroupRequireMention, jc as resolveDiscordUserAllowlist, jm as createScopedChannelConfigBase, k as collectOpenGroupPolicyConfiguredRouteWarnings, kc as createDiscordSetupWizardProxy, lf as resolveConfiguredFromCredentialStatuses, mm as listDiscordDirectoryGroupsFromConfig, pc as listThreadBindingsBySessionKey, ti as getExecApprovalReplyMetadata, tu as inspectDiscordAccount, ui as resolveOutboundSendDep, wt as formatAllowFromLowercase, y as createPluginRuntimeStore, yp as DiscordConfigSchema, zc as collectDiscordStatusIssues } from "../../auth-profiles-B70DPAVa.js";
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
import { g as buildAccountScopedAllowlistConfigEditor } from "../../compat-CwB8x8Tr.js";
import "../../inbound-envelope-DsYY1Vpm.js";
import "../../run-command-B9zmAfEF.js";
import "../../device-pairing-CsJif6Rb.js";
import "../../line-DvbTO_h3.js";
import "../../upsert-with-lock-BkGBN4WL.js";
import "../../self-hosted-provider-setup-Bgv4n1Xv.js";
import "../../ollama-setup-CXkNt6CA.js";
import { t as DiscordUiContainer } from "../../ui-BUZAd5L5.js";
import { Separator, TextDisplay } from "@buape/carbon";
//#region extensions/discord/src/exec-approvals.ts
init_accounts();
function isDiscordExecApprovalClientEnabled(params) {
	const config = resolveDiscordAccount(params).config.execApprovals;
	return Boolean(config?.enabled && (config.approvers?.length ?? 0) > 0);
}
function shouldSuppressLocalDiscordExecApprovalPrompt(params) {
	return isDiscordExecApprovalClientEnabled(params) && getExecApprovalReplyMetadata(params.payload) !== null;
}
//#endregion
//#region extensions/discord/src/runtime.ts
const { setRuntime: setDiscordRuntime, getRuntime: getDiscordRuntime } = createPluginRuntimeStore("Discord runtime not initialized");
//#endregion
//#region extensions/discord/src/channel.ts
init_accounts();
init_targets();
const meta = getChatChannelMeta("discord");
const REQUIRED_DISCORD_PERMISSIONS = ["ViewChannel", "SendMessages"];
async function loadDiscordChannelRuntime() {
	return await import("../../channel.runtime-DvjV6DcD.js");
}
function formatDiscordIntents(intents) {
	if (!intents) return "unknown";
	return [
		`messageContent=${intents.messageContent ?? "unknown"}`,
		`guildMembers=${intents.guildMembers ?? "unknown"}`,
		`presence=${intents.presence ?? "unknown"}`
	].join(" ");
}
const discordMessageActions = {
	listActions: (ctx) => getDiscordRuntime().channel.discord.messageActions?.listActions?.(ctx) ?? [],
	getCapabilities: (ctx) => getDiscordRuntime().channel.discord.messageActions?.getCapabilities?.(ctx) ?? [],
	extractToolSend: (ctx) => getDiscordRuntime().channel.discord.messageActions?.extractToolSend?.(ctx) ?? null,
	handleAction: async (ctx) => {
		const ma = getDiscordRuntime().channel.discord.messageActions;
		if (!ma?.handleAction) throw new Error("Discord message actions not available");
		return ma.handleAction(ctx);
	},
	requiresTrustedRequesterSender: ({ action, toolContext }) => Boolean(toolContext && (action === "timeout" || action === "kick" || action === "ban"))
};
function buildDiscordCrossContextComponents(params) {
	const trimmed = params.message.trim();
	const components = [];
	if (trimmed) {
		components.push(new TextDisplay(params.message));
		components.push(new Separator({
			divider: true,
			spacing: "small"
		}));
	}
	components.push(new TextDisplay(`*From ${params.originLabel}*`));
	return [new DiscordUiContainer({
		cfg: params.cfg,
		accountId: params.accountId,
		components
	})];
}
function hasDiscordExecApprovalDmRoute(cfg) {
	return listDiscordAccountIds(cfg).some((accountId) => {
		const execApprovals = resolveDiscordAccount({
			cfg,
			accountId
		}).config.execApprovals;
		if (!execApprovals?.enabled || (execApprovals.approvers?.length ?? 0) === 0) return false;
		const target = execApprovals.target ?? "dm";
		return target === "dm" || target === "both";
	});
}
function readDiscordAllowlistConfig(account) {
	const groupOverrides = [];
	for (const [guildKey, guildCfg] of Object.entries(account.config.guilds ?? {})) {
		const entries = (guildCfg?.users ?? []).map(String).filter(Boolean);
		if (entries.length > 0) groupOverrides.push({
			label: `guild ${guildKey}`,
			entries
		});
		for (const [channelKey, channelCfg] of Object.entries(guildCfg?.channels ?? {})) {
			const channelEntries = (channelCfg?.users ?? []).map(String).filter(Boolean);
			if (channelEntries.length > 0) groupOverrides.push({
				label: `guild ${guildKey} / channel ${channelKey}`,
				entries: channelEntries
			});
		}
	}
	return {
		dmAllowFrom: (account.config.allowFrom ?? account.config.dm?.allowFrom ?? []).map(String),
		groupPolicy: account.config.groupPolicy,
		groupOverrides
	};
}
async function resolveDiscordAllowlistNames(params) {
	const token = resolveDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).token?.trim();
	if (!token) return [];
	return await resolveDiscordUserAllowlist({
		token,
		entries: params.entries
	});
}
function normalizeDiscordAcpConversationId(conversationId) {
	const normalized = conversationId.trim();
	return normalized ? { conversationId: normalized } : null;
}
function matchDiscordAcpConversation(params) {
	if (params.bindingConversationId === params.conversationId) return {
		conversationId: params.conversationId,
		matchPriority: 2
	};
	if (params.parentConversationId && params.parentConversationId !== params.conversationId && params.bindingConversationId === params.parentConversationId) return {
		conversationId: params.parentConversationId,
		matchPriority: 1
	};
	return null;
}
function parseDiscordExplicitTarget(raw) {
	try {
		const target = parseDiscordTarget(raw, { defaultKind: "channel" });
		if (!target) return null;
		return {
			to: target.id,
			chatType: target.kind === "user" ? "direct" : "channel"
		};
	} catch {
		return null;
	}
}
function normalizeOutboundThreadId(value) {
	if (value == null) return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return;
		return String(Math.trunc(value));
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function buildDiscordBaseSessionKey(params) {
	return buildAgentSessionKey({
		agentId: params.agentId,
		channel: "discord",
		accountId: params.accountId,
		peer: params.peer,
		dmScope: params.cfg.session?.dmScope ?? "main",
		identityLinks: params.cfg.session?.identityLinks
	});
}
function resolveDiscordOutboundTargetKindHint(params) {
	const resolvedKind = params.resolvedTarget?.kind;
	if (resolvedKind === "user") return "user";
	if (resolvedKind === "group" || resolvedKind === "channel") return "channel";
	const target = params.target.trim();
	if (/^channel:/i.test(target)) return "channel";
	if (/^(user:|discord:|@|<@!?)/i.test(target)) return "user";
}
function resolveDiscordOutboundSessionRoute(params) {
	const parsed = parseDiscordTarget(params.target, { defaultKind: resolveDiscordOutboundTargetKindHint(params) });
	if (!parsed) return null;
	const isDm = parsed.kind === "user";
	const peer = {
		kind: isDm ? "direct" : "channel",
		id: parsed.id
	};
	const baseSessionKey = buildDiscordBaseSessionKey({
		cfg: params.cfg,
		agentId: params.agentId,
		accountId: params.accountId,
		peer
	});
	const explicitThreadId = normalizeOutboundThreadId(params.threadId);
	return {
		sessionKey: resolveThreadSessionKeys({
			baseSessionKey,
			threadId: explicitThreadId ?? normalizeOutboundThreadId(params.replyToId),
			useSuffix: false
		}).sessionKey,
		baseSessionKey,
		peer,
		chatType: isDm ? "direct" : "channel",
		from: isDm ? `discord:${parsed.id}` : `discord:channel:${parsed.id}`,
		to: isDm ? `user:${parsed.id}` : `channel:${parsed.id}`,
		threadId: explicitThreadId ?? void 0
	};
}
const discordConfigAccessors = createScopedAccountConfigAccessors({
	resolveAccount: ({ cfg, accountId }) => resolveDiscordAccount({
		cfg,
		accountId
	}),
	resolveAllowFrom: (account) => account.config.dm?.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
	resolveDefaultTo: (account) => account.config.defaultTo
});
const discordConfigBase = createScopedChannelConfigBase({
	sectionKey: "discord",
	listAccountIds: listDiscordAccountIds,
	resolveAccount: (cfg, accountId) => resolveDiscordAccount({
		cfg,
		accountId
	}),
	inspectAccount: (cfg, accountId) => inspectDiscordAccount({
		cfg,
		accountId
	}),
	defaultAccountId: resolveDefaultDiscordAccountId,
	clearBaseFields: ["token", "name"]
});
const discordSetupWizard = createDiscordSetupWizardProxy(async () => ({ discordSetupWizard: (await loadDiscordChannelRuntime()).discordSetupWizard }));
const discordPlugin = {
	id: "discord",
	meta: { ...meta },
	setupWizard: discordSetupWizard,
	pairing: {
		idLabel: "discordUserId",
		normalizeAllowEntry: (entry) => entry.replace(/^(discord|user):/i, ""),
		notifyApproval: async ({ id }) => {
			await getDiscordRuntime().channel.discord.sendMessageDiscord(`user:${id}`, PAIRING_APPROVED_MESSAGE);
		}
	},
	capabilities: {
		chatTypes: [
			"direct",
			"channel",
			"thread"
		],
		polls: true,
		reactions: true,
		threads: true,
		media: true,
		nativeCommands: true
	},
	streaming: { blockStreamingCoalesceDefaults: {
		minChars: 1500,
		idleMs: 1e3
	} },
	reload: { configPrefixes: ["channels.discord"] },
	configSchema: buildChannelConfigSchema(DiscordConfigSchema),
	config: {
		...discordConfigBase,
		isConfigured: (account) => Boolean(account.token?.trim()),
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: Boolean(account.token?.trim()),
			tokenSource: account.tokenSource
		}),
		...discordConfigAccessors
	},
	allowlist: {
		supportsScope: ({ scope }) => scope === "dm",
		readConfig: ({ cfg, accountId }) => readDiscordAllowlistConfig(resolveDiscordAccount({
			cfg,
			accountId
		})),
		resolveNames: async ({ cfg, accountId, entries }) => await resolveDiscordAllowlistNames({
			cfg,
			accountId,
			entries
		}),
		applyConfigEdit: buildAccountScopedAllowlistConfigEditor({
			channelId: "discord",
			normalize: ({ cfg, accountId, values }) => discordConfigAccessors.formatAllowFrom({
				cfg,
				accountId,
				allowFrom: values
			}),
			resolvePaths: (scope) => scope === "dm" ? {
				readPaths: [["allowFrom"], ["dm", "allowFrom"]],
				writePath: ["allowFrom"],
				cleanupPaths: [["dm", "allowFrom"]]
			} : null
		})
	},
	security: {
		resolveDmPolicy: ({ cfg, accountId, account }) => {
			return buildAccountScopedDmSecurityPolicy({
				cfg,
				channelKey: "discord",
				accountId,
				fallbackAccountId: account.accountId ?? "default",
				policy: account.config.dm?.policy,
				allowFrom: account.config.dm?.allowFrom ?? [],
				allowFromPathSuffix: "dm.",
				normalizeEntry: (raw) => raw.replace(/^(discord|user):/i, "").replace(/^<@!?(\d+)>$/, "$1")
			});
		},
		collectWarnings: ({ account, cfg }) => {
			const guildEntries = account.config.guilds ?? {};
			const channelAllowlistConfigured = Object.keys(guildEntries).length > 0;
			return collectOpenProviderGroupPolicyWarnings({
				cfg,
				providerConfigPresent: cfg.channels?.discord !== void 0,
				configuredGroupPolicy: account.config.groupPolicy,
				collect: (groupPolicy) => collectOpenGroupPolicyConfiguredRouteWarnings({
					groupPolicy,
					routeAllowlistConfigured: channelAllowlistConfigured,
					configureRouteAllowlist: {
						surface: "Discord guilds",
						openScope: "any channel not explicitly denied",
						groupPolicyPath: "channels.discord.groupPolicy",
						routeAllowlistPath: "channels.discord.guilds.<id>.channels"
					},
					missingRouteAllowlist: {
						surface: "Discord guilds",
						openBehavior: "with no guild/channel allowlist; any channel can trigger (mention-gated)",
						remediation: "Set channels.discord.groupPolicy=\"allowlist\" and configure channels.discord.guilds.<id>.channels"
					}
				})
			});
		}
	},
	groups: {
		resolveRequireMention: resolveDiscordGroupRequireMention,
		resolveToolPolicy: resolveDiscordGroupToolPolicy
	},
	mentions: { stripPatterns: () => ["<@!?\\d+>"] },
	threading: { resolveReplyToMode: ({ cfg }) => cfg.channels?.discord?.replyToMode ?? "off" },
	agentPrompt: { messageToolHints: () => ["- Discord components: set `components` when sending messages to include buttons, selects, or v2 containers.", "- Forms: add `components.modal` (title, fields). OpenClaw adds a trigger button and routes submissions as new messages."] },
	messaging: {
		normalizeTarget: normalizeDiscordMessagingTarget,
		parseExplicitTarget: ({ raw }) => parseDiscordExplicitTarget(raw),
		inferTargetChatType: ({ to }) => parseDiscordExplicitTarget(to)?.chatType,
		buildCrossContextComponents: buildDiscordCrossContextComponents,
		resolveOutboundSessionRoute: (params) => resolveDiscordOutboundSessionRoute(params),
		targetResolver: {
			looksLikeId: looksLikeDiscordTargetId,
			hint: "<channelId|user:ID|channel:ID>"
		}
	},
	execApprovals: {
		getInitiatingSurfaceState: ({ cfg, accountId }) => isDiscordExecApprovalClientEnabled({
			cfg,
			accountId
		}) ? { kind: "enabled" } : { kind: "disabled" },
		shouldSuppressLocalPrompt: ({ cfg, accountId, payload }) => shouldSuppressLocalDiscordExecApprovalPrompt({
			cfg,
			accountId,
			payload
		}),
		hasConfiguredDmRoute: ({ cfg }) => hasDiscordExecApprovalDmRoute(cfg),
		shouldSuppressForwardingFallback: ({ cfg, target }) => (normalizeMessageChannel(target.channel) ?? target.channel) === "discord" && isDiscordExecApprovalClientEnabled({
			cfg,
			accountId: target.accountId
		})
	},
	directory: {
		self: async () => null,
		listPeers: async (params) => listDiscordDirectoryPeersFromConfig(params),
		listGroups: async (params) => listDiscordDirectoryGroupsFromConfig(params),
		listPeersLive: async (params) => getDiscordRuntime().channel.discord.listDirectoryPeersLive(params),
		listGroupsLive: async (params) => getDiscordRuntime().channel.discord.listDirectoryGroupsLive(params)
	},
	resolver: { resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
		const token = resolveDiscordAccount({
			cfg,
			accountId
		}).token?.trim();
		if (!token) return inputs.map((input) => ({
			input,
			resolved: false,
			note: "missing Discord token"
		}));
		if (kind === "group") return (await getDiscordRuntime().channel.discord.resolveChannelAllowlist({
			token,
			entries: inputs
		})).map((entry) => ({
			input: entry.input,
			resolved: entry.resolved,
			id: entry.channelId ?? entry.guildId,
			name: entry.channelName ?? entry.guildName ?? (entry.guildId && !entry.channelId ? entry.guildId : void 0),
			note: entry.note
		}));
		return (await getDiscordRuntime().channel.discord.resolveUserAllowlist({
			token,
			entries: inputs
		})).map((entry) => ({
			input: entry.input,
			resolved: entry.resolved,
			id: entry.id,
			name: entry.name,
			note: entry.note
		}));
	} },
	actions: discordMessageActions,
	setup: discordSetupAdapter,
	outbound: {
		deliveryMode: "direct",
		chunker: null,
		textChunkLimit: 2e3,
		pollMaxOptions: 10,
		resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
		sendText: async ({ cfg, to, text, accountId, deps, replyToId, silent }) => {
			return {
				channel: "discord",
				...await (resolveOutboundSendDep(deps, "discord") ?? getDiscordRuntime().channel.discord.sendMessageDiscord)(to, text, {
					verbose: false,
					cfg,
					replyTo: replyToId ?? void 0,
					accountId: accountId ?? void 0,
					silent: silent ?? void 0
				})
			};
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps, replyToId, silent }) => {
			return {
				channel: "discord",
				...await (resolveOutboundSendDep(deps, "discord") ?? getDiscordRuntime().channel.discord.sendMessageDiscord)(to, text, {
					verbose: false,
					cfg,
					mediaUrl,
					mediaLocalRoots,
					replyTo: replyToId ?? void 0,
					accountId: accountId ?? void 0,
					silent: silent ?? void 0
				})
			};
		},
		sendPoll: async ({ cfg, to, poll, accountId, silent }) => await getDiscordRuntime().channel.discord.sendPollDiscord(to, poll, {
			cfg,
			accountId: accountId ?? void 0,
			silent: silent ?? void 0
		})
	},
	acpBindings: {
		normalizeConfiguredBindingTarget: ({ conversationId }) => normalizeDiscordAcpConversationId(conversationId),
		matchConfiguredBinding: ({ bindingConversationId, conversationId, parentConversationId }) => matchDiscordAcpConversation({
			bindingConversationId,
			conversationId,
			parentConversationId
		})
	},
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: false,
			connected: false,
			reconnectAttempts: 0,
			lastConnectedAt: null,
			lastDisconnect: null,
			lastEventAt: null,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null
		},
		collectStatusIssues: collectDiscordStatusIssues,
		buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot, { includeMode: false }),
		probeAccount: async ({ account, timeoutMs }) => getDiscordRuntime().channel.discord.probeDiscord(account.token, timeoutMs, { includeApplication: true }),
		formatCapabilitiesProbe: ({ probe }) => {
			const discordProbe = probe;
			const lines = [];
			if (discordProbe?.bot?.username) {
				const botId = discordProbe.bot.id ? ` (${discordProbe.bot.id})` : "";
				lines.push({ text: `Bot: @${discordProbe.bot.username}${botId}` });
			}
			if (discordProbe?.application?.intents) lines.push({ text: `Intents: ${formatDiscordIntents(discordProbe.application.intents)}` });
			return lines;
		},
		buildCapabilitiesDiagnostics: async ({ account, timeoutMs, target }) => {
			if (!target?.trim()) return;
			const parsedTarget = parseDiscordTarget(target.trim(), { defaultKind: "channel" });
			const details = { target: {
				raw: target,
				normalized: parsedTarget?.normalized,
				kind: parsedTarget?.kind,
				channelId: parsedTarget?.kind === "channel" ? parsedTarget.id : void 0
			} };
			if (!parsedTarget || parsedTarget.kind !== "channel") return {
				details,
				lines: [{
					text: "Permissions: Target looks like a DM user; pass channel:<id> to audit channel permissions.",
					tone: "error"
				}]
			};
			const token = account.token?.trim();
			if (!token) return {
				details,
				lines: [{
					text: "Permissions: Discord bot token missing for permission audit.",
					tone: "error"
				}]
			};
			try {
				const perms = await fetchChannelPermissionsDiscord(parsedTarget.id, {
					token,
					accountId: account.accountId ?? void 0
				});
				const missingRequired = REQUIRED_DISCORD_PERMISSIONS.filter((permission) => !perms.permissions.includes(permission));
				details.permissions = {
					channelId: perms.channelId,
					guildId: perms.guildId,
					isDm: perms.isDm,
					channelType: perms.channelType,
					permissions: perms.permissions,
					missingRequired,
					raw: perms.raw
				};
				return {
					details,
					lines: [{ text: `Permissions (${perms.channelId}): ${perms.permissions.length ? perms.permissions.join(", ") : "none"}` }, missingRequired.length > 0 ? {
						text: `Missing required: ${missingRequired.join(", ")}`,
						tone: "warn"
					} : {
						text: "Missing required: none",
						tone: "success"
					}]
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				details.permissions = {
					channelId: parsedTarget.id,
					error: message
				};
				return {
					details,
					lines: [{
						text: `Permissions: ${message}`,
						tone: "error"
					}]
				};
			}
		},
		auditAccount: async ({ account, timeoutMs, cfg }) => {
			const { channelIds, unresolvedChannels } = collectDiscordAuditChannelIds({
				cfg,
				accountId: account.accountId
			});
			if (!channelIds.length && unresolvedChannels === 0) return;
			const botToken = account.token?.trim();
			if (!botToken) return {
				ok: unresolvedChannels === 0,
				checkedChannels: 0,
				unresolvedChannels,
				channels: [],
				elapsedMs: 0
			};
			return {
				...await getDiscordRuntime().channel.discord.auditChannelPermissions({
					token: botToken,
					accountId: account.accountId,
					channelIds,
					timeoutMs
				}),
				unresolvedChannels
			};
		},
		buildAccountSnapshot: ({ account, runtime, probe, audit }) => {
			const configured = resolveConfiguredFromCredentialStatuses(account) ?? Boolean(account.token?.trim());
			const app = runtime?.application ?? probe?.application;
			const bot = runtime?.bot ?? probe?.bot;
			return {
				...buildComputedAccountStatusSnapshot({
					accountId: account.accountId,
					name: account.name,
					enabled: account.enabled,
					configured,
					runtime,
					probe
				}),
				...projectCredentialSnapshotFields(account),
				connected: runtime?.connected ?? false,
				reconnectAttempts: runtime?.reconnectAttempts,
				lastConnectedAt: runtime?.lastConnectedAt ?? null,
				lastDisconnect: runtime?.lastDisconnect ?? null,
				lastEventAt: runtime?.lastEventAt ?? null,
				application: app ?? void 0,
				bot: bot ?? void 0,
				audit
			};
		}
	},
	gateway: { startAccount: async (ctx) => {
		const account = ctx.account;
		const token = account.token.trim();
		let discordBotLabel = "";
		try {
			const probe = await getDiscordRuntime().channel.discord.probeDiscord(token, 2500, { includeApplication: true });
			const username = probe.ok ? probe.bot?.username?.trim() : null;
			if (username) discordBotLabel = ` (@${username})`;
			ctx.setStatus({
				accountId: account.accountId,
				bot: probe.bot,
				application: probe.application
			});
			const messageContent = probe.application?.intents?.messageContent;
			if (messageContent === "disabled") ctx.log?.warn(`[${account.accountId}] Discord Message Content Intent is disabled; bot may not respond to channel messages. Enable it in Discord Dev Portal (Bot → Privileged Gateway Intents) or require mentions.`);
			else if (messageContent === "limited") ctx.log?.info(`[${account.accountId}] Discord Message Content Intent is limited; bots under 100 servers can use it without verification.`);
		} catch (err) {
			if (getDiscordRuntime().logging.shouldLogVerbose()) ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
		}
		ctx.log?.info(`[${account.accountId}] starting provider${discordBotLabel}`);
		return getDiscordRuntime().channel.discord.monitorDiscordProvider({
			token,
			accountId: account.accountId,
			config: ctx.cfg,
			runtime: ctx.runtime,
			abortSignal: ctx.abortSignal,
			mediaMaxMb: account.config.mediaMaxMb,
			historyLimit: account.config.historyLimit,
			setStatus: (patch) => ctx.setStatus({
				accountId: account.accountId,
				...patch
			})
		});
	} }
};
//#endregion
//#region extensions/discord/src/subagent-hooks.ts
init_accounts();
function summarizeError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "error";
}
function registerDiscordSubagentHooks(api) {
	const resolveThreadBindingFlags = (accountId) => {
		const account = resolveDiscordAccount({
			cfg: api.config,
			accountId
		});
		const baseThreadBindings = api.config.channels?.discord?.threadBindings;
		const accountThreadBindings = api.config.channels?.discord?.accounts?.[account.accountId]?.threadBindings;
		return {
			enabled: accountThreadBindings?.enabled ?? baseThreadBindings?.enabled ?? api.config.session?.threadBindings?.enabled ?? true,
			spawnSubagentSessions: accountThreadBindings?.spawnSubagentSessions ?? baseThreadBindings?.spawnSubagentSessions ?? false
		};
	};
	api.on("subagent_spawning", async (event) => {
		if (!event.threadRequested) return;
		if (event.requester?.channel?.trim().toLowerCase() !== "discord") return;
		const threadBindingFlags = resolveThreadBindingFlags(event.requester?.accountId);
		if (!threadBindingFlags.enabled) return {
			status: "error",
			error: "Discord thread bindings are disabled (set channels.discord.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally)."
		};
		if (!threadBindingFlags.spawnSubagentSessions) return {
			status: "error",
			error: "Discord thread-bound subagent spawns are disabled for this account (set channels.discord.threadBindings.spawnSubagentSessions=true to enable)."
		};
		try {
			if (!await autoBindSpawnedDiscordSubagent({
				accountId: event.requester?.accountId,
				channel: event.requester?.channel,
				to: event.requester?.to,
				threadId: event.requester?.threadId,
				childSessionKey: event.childSessionKey,
				agentId: event.agentId,
				label: event.label,
				boundBy: "system"
			})) return {
				status: "error",
				error: "Unable to create or bind a Discord thread for this subagent session. Session mode is unavailable for this target."
			};
			return {
				status: "ok",
				threadBindingReady: true
			};
		} catch (err) {
			return {
				status: "error",
				error: `Discord thread bind failed: ${summarizeError(err)}`
			};
		}
	});
	api.on("subagent_ended", (event) => {
		unbindThreadBindingsBySessionKey({
			targetSessionKey: event.targetSessionKey,
			accountId: event.accountId,
			targetKind: event.targetKind,
			reason: event.reason,
			sendFarewell: event.sendFarewell
		});
	});
	api.on("subagent_delivery_target", (event) => {
		if (!event.expectsCompletionMessage) return;
		if (event.requesterOrigin?.channel?.trim().toLowerCase() !== "discord") return;
		const requesterAccountId = event.requesterOrigin?.accountId?.trim();
		const requesterThreadId = event.requesterOrigin?.threadId != null && event.requesterOrigin.threadId !== "" ? String(event.requesterOrigin.threadId).trim() : "";
		const bindings = listThreadBindingsBySessionKey({
			targetSessionKey: event.childSessionKey,
			...requesterAccountId ? { accountId: requesterAccountId } : {},
			targetKind: "subagent"
		});
		if (bindings.length === 0) return;
		let binding;
		if (requesterThreadId) binding = bindings.find((entry) => {
			if (entry.threadId !== requesterThreadId) return false;
			if (requesterAccountId && entry.accountId !== requesterAccountId) return false;
			return true;
		});
		if (!binding && bindings.length === 1) binding = bindings[0];
		if (!binding) return;
		return { origin: {
			channel: "discord",
			accountId: binding.accountId,
			to: `channel:${binding.threadId}`,
			threadId: binding.threadId
		} };
	});
}
//#endregion
//#region extensions/discord/index.ts
const plugin = {
	id: "discord",
	name: "Discord",
	description: "Discord channel plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		setDiscordRuntime(api.runtime);
		api.registerChannel({ plugin: discordPlugin });
		if (api.registrationMode !== "full") return;
		registerDiscordSubagentHooks(api);
	}
};
//#endregion
export { plugin as default };
