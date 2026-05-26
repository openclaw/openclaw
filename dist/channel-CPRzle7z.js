import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-CwBWagLE.js";
import { t as sanitizeForPlainText } from "./sanitize-text-QuMt6r4k.js";
import { l as createScopedDmSecurityResolver, s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "./channel-config-helpers-Dzal6cfS.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { n as describeAccountSnapshot } from "./account-helpers-Ba4hZbOH.js";
import { a as createSetupInputPresenceValidator, l as patchScopedAccountConfig, t as applyAccountNameToChannelSection } from "./setup-helpers-D1h9Zq-C.js";
import { i as createChatChannelPlugin } from "./core-BPnS_bab.js";
import "./channel-core-BoAjH-Jl.js";
import "./routing-BfSZVtOk.js";
import { t as createAccountStatusSink } from "./channel-lifecycle.core-2s7owtO-.js";
import { n as formatNormalizedAllowFromEntries } from "./allow-from-CFKhmZbv.js";
import { _ as createAllowlistProviderOpenWarningCollector, m as composeAccountWarningCollectors, n as createDangerousNameMatchingMutableAllowlistWarningCollector } from "./channel-policy-DorgJeIC.js";
import { t as createChannelDirectoryAdapter } from "./directory-runtime-zNq6TUqB.js";
import { i as createResolvedDirectoryEntriesLister } from "./directory-config-helpers-DE5wfd2q.js";
import { J as setSetupChannelEnabled, a as createAllowFromSection, d as createPromptParsedAllowFromForAccount, f as createStandardChannelSetupStatus, h as createTopLevelChannelDmPolicySetter, p as createTopLevelChannelAllowFromSetter } from "./setup-wizard-helpers-Cm8y4liy.js";
import "./setup-BmF6Yxnk.js";
import "./outbound-runtime-HTtq1b9m.js";
import { t as chunkTextForOutbound } from "./text-chunking-3_9rfiI8.js";
import { t as PAIRING_APPROVED_MESSAGE } from "./pairing-message-C5_Dm1pD.js";
import { d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, u as createComputedAccountStatusAdapter } from "./status-helpers-Dk-3BT6p.js";
import "./channel-status-DQzE7laT.js";
import { h as runStoppablePassiveMonitor } from "./extension-shared-BznPIa-o.js";
import "./channel-lifecycle-BrKB268B.js";
import { r as defineChannelMessageAdapter } from "./channel-message-CmG6T1ry.js";
import { a as isChannelTarget, c as normalizeIrcMessagingTarget, h as resolveIrcAccount, l as buildIrcConnectOptions, m as resolveDefaultIrcAccountId, n as resolveIrcRequireMention, o as looksLikeIrcTargetId, p as listIrcAccountIds, r as sendMessageIrc, s as normalizeIrcAllowEntry, t as resolveIrcGroupMatch, u as connectIrcClient } from "./policy-C4h8Ub6j.js";
import { t as IrcChannelConfigSchema } from "./config-schema-CllxAsJq.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "./secret-contract-BLd_ucM3.js";
//#region extensions/irc/src/doctor.ts
function asObjectRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function isIrcMutableAllowEntry(raw) {
	const text = normalizeLowercaseStringOrEmpty(raw);
	if (!text || text === "*") return false;
	const normalized = text.replace(/^irc:/, "").replace(/^user:/, "").trim();
	return !normalized.includes("!") && !normalized.includes("@");
}
const collectIrcMutableAllowlistWarnings = createDangerousNameMatchingMutableAllowlistWarningCollector({
	channel: "irc",
	detector: isIrcMutableAllowEntry,
	collectLists: (scope) => {
		const lists = [{
			pathLabel: `${scope.prefix}.allowFrom`,
			list: scope.account.allowFrom
		}, {
			pathLabel: `${scope.prefix}.groupAllowFrom`,
			list: scope.account.groupAllowFrom
		}];
		const groups = asObjectRecord(scope.account.groups);
		if (groups) for (const [groupKey, groupRaw] of Object.entries(groups)) {
			const group = asObjectRecord(groupRaw);
			if (!group) continue;
			lists.push({
				pathLabel: `${scope.prefix}.groups.${groupKey}.allowFrom`,
				list: group.allowFrom
			});
		}
		return lists;
	}
});
//#endregion
//#region extensions/irc/src/gateway.ts
let ircChannelRuntimePromise$1;
async function loadIrcChannelRuntime$1() {
	ircChannelRuntimePromise$1 ??= import("./channel-runtime-CEjL3rxb.js");
	return await ircChannelRuntimePromise$1;
}
async function startIrcGatewayAccount(ctx) {
	const account = ctx.account;
	const statusSink = createAccountStatusSink({
		accountId: ctx.accountId,
		setStatus: ctx.setStatus
	});
	if (!account.configured) throw new Error(`IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`);
	ctx.log?.info?.(`[${account.accountId}] starting IRC provider (${account.host}:${account.port}${account.tls ? " tls" : ""})`);
	const { monitorIrcProvider } = await loadIrcChannelRuntime$1();
	await runStoppablePassiveMonitor({
		abortSignal: ctx.abortSignal,
		start: async () => await monitorIrcProvider({
			accountId: account.accountId,
			config: ctx.cfg,
			runtime: ctx.runtime,
			abortSignal: ctx.abortSignal,
			statusSink
		})
	});
}
//#endregion
//#region extensions/irc/src/message-adapter.ts
const ircMessageAdapter = defineChannelMessageAdapter({
	id: "irc",
	durableFinal: { capabilities: {
		text: true,
		media: true,
		replyTo: true
	} },
	send: {
		text: async ({ cfg, to, text, accountId, replyToId }) => await sendMessageIrc(to, text, {
			cfg,
			accountId: accountId ?? void 0,
			replyTo: replyToId ?? void 0
		}),
		media: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => await sendMessageIrc(to, mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text, {
			cfg,
			accountId: accountId ?? void 0,
			replyTo: replyToId ?? void 0
		})
	}
});
//#endregion
//#region extensions/irc/src/outbound-base.ts
const ircOutboundBaseAdapter = {
	deliveryMode: "direct",
	chunker: chunkTextForOutbound,
	chunkerMode: "markdown",
	textChunkLimit: 350,
	sanitizeText: ({ text }) => sanitizeForPlainText(text)
};
//#endregion
//#region extensions/irc/src/probe.ts
function formatError(err) {
	if (err instanceof Error) return err.message;
	return typeof err === "string" ? err : JSON.stringify(err);
}
async function probeIrc(cfg, opts) {
	const account = resolveIrcAccount({
		cfg,
		accountId: opts?.accountId
	});
	const base = {
		ok: false,
		host: account.host,
		port: account.port,
		tls: account.tls,
		nick: account.nick
	};
	if (!account.configured) return {
		...base,
		error: "missing host or nick"
	};
	const started = Date.now();
	try {
		const client = await connectIrcClient(buildIrcConnectOptions(account, { connectTimeoutMs: opts?.timeoutMs ?? 8e3 }));
		const elapsed = Date.now() - started;
		client.quit("probe");
		return {
			...base,
			ok: true,
			latencyMs: elapsed
		};
	} catch (err) {
		return {
			...base,
			error: formatError(err)
		};
	}
}
//#endregion
//#region extensions/irc/src/setup-core.ts
const channel$1 = "irc";
const setIrcTopLevelDmPolicy = createTopLevelChannelDmPolicySetter({ channel: channel$1 });
const setIrcTopLevelAllowFrom = createTopLevelChannelAllowFromSetter({ channel: channel$1 });
function parsePort(raw, fallback) {
	const trimmed = raw.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return fallback;
	return parsed;
}
function updateIrcAccountConfig(cfg, accountId, patch) {
	return patchScopedAccountConfig({
		cfg,
		channelKey: channel$1,
		accountId,
		patch,
		ensureChannelEnabled: false,
		ensureAccountEnabled: false
	});
}
function setIrcDmPolicy(cfg, dmPolicy) {
	return setIrcTopLevelDmPolicy(cfg, dmPolicy);
}
function setIrcAllowFrom(cfg, allowFrom) {
	return setIrcTopLevelAllowFrom(cfg, allowFrom);
}
function setIrcNickServ(cfg, accountId, nickserv) {
	return updateIrcAccountConfig(cfg, accountId, { nickserv });
}
function setIrcGroupAccess(cfg, accountId, policy, entries, normalizeGroupEntry) {
	if (policy !== "allowlist") return updateIrcAccountConfig(cfg, accountId, {
		enabled: true,
		groupPolicy: policy
	});
	const normalizedEntries = [...new Set(entries.map((entry) => normalizeGroupEntry(entry)).filter(Boolean))];
	return updateIrcAccountConfig(cfg, accountId, {
		enabled: true,
		groupPolicy: "allowlist",
		groups: Object.fromEntries(normalizedEntries.map((entry) => [entry, {}]))
	});
}
const ircSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
		cfg,
		channelKey: channel$1,
		accountId,
		name
	}),
	validateInput: createSetupInputPresenceValidator({ whenNotUseEnv: [{
		someOf: ["host"],
		message: "IRC requires host."
	}, {
		someOf: ["nick"],
		message: "IRC requires nick."
	}] }),
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const setupInput = input;
		const namedConfig = applyAccountNameToChannelSection({
			cfg,
			channelKey: channel$1,
			accountId,
			name: setupInput.name
		});
		const portInput = typeof setupInput.port === "number" ? String(setupInput.port) : setupInput.port ?? "";
		return patchScopedAccountConfig({
			cfg: namedConfig,
			channelKey: channel$1,
			accountId,
			patch: {
				enabled: true,
				host: setupInput.host?.trim(),
				port: portInput ? parsePort(portInput, setupInput.tls === false ? 6667 : 6697) : void 0,
				tls: setupInput.tls,
				nick: setupInput.nick?.trim(),
				username: setupInput.username?.trim(),
				realname: setupInput.realname?.trim(),
				password: setupInput.password?.trim(),
				channels: setupInput.channels
			}
		});
	}
};
//#endregion
//#region extensions/irc/src/setup-surface.ts
const channel = "irc";
const USE_ENV_FLAG = "__ircUseEnv";
const TLS_FLAG = "__ircTls";
function parseListInput(raw) {
	return raw.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
}
function normalizeGroupEntry(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (trimmed === "*") return "*";
	const normalized = normalizeIrcMessagingTarget(trimmed) ?? trimmed;
	if (isChannelTarget(normalized)) return normalized;
	return `#${normalized.replace(/^#+/, "")}`;
}
const promptIrcAllowFrom = createPromptParsedAllowFromForAccount({
	defaultAccountId: (cfg) => resolveDefaultIrcAccountId(cfg),
	noteTitle: "IRC allowlist",
	noteLines: [
		"Allowlist IRC DMs by sender.",
		"Examples:",
		"- alice",
		"- alice!ident@example.org",
		"Multiple entries: comma-separated."
	],
	message: "IRC allowFrom (nick or nick!user@host)",
	placeholder: "alice, bob!ident@example.org",
	parseEntries: (raw) => ({ entries: parseListInput(raw).map((entry) => normalizeIrcAllowEntry(entry)).map((entry) => entry.trim()).filter(Boolean) }),
	getExistingAllowFrom: ({ cfg }) => cfg.channels?.irc?.allowFrom ?? [],
	applyAllowFrom: ({ cfg, allowFrom }) => setIrcAllowFrom(cfg, allowFrom)
});
async function promptIrcNickServConfig(params) {
	const existing = resolveIrcAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).config.nickserv;
	const hasExisting = Boolean(existing?.password || existing?.passwordFile);
	if (!await params.prompter.confirm({
		message: hasExisting ? "Update NickServ settings?" : "Configure NickServ identify/register?",
		initialValue: hasExisting
	})) return params.cfg;
	const service = (await params.prompter.text({
		message: "NickServ service nick",
		initialValue: existing?.service || "NickServ",
		validate: (value) => normalizeStringifiedOptionalString(value) ? void 0 : "Required"
	})).trim();
	const useEnvPassword = params.accountId === "default" && Boolean(process.env.IRC_NICKSERV_PASSWORD?.trim()) && !(existing?.password || existing?.passwordFile) ? await params.prompter.confirm({
		message: "IRC_NICKSERV_PASSWORD detected. Use env var?",
		initialValue: true
	}) : false;
	const password = useEnvPassword ? void 0 : (await params.prompter.text({
		message: "NickServ password (blank to disable NickServ auth)",
		validate: () => void 0
	})).trim();
	if (!password && !useEnvPassword) return setIrcNickServ(params.cfg, params.accountId, {
		enabled: false,
		service
	});
	const register = await params.prompter.confirm({
		message: "Send NickServ REGISTER on connect?",
		initialValue: existing?.register ?? false
	});
	const registerEmail = register ? (await params.prompter.text({
		message: "NickServ register email",
		initialValue: existing?.registerEmail || (params.accountId === "default" ? process.env.IRC_NICKSERV_REGISTER_EMAIL : void 0),
		validate: (value) => normalizeStringifiedOptionalString(value) ? void 0 : "Required"
	})).trim() : void 0;
	return setIrcNickServ(params.cfg, params.accountId, {
		enabled: true,
		service,
		...password ? { password } : {},
		register,
		...registerEmail ? { registerEmail } : {}
	});
}
const ircDmPolicy = {
	label: "IRC",
	channel,
	policyKey: "channels.irc.dmPolicy",
	allowFromKey: "channels.irc.allowFrom",
	getCurrent: (cfg) => cfg.channels?.irc?.dmPolicy ?? "pairing",
	setPolicy: (cfg, policy) => setIrcDmPolicy(cfg, policy),
	promptAllowFrom: async ({ cfg, prompter, accountId }) => await promptIrcAllowFrom({
		cfg,
		prompter,
		accountId
	})
};
const ircSetupWizard = {
	channel,
	status: createStandardChannelSetupStatus({
		channelLabel: "IRC",
		configuredLabel: "configured",
		unconfiguredLabel: "needs host + nick",
		configuredHint: "configured",
		unconfiguredHint: "needs host + nick",
		configuredScore: 1,
		unconfiguredScore: 0,
		includeStatusLine: true,
		resolveConfigured: ({ cfg, accountId }) => resolveIrcAccount({
			cfg,
			accountId
		}).configured
	}),
	introNote: {
		title: "IRC setup",
		lines: [
			"IRC needs server host + bot nick.",
			"Recommended: TLS on port 6697.",
			"Optional: NickServ identify/register can be configured after the basic account fields.",
			"Set channels.irc.groupPolicy=\"allowlist\" and channels.irc.groups for tighter channel control.",
			"Note: IRC channels are mention-gated by default. To allow unmentioned replies, set channels.irc.groups[\"#channel\"].requireMention=false (or \"*\" for all).",
			"Env vars supported: IRC_HOST, IRC_PORT, IRC_TLS, IRC_NICK, IRC_USERNAME, IRC_REALNAME, IRC_PASSWORD, IRC_CHANNELS, IRC_NICKSERV_PASSWORD, IRC_NICKSERV_REGISTER_EMAIL.",
			`Docs: ${formatDocsLink("/channels/irc", "channels/irc")}`
		],
		shouldShow: ({ cfg, accountId }) => !resolveIrcAccount({
			cfg,
			accountId
		}).configured
	},
	prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
		const resolved = resolveIrcAccount({
			cfg,
			accountId
		});
		const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID;
		const envHost = isDefaultAccount ? normalizeOptionalString(process.env.IRC_HOST) ?? "" : "";
		const envNick = isDefaultAccount ? normalizeOptionalString(process.env.IRC_NICK) ?? "" : "";
		if (Boolean(envHost && envNick && !resolved.config.host && !resolved.config.nick)) {
			if (await prompter.confirm({
				message: "IRC_HOST and IRC_NICK detected. Use env vars?",
				initialValue: true
			})) return {
				cfg: updateIrcAccountConfig(cfg, accountId, { enabled: true }),
				credentialValues: {
					...credentialValues,
					[USE_ENV_FLAG]: "1"
				}
			};
		}
		const tls = await prompter.confirm({
			message: "Use TLS for IRC?",
			initialValue: resolved.config.tls ?? true
		});
		return {
			cfg: updateIrcAccountConfig(cfg, accountId, {
				enabled: true,
				tls
			}),
			credentialValues: {
				...credentialValues,
				[USE_ENV_FLAG]: "0",
				[TLS_FLAG]: tls ? "1" : "0"
			}
		};
	},
	credentials: [],
	textInputs: [
		{
			inputKey: "httpHost",
			message: "IRC server host",
			currentValue: ({ cfg, accountId }) => resolveIrcAccount({
				cfg,
				accountId
			}).config.host || void 0,
			shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
			validate: ({ value }) => normalizeStringifiedOptionalString(value) ? void 0 : "Required",
			normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
			applySet: async ({ cfg, accountId, value }) => updateIrcAccountConfig(cfg, accountId, {
				enabled: true,
				host: value
			})
		},
		{
			inputKey: "httpPort",
			message: "IRC server port",
			currentValue: ({ cfg, accountId }) => String(resolveIrcAccount({
				cfg,
				accountId
			}).config.port ?? ""),
			shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
			initialValue: ({ cfg, accountId, credentialValues }) => {
				const resolved = resolveIrcAccount({
					cfg,
					accountId
				});
				const tls = credentialValues[TLS_FLAG] !== "0";
				const defaultPort = resolved.config.port ?? (tls ? 6697 : 6667);
				return String(defaultPort);
			},
			validate: ({ value }) => {
				const parsed = Number.parseInt(normalizeStringifiedOptionalString(value) ?? "", 10);
				return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535 ? void 0 : "Use a port between 1 and 65535";
			},
			normalizeValue: ({ value }) => String(parsePort(value, 6697)),
			applySet: async ({ cfg, accountId, value }) => updateIrcAccountConfig(cfg, accountId, {
				enabled: true,
				port: parsePort(value, 6697)
			})
		},
		{
			inputKey: "token",
			message: "IRC nick",
			currentValue: ({ cfg, accountId }) => resolveIrcAccount({
				cfg,
				accountId
			}).config.nick || void 0,
			shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
			validate: ({ value }) => normalizeStringifiedOptionalString(value) ? void 0 : "Required",
			normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
			applySet: async ({ cfg, accountId, value }) => updateIrcAccountConfig(cfg, accountId, {
				enabled: true,
				nick: value
			})
		},
		{
			inputKey: "userId",
			message: "IRC username",
			currentValue: ({ cfg, accountId }) => resolveIrcAccount({
				cfg,
				accountId
			}).config.username || void 0,
			shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
			initialValue: ({ cfg, accountId, credentialValues }) => resolveIrcAccount({
				cfg,
				accountId
			}).config.username || credentialValues.token || "openclaw",
			validate: ({ value }) => normalizeStringifiedOptionalString(value) ? void 0 : "Required",
			normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
			applySet: async ({ cfg, accountId, value }) => updateIrcAccountConfig(cfg, accountId, {
				enabled: true,
				username: value
			})
		},
		{
			inputKey: "deviceName",
			message: "IRC real name",
			currentValue: ({ cfg, accountId }) => resolveIrcAccount({
				cfg,
				accountId
			}).config.realname || void 0,
			shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
			initialValue: ({ cfg, accountId }) => resolveIrcAccount({
				cfg,
				accountId
			}).config.realname || "OpenClaw",
			validate: ({ value }) => normalizeStringifiedOptionalString(value) ? void 0 : "Required",
			normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
			applySet: async ({ cfg, accountId, value }) => updateIrcAccountConfig(cfg, accountId, {
				enabled: true,
				realname: value
			})
		},
		{
			inputKey: "groupChannels",
			message: "Auto-join IRC channels (optional, comma-separated)",
			placeholder: "#openclaw, #ops",
			required: false,
			applyEmptyValue: true,
			currentValue: ({ cfg, accountId }) => resolveIrcAccount({
				cfg,
				accountId
			}).config.channels?.join(", "),
			shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
			normalizeValue: ({ value }) => parseListInput(value).map((entry) => normalizeGroupEntry(entry)).filter((entry) => Boolean(entry && entry !== "*")).filter((entry) => isChannelTarget(entry)).join(", "),
			applySet: async ({ cfg, accountId, value }) => {
				const channels = parseListInput(value).map((entry) => normalizeGroupEntry(entry)).filter((entry) => Boolean(entry && entry !== "*")).filter((entry) => isChannelTarget(entry));
				return updateIrcAccountConfig(cfg, accountId, {
					enabled: true,
					channels: channels.length > 0 ? channels : void 0
				});
			}
		}
	],
	groupAccess: {
		label: "IRC channels",
		placeholder: "#openclaw, #ops, *",
		currentPolicy: ({ cfg, accountId }) => resolveIrcAccount({
			cfg,
			accountId
		}).config.groupPolicy ?? "allowlist",
		currentEntries: ({ cfg, accountId }) => Object.keys(resolveIrcAccount({
			cfg,
			accountId
		}).config.groups ?? {}),
		updatePrompt: ({ cfg, accountId }) => Boolean(resolveIrcAccount({
			cfg,
			accountId
		}).config.groups),
		setPolicy: ({ cfg, accountId, policy }) => setIrcGroupAccess(cfg, accountId, policy, [], normalizeGroupEntry),
		resolveAllowlist: async ({ entries }) => [...new Set(entries.map((entry) => normalizeGroupEntry(entry)).filter(Boolean))],
		applyAllowlist: ({ cfg, accountId, resolved }) => setIrcGroupAccess(cfg, accountId, "allowlist", resolved, normalizeGroupEntry)
	},
	allowFrom: createAllowFromSection({
		helpTitle: "IRC allowlist",
		helpLines: [
			"Allowlist IRC DMs by sender.",
			"Examples:",
			"- alice",
			"- alice!ident@example.org",
			"Multiple entries: comma-separated."
		],
		message: "IRC allowFrom (nick or nick!user@host)",
		placeholder: "alice, bob!ident@example.org",
		invalidWithoutCredentialNote: "Use an IRC nick or nick!user@host entry.",
		parseId: (raw) => {
			return normalizeIrcAllowEntry(raw) || null;
		},
		apply: async ({ cfg, allowFrom }) => setIrcAllowFrom(cfg, allowFrom)
	}),
	finalize: async ({ cfg, accountId, prompter }) => {
		let next = cfg;
		const resolvedAfterGroups = resolveIrcAccount({
			cfg: next,
			accountId
		});
		if (resolvedAfterGroups.config.groupPolicy === "allowlist") {
			if (Object.keys(resolvedAfterGroups.config.groups ?? {}).length > 0) {
				if (!await prompter.confirm({
					message: "Require @mention to reply in IRC channels?",
					initialValue: true
				})) {
					const groups = resolvedAfterGroups.config.groups ?? {};
					const patched = Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, {
						...value,
						requireMention: false
					}]));
					next = updateIrcAccountConfig(next, accountId, { groups: patched });
				}
			}
		}
		next = await promptIrcNickServConfig({
			cfg: next,
			prompter,
			accountId
		});
		return { cfg: next };
	},
	completionNote: {
		title: "IRC next steps",
		lines: [
			"Next: restart gateway and verify status.",
			"Command: openclaw channels status --probe",
			`Docs: ${formatDocsLink("/channels/irc", "channels/irc")}`
		]
	},
	dmPolicy: ircDmPolicy,
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
};
//#endregion
//#region extensions/irc/src/channel.ts
const meta = {
	id: "irc",
	label: "IRC",
	selectionLabel: "IRC (Server + Nick)",
	docsPath: "/channels/irc",
	docsLabel: "irc",
	blurb: "classic IRC networks; host, nick, channels.",
	order: 80,
	detailLabel: "IRC",
	systemImage: "number",
	markdownCapable: true
};
let ircChannelRuntimePromise;
async function loadIrcChannelRuntime() {
	ircChannelRuntimePromise ??= import("./channel-runtime-CEjL3rxb.js");
	return await ircChannelRuntimePromise;
}
function normalizePairingTarget(raw) {
	const normalized = normalizeIrcAllowEntry(raw);
	if (!normalized) return "";
	return normalized.split(/[!@]/, 1)[0]?.trim() ?? "";
}
const listIrcDirectoryPeersFromConfig = createResolvedDirectoryEntriesLister({
	kind: "user",
	resolveAccount: adaptScopedAccountAccessor(resolveIrcAccount),
	resolveSources: (account) => [
		account.config.allowFrom ?? [],
		account.config.groupAllowFrom ?? [],
		...Object.values(account.config.groups ?? {}).map((group) => group.allowFrom ?? [])
	],
	normalizeId: (entry) => normalizePairingTarget(entry) || null
});
const listIrcDirectoryGroupsFromConfig = createResolvedDirectoryEntriesLister({
	kind: "group",
	resolveAccount: adaptScopedAccountAccessor(resolveIrcAccount),
	resolveSources: (account) => [account.config.channels ?? [], Object.keys(account.config.groups ?? {})],
	normalizeId: (entry) => {
		const normalized = normalizeIrcMessagingTarget(entry);
		return normalized && isChannelTarget(normalized) ? normalized : null;
	}
});
const ircConfigAdapter = createScopedChannelConfigAdapter({
	sectionKey: "irc",
	listAccountIds: listIrcAccountIds,
	resolveAccount: adaptScopedAccountAccessor(resolveIrcAccount),
	defaultAccountId: resolveDefaultIrcAccountId,
	clearBaseFields: [
		"name",
		"host",
		"port",
		"tls",
		"nick",
		"username",
		"realname",
		"password",
		"passwordFile",
		"channels"
	],
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => formatNormalizedAllowFromEntries({
		allowFrom,
		normalizeEntry: normalizeIrcAllowEntry
	}),
	resolveDefaultTo: (account) => account.config.defaultTo
});
const resolveIrcDmPolicy = createScopedDmSecurityResolver({
	channelKey: "irc",
	resolvePolicy: (account) => account.config.dmPolicy,
	resolveAllowFrom: (account) => account.config.allowFrom,
	policyPathSuffix: "dmPolicy",
	normalizeEntry: (raw) => normalizeIrcAllowEntry(raw)
});
const collectIrcSecurityWarnings = composeAccountWarningCollectors(createAllowlistProviderOpenWarningCollector({
	providerConfigPresent: (cfg) => cfg.channels?.irc !== void 0,
	resolveGroupPolicy: (account) => account.config.groupPolicy,
	buildOpenWarning: {
		surface: "IRC channels",
		openBehavior: "allows all channels and senders (mention-gated)",
		remediation: "Prefer channels.irc.groupPolicy=\"allowlist\" with channels.irc.groups"
	}
}), (account) => !account.config.tls && "- IRC TLS is disabled (channels.irc.tls=false); traffic and credentials are plaintext.", (account) => account.config.nickserv?.register && "- IRC NickServ registration is enabled (channels.irc.nickserv.register=true); this sends \"REGISTER\" on every connect. Disable after first successful registration.", (account) => account.config.nickserv?.register && !account.config.nickserv.password?.trim() && "- IRC NickServ registration is enabled but no NickServ password is resolved; set channels.irc.nickserv.password, channels.irc.nickserv.passwordFile, or IRC_NICKSERV_PASSWORD.");
const ircPlugin = createChatChannelPlugin({
	base: {
		id: "irc",
		meta: {
			...meta,
			quickstartAllowFrom: true
		},
		setup: ircSetupAdapter,
		setupWizard: ircSetupWizard,
		capabilities: {
			chatTypes: ["direct", "group"],
			media: true,
			blockStreaming: true
		},
		reload: { configPrefixes: ["channels.irc"] },
		configSchema: IrcChannelConfigSchema,
		config: {
			...ircConfigAdapter,
			hasConfiguredState: ({ env }) => typeof env?.IRC_HOST === "string" && env.IRC_HOST.trim().length > 0 && typeof env?.IRC_NICK === "string" && env.IRC_NICK.trim().length > 0,
			isConfigured: (account) => account.configured,
			describeAccount: (account) => describeAccountSnapshot({
				account,
				configured: account.configured,
				extra: {
					host: account.host,
					port: account.port,
					tls: account.tls,
					nick: account.nick,
					passwordSource: account.passwordSource
				}
			})
		},
		secrets: {
			secretTargetRegistryEntries,
			collectRuntimeConfigAssignments
		},
		doctor: {
			groupAllowFromFallbackToAllowFrom: false,
			collectMutableAllowlistWarnings: collectIrcMutableAllowlistWarnings
		},
		groups: {
			resolveRequireMention: ({ cfg, accountId, groupId }) => {
				const account = resolveIrcAccount({
					cfg,
					accountId
				});
				if (!groupId) return true;
				const match = resolveIrcGroupMatch({
					groups: account.config.groups,
					target: groupId
				});
				return resolveIrcRequireMention({
					groupConfig: match.groupConfig,
					wildcardConfig: match.wildcardConfig
				});
			},
			resolveToolPolicy: ({ cfg, accountId, groupId }) => {
				const account = resolveIrcAccount({
					cfg,
					accountId
				});
				if (!groupId) return;
				const match = resolveIrcGroupMatch({
					groups: account.config.groups,
					target: groupId
				});
				return match.groupConfig?.tools ?? match.wildcardConfig?.tools;
			}
		},
		messaging: {
			targetPrefixes: ["irc"],
			normalizeTarget: normalizeIrcMessagingTarget,
			targetResolver: {
				looksLikeId: looksLikeIrcTargetId,
				hint: "<#channel|nick>"
			}
		},
		message: ircMessageAdapter,
		resolver: { resolveTargets: async ({ inputs, kind }) => {
			return inputs.map((input) => {
				const normalized = normalizeIrcMessagingTarget(input);
				if (!normalized) return {
					input,
					resolved: false,
					note: "invalid IRC target"
				};
				if (kind === "group") {
					const groupId = isChannelTarget(normalized) ? normalized : `#${normalized}`;
					return {
						input,
						resolved: true,
						id: groupId,
						name: groupId
					};
				}
				if (isChannelTarget(normalized)) return {
					input,
					resolved: false,
					note: "expected user target"
				};
				return {
					input,
					resolved: true,
					id: normalized,
					name: normalized
				};
			});
		} },
		directory: createChannelDirectoryAdapter({
			listPeers: async (params) => listIrcDirectoryPeersFromConfig(params),
			listGroups: async (params) => {
				return (await listIrcDirectoryGroupsFromConfig(params)).map((entry) => Object.assign({}, entry, { name: entry.id }));
			}
		}),
		status: createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
			buildChannelSummary: ({ account, snapshot }) => ({
				...buildBaseChannelStatusSummary(snapshot),
				host: account.host,
				port: snapshot.port,
				tls: account.tls,
				nick: account.nick,
				probe: snapshot.probe,
				lastProbeAt: snapshot.lastProbeAt ?? null
			}),
			probeAccount: async ({ cfg, account, timeoutMs }) => probeIrc(cfg, {
				accountId: account.accountId,
				timeoutMs
			}),
			resolveAccountSnapshot: ({ account }) => ({
				accountId: account.accountId,
				name: account.name,
				enabled: account.enabled,
				configured: account.configured,
				extra: {
					host: account.host,
					port: account.port,
					tls: account.tls,
					nick: account.nick,
					passwordSource: account.passwordSource
				}
			})
		}),
		gateway: { startAccount: async (ctx) => await startIrcGatewayAccount({
			...ctx,
			cfg: ctx.cfg
		}) }
	},
	pairing: { text: {
		idLabel: "ircUser",
		message: PAIRING_APPROVED_MESSAGE,
		normalizeAllowEntry: (entry) => normalizeIrcAllowEntry(entry),
		notify: async ({ cfg, id, message }) => {
			const target = normalizePairingTarget(id);
			if (!target) throw new Error(`invalid IRC pairing id: ${id}`);
			const { sendMessageIrc } = await loadIrcChannelRuntime();
			await sendMessageIrc(target, message, { cfg });
		}
	} },
	security: {
		resolveDmPolicy: resolveIrcDmPolicy,
		collectWarnings: collectIrcSecurityWarnings
	},
	outbound: {
		base: ircOutboundBaseAdapter,
		attachedResults: {
			channel: "irc",
			sendText: async ({ cfg, to, text, accountId, replyToId }) => {
				const { sendMessageIrc } = await loadIrcChannelRuntime();
				return await sendMessageIrc(to, text, {
					cfg,
					accountId: accountId ?? void 0,
					replyTo: replyToId ?? void 0
				});
			},
			sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => {
				const { sendMessageIrc } = await loadIrcChannelRuntime();
				return await sendMessageIrc(to, mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text, {
					cfg,
					accountId: accountId ?? void 0,
					replyTo: replyToId ?? void 0
				});
			}
		}
	}
});
//#endregion
export { ircSetupWizard as n, ircSetupAdapter as r, ircPlugin as t };
