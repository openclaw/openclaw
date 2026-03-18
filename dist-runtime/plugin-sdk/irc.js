import { g as DEFAULT_ACCOUNT_ID, s as init_session_key, v as normalizeAccountId } from "./session-key-BwICpQs5.js";
import { Bt as warnMissingProviderGroupPolicyFallbackOnce, G as init_registry, It as resolveAllowlistProviderRuntimeGroupPolicy, Lt as resolveDefaultGroupPolicy, Nt as GROUP_POLICY_BLOCKED_LABEL, Pt as init_runtime_group_policy, Un as createAccountListHelpers, W as getChatChannelMeta, Wn as init_account_helpers, gn as normalizeResolvedSecretInputString, pn as init_types_secrets } from "./runtime-CDMAx_h4.js";
import { Eo as issuePairingChallenge, Gt as readStoreAllowFromForDmPolicy, Oo as createScopedPairingAccess, Ro as logInboundDrop, Xt as resolveEffectiveAllowFromLists, cn as resolveControlCommandGate, f as setSetupChannelEnabled, l as resolveSetupAccountId, m as setTopLevelChannelDmPolicyWithAllowFrom, p as setTopLevelChannelAllowFrom, t as addWildcardAllowFrom } from "./setup-wizard-helpers-BPw-E_P4.js";
import "./provider-env-vars-CWXfFyDU.js";
import "./logger-D1gzveLR.js";
import "./tmp-openclaw-dir-DgWJsVV_.js";
import "./subsystem-0lZt3jI5.js";
import "./utils-DknlDzAi.js";
import "./fetch-CysqlwhH.js";
import "./retry-CyJj_oar.js";
import { t as emptyPluginConfigSchema } from "./config-schema-X8cahxVt.js";
import { t as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-0CmwkA_V.js";
import "./paths-BDsrA18Z.js";
import { r as runPassiveAccountLifecycle, t as createAccountStatusSink } from "./channel-lifecycle-DEuCqmjW.js";
import { A as ToolPolicySchema, H as buildBaseAccountStatusSnapshot, U as buildBaseChannelStatusSummary } from "./signal-FT4PyBH3.js";
import { T as MarkdownConfigSchema, a as formatPairingApproveHint, g as DmPolicySchema, h as DmConfigSchema, j as ReplyRuntimeConfigSchemaShape, n as deleteAccountFromConfigSection, o as parseOptionalDelimitedEntries, p as BlockStreamingCoalesceSchema, q as requireOpenAllowFrom, r as setAccountEnabledInConfigSection, u as buildChannelConfigSchema, y as GroupPolicySchema } from "./config-helpers-BQX8LEv1.js";
import "./fetch-CKhAJuFk.js";
import "./exec-DEBhRlDf.js";
import "./agent-scope-CgozsAuQ.js";
import { a as patchScopedAccountConfig, t as applyAccountNameToChannelSection } from "./setup-helpers-vyA9zMMX.js";
import { n as createReplyPrefixOptions, u as formatDocsLink } from "./reply-prefix-Dcd4HlHm.js";
import "./logger-CXkOEiRn.js";
import "./fetch-guard-DryYzke6.js";
import "./resolve-route-CPxNiUBg.js";
import "./pairing-token-ukgXF6GK.js";
import "./query-expansion-t4qzEE5Z.js";
import "./redact-DkskT6Xp.js";
import { t as PAIRING_APPROVED_MESSAGE } from "./channel-plugin-common-Cs4waNSc.js";
import { i as tryReadSecretFileSync } from "./secret-file-CCHXecQt.js";
import { a as resolveOutboundMediaUrls, n as formatTextWithAttachmentLinks, t as createNormalizedOutboundDeliverer } from "./reply-payload-4ACAf9Rp.js";
import { n as dispatchInboundReplyWithBase } from "./inbound-reply-dispatch-BiJFwXGs.js";
import { t as createLoggerBackedRuntime } from "./runtime-YgND8u9Q.js";
import "./core.js";
//#region extensions/irc/src/accounts.ts
init_registry();
init_runtime_group_policy();
init_types_secrets();
init_account_helpers();
init_session_key();
const TRUTHY_ENV = new Set([
	"true",
	"1",
	"yes",
	"on"
]);
function parseTruthy(value) {
	if (!value) return false;
	return TRUTHY_ENV.has(value.trim().toLowerCase());
}
function parseIntEnv(value) {
	if (!value?.trim()) return;
	const parsed = Number.parseInt(value.trim(), 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return;
	return parsed;
}
const { listAccountIds: listIrcAccountIds, resolveDefaultAccountId: resolveDefaultIrcAccountId } = createAccountListHelpers("irc", { normalizeAccountId });
function resolveAccountConfig(cfg, accountId) {
	const accounts = cfg.channels?.irc?.accounts;
	if (!accounts || typeof accounts !== "object") return;
	const direct = accounts[accountId];
	if (direct) return direct;
	const normalized = normalizeAccountId(accountId);
	const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
	return matchKey ? accounts[matchKey] : void 0;
}
function mergeIrcAccountConfig(cfg, accountId) {
	const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, ...base } = cfg.channels?.irc ?? {};
	const account = resolveAccountConfig(cfg, accountId) ?? {};
	const merged = {
		...base,
		...account
	};
	if (base.nickserv || account.nickserv) merged.nickserv = {
		...base.nickserv,
		...account.nickserv
	};
	return merged;
}
function resolvePassword(accountId, merged) {
	if (accountId === "default") {
		const envPassword = process.env.IRC_PASSWORD?.trim();
		if (envPassword) return {
			password: envPassword,
			source: "env"
		};
	}
	if (merged.passwordFile?.trim()) {
		const filePassword = tryReadSecretFileSync(merged.passwordFile, "IRC password file", { rejectSymlink: true });
		if (filePassword) return {
			password: filePassword,
			source: "passwordFile"
		};
	}
	const configPassword = normalizeResolvedSecretInputString({
		value: merged.password,
		path: `channels.irc.accounts.${accountId}.password`
	});
	if (configPassword) return {
		password: configPassword,
		source: "config"
	};
	return {
		password: "",
		source: "none"
	};
}
function resolveNickServConfig(accountId, nickserv) {
	const base = nickserv ?? {};
	const envPassword = accountId === "default" ? process.env.IRC_NICKSERV_PASSWORD?.trim() : void 0;
	const envRegisterEmail = accountId === "default" ? process.env.IRC_NICKSERV_REGISTER_EMAIL?.trim() : void 0;
	const passwordFile = base.passwordFile?.trim();
	let resolvedPassword = normalizeResolvedSecretInputString({
		value: base.password,
		path: `channels.irc.accounts.${accountId}.nickserv.password`
	}) || envPassword || "";
	if (!resolvedPassword && passwordFile) resolvedPassword = tryReadSecretFileSync(passwordFile, "IRC NickServ password file", { rejectSymlink: true }) ?? "";
	return {
		...base,
		service: base.service?.trim() || void 0,
		passwordFile: passwordFile || void 0,
		password: resolvedPassword || void 0,
		registerEmail: base.registerEmail?.trim() || envRegisterEmail || void 0
	};
}
function resolveIrcAccount(params) {
	const hasExplicitAccountId = Boolean(params.accountId?.trim());
	const baseEnabled = params.cfg.channels?.irc?.enabled !== false;
	const resolve = (accountId) => {
		const merged = mergeIrcAccountConfig(params.cfg, accountId);
		const accountEnabled = merged.enabled !== false;
		const enabled = baseEnabled && accountEnabled;
		const tls = typeof merged.tls === "boolean" ? merged.tls : accountId === "default" && process.env.IRC_TLS ? parseTruthy(process.env.IRC_TLS) : true;
		const envPort = accountId === "default" ? parseIntEnv(process.env.IRC_PORT) : void 0;
		const port = merged.port ?? envPort ?? (tls ? 6697 : 6667);
		const envChannels = accountId === "default" ? parseOptionalDelimitedEntries(process.env.IRC_CHANNELS) : void 0;
		const host = (merged.host?.trim() || (accountId === "default" ? process.env.IRC_HOST?.trim() : "") || "").trim();
		const nick = (merged.nick?.trim() || (accountId === "default" ? process.env.IRC_NICK?.trim() : "") || "").trim();
		const username = (merged.username?.trim() || (accountId === "default" ? process.env.IRC_USERNAME?.trim() : "") || nick || "openclaw").trim();
		const realname = (merged.realname?.trim() || (accountId === "default" ? process.env.IRC_REALNAME?.trim() : "") || "OpenClaw").trim();
		const passwordResolution = resolvePassword(accountId, merged);
		const nickserv = resolveNickServConfig(accountId, merged.nickserv);
		const config = {
			...merged,
			channels: merged.channels ?? envChannels,
			tls,
			port,
			host,
			nick,
			username,
			realname,
			nickserv
		};
		return {
			accountId,
			enabled,
			name: merged.name?.trim() || void 0,
			configured: Boolean(host && nick),
			host,
			port,
			tls,
			nick,
			username,
			realname,
			password: passwordResolution.password,
			passwordSource: passwordResolution.source,
			config
		};
	};
	const primary = resolve(normalizeAccountId(params.accountId));
	if (hasExplicitAccountId) return primary;
	if (primary.configured) return primary;
	const fallbackId = resolveDefaultIrcAccountId(params.cfg);
	if (fallbackId === primary.accountId) return primary;
	const fallback = resolve(fallbackId);
	if (!fallback.configured) return primary;
	return fallback;
}
//#endregion
//#region extensions/irc/src/control-chars.ts
function isIrcControlChar(charCode) {
	return charCode <= 31 || charCode === 127;
}
function hasIrcControlChars(value) {
	for (const char of value) if (isIrcControlChar(char.charCodeAt(0))) return true;
	return false;
}
//#endregion
//#region extensions/irc/src/normalize.ts
const IRC_TARGET_PATTERN = /^[^\s:]+$/u;
function isChannelTarget(target) {
	return target.startsWith("#") || target.startsWith("&");
}
function normalizeIrcMessagingTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	let target = trimmed;
	if (target.toLowerCase().startsWith("irc:")) target = target.slice(4).trim();
	if (target.toLowerCase().startsWith("channel:")) {
		target = target.slice(8).trim();
		if (!target.startsWith("#") && !target.startsWith("&")) target = `#${target}`;
	}
	if (target.toLowerCase().startsWith("user:")) target = target.slice(5).trim();
	if (!target || !looksLikeIrcTargetId(target)) return;
	return target;
}
function looksLikeIrcTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	if (hasIrcControlChars(trimmed)) return false;
	return IRC_TARGET_PATTERN.test(trimmed);
}
function normalizeIrcAllowEntry(raw) {
	let value = raw.trim().toLowerCase();
	if (!value) return "";
	if (value.startsWith("irc:")) value = value.slice(4);
	if (value.startsWith("user:")) value = value.slice(5);
	return value.trim();
}
//#endregion
//#region extensions/irc/src/setup-core.ts
const channel$1 = "irc";
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
	return setTopLevelChannelDmPolicyWithAllowFrom({
		cfg,
		channel: channel$1,
		dmPolicy
	});
}
function setIrcAllowFrom(cfg, allowFrom) {
	return setTopLevelChannelAllowFrom({
		cfg,
		channel: channel$1,
		allowFrom
	});
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
	validateInput: ({ input }) => {
		const setupInput = input;
		if (!setupInput.host?.trim()) return "IRC requires host.";
		if (!setupInput.nick?.trim()) return "IRC requires nick.";
		return null;
	},
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const setupInput = input;
		const namedConfig = applyAccountNameToChannelSection({
			cfg,
			channelKey: channel$1,
			accountId,
			name: setupInput.name
		});
		const portInput = typeof setupInput.port === "number" ? String(setupInput.port) : String(setupInput.port ?? "");
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
init_session_key();
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
async function promptIrcAllowFrom(params) {
	const existing = params.cfg.channels?.irc?.allowFrom ?? [];
	await params.prompter.note([
		"Allowlist IRC DMs by sender.",
		"Examples:",
		"- alice",
		"- alice!ident@example.org",
		"Multiple entries: comma-separated."
	].join("\n"), "IRC allowlist");
	const raw = await params.prompter.text({
		message: "IRC allowFrom (nick or nick!user@host)",
		placeholder: "alice, bob!ident@example.org",
		initialValue: existing[0] ? String(existing[0]) : void 0,
		validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
	});
	const parsed = parseListInput(String(raw));
	const normalized = [...new Set(parsed.map((entry) => normalizeIrcAllowEntry(entry)).map((entry) => entry.trim()).filter(Boolean))];
	return setIrcAllowFrom(params.cfg, normalized);
}
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
	const service = String(await params.prompter.text({
		message: "NickServ service nick",
		initialValue: existing?.service || "NickServ",
		validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
	})).trim();
	const useEnvPassword = params.accountId === "default" && Boolean(process.env.IRC_NICKSERV_PASSWORD?.trim()) && !(existing?.password || existing?.passwordFile) ? await params.prompter.confirm({
		message: "IRC_NICKSERV_PASSWORD detected. Use env var?",
		initialValue: true
	}) : false;
	const password = useEnvPassword ? void 0 : String(await params.prompter.text({
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
	const registerEmail = register ? String(await params.prompter.text({
		message: "NickServ register email",
		initialValue: existing?.registerEmail || (params.accountId === "default" ? process.env.IRC_NICKSERV_REGISTER_EMAIL : void 0),
		validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
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
		accountId: resolveSetupAccountId({
			accountId,
			defaultAccountId: resolveDefaultIrcAccountId(cfg)
		})
	})
};
const ircSetupWizard = {
	channel,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs host + nick",
		configuredHint: "configured",
		unconfiguredHint: "needs host + nick",
		configuredScore: 1,
		unconfiguredScore: 0,
		resolveConfigured: ({ cfg }) => listIrcAccountIds(cfg).some((accountId) => resolveIrcAccount({
			cfg,
			accountId
		}).configured),
		resolveStatusLines: ({ configured }) => [`IRC: ${configured ? "configured" : "needs host + nick"}`]
	},
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
		const envHost = isDefaultAccount ? process.env.IRC_HOST?.trim() : "";
		const envNick = isDefaultAccount ? process.env.IRC_NICK?.trim() : "";
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
			validate: ({ value }) => String(value ?? "").trim() ? void 0 : "Required",
			normalizeValue: ({ value }) => String(value).trim(),
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
				const tls = credentialValues[TLS_FLAG] === "0" ? false : true;
				const defaultPort = resolved.config.port ?? (tls ? 6697 : 6667);
				return String(defaultPort);
			},
			validate: ({ value }) => {
				const parsed = Number.parseInt(String(value ?? "").trim(), 10);
				return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535 ? void 0 : "Use a port between 1 and 65535";
			},
			normalizeValue: ({ value }) => String(parsePort(String(value), 6697)),
			applySet: async ({ cfg, accountId, value }) => updateIrcAccountConfig(cfg, accountId, {
				enabled: true,
				port: parsePort(String(value), 6697)
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
			validate: ({ value }) => String(value ?? "").trim() ? void 0 : "Required",
			normalizeValue: ({ value }) => String(value).trim(),
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
			validate: ({ value }) => String(value ?? "").trim() ? void 0 : "Required",
			normalizeValue: ({ value }) => String(value).trim(),
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
			validate: ({ value }) => String(value ?? "").trim() ? void 0 : "Required",
			normalizeValue: ({ value }) => String(value).trim(),
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
			normalizeValue: ({ value }) => parseListInput(String(value)).map((entry) => normalizeGroupEntry(entry)).filter((entry) => Boolean(entry && entry !== "*")).filter((entry) => isChannelTarget(entry)).join(", "),
			applySet: async ({ cfg, accountId, value }) => {
				const channels = parseListInput(String(value)).map((entry) => normalizeGroupEntry(entry)).filter((entry) => Boolean(entry && entry !== "*")).filter((entry) => isChannelTarget(entry));
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
	allowFrom: {
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
		resolveEntries: async ({ entries }) => entries.map((entry) => {
			const normalized = normalizeIrcAllowEntry(entry);
			return {
				input: entry,
				resolved: Boolean(normalized),
				id: normalized || null
			};
		}),
		apply: async ({ cfg, allowFrom }) => setIrcAllowFrom(cfg, allowFrom)
	},
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
//#region src/plugin-sdk/irc.ts
init_session_key();
//#endregion
export { BlockStreamingCoalesceSchema, DEFAULT_ACCOUNT_ID, DmConfigSchema, DmPolicySchema, GROUP_POLICY_BLOCKED_LABEL, GroupPolicySchema, MarkdownConfigSchema, PAIRING_APPROVED_MESSAGE, ReplyRuntimeConfigSchemaShape, ToolPolicySchema, addWildcardAllowFrom, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, createAccountListHelpers, createAccountStatusSink, createLoggerBackedRuntime, createNormalizedOutboundDeliverer, createReplyPrefixOptions, createScopedPairingAccess, deleteAccountFromConfigSection, dispatchInboundReplyWithBase, emptyPluginConfigSchema, formatDocsLink, formatPairingApproveHint, formatTextWithAttachmentLinks, getChatChannelMeta, ircSetupAdapter, ircSetupWizard, isDangerousNameMatchingEnabled, issuePairingChallenge, listIrcAccountIds, logInboundDrop, normalizeResolvedSecretInputString, parseOptionalDelimitedEntries, patchScopedAccountConfig, readStoreAllowFromForDmPolicy, requireOpenAllowFrom, resolveAllowlistProviderRuntimeGroupPolicy, resolveControlCommandGate, resolveDefaultGroupPolicy, resolveDefaultIrcAccountId, resolveEffectiveAllowFromLists, resolveIrcAccount, resolveOutboundMediaUrls, runPassiveAccountLifecycle, setAccountEnabledInConfigSection, setTopLevelChannelAllowFrom, setTopLevelChannelDmPolicyWithAllowFrom, warnMissingProviderGroupPolicyFallbackOnce };
