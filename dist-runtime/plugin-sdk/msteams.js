import { o as __toESM } from "./chunk-DORXReHP.js";
import { g as DEFAULT_ACCOUNT_ID, s as init_session_key } from "./session-key-BwICpQs5.js";
import { At as evaluateSenderGroupAccessForPolicy, Ht as buildChannelKeyCandidates, It as resolveAllowlistProviderRuntimeGroupPolicy, Kt as resolveChannelEntryMatchWithFallback, Lt as resolveDefaultGroupPolicy, Mt as resolveSenderScopedGroupPolicy, Pt as init_runtime_group_policy, Wt as normalizeChannelSlug, _n as normalizeSecretInputString, fn as hasConfiguredSecretInput, gn as normalizeResolvedSecretInputString, jt as init_group_access, pn as init_types_secrets, qt as resolveNestedAllowlistDecision } from "./runtime-CDMAx_h4.js";
import { $t as resolveMentionGating, Ao as writeJsonFileAtomically, Bo as DEFAULT_GROUP_HISTORY_LIMIT, Gt as readStoreAllowFromForDmPolicy, Io as createTypingCallbacks, Jf as isSilentReplyText, Kf as SILENT_REPLY_TOKEN, Ko as recordPendingHistoryEntryIfEnabled, Mu as loadWebMedia, Oo as createScopedPairingAccess, Qt as resolveInboundSessionEnvelopeContext, Ro as logInboundDrop, Uo as clearHistoryEntriesIfEnabled, Vd as extractOriginalFilename, Vo as buildPendingHistoryContextFromMap, Xt as resolveEffectiveAllowFromLists, Yt as resolveDmGroupAccessWithLists, cn as resolveControlCommandGate, g as splitSetupEntries, h as setTopLevelChannelGroupPolicy, ko as readJsonFileWithFallback, ln as resolveDualTextControlCommandGate, m as setTopLevelChannelDmPolicyWithAllowFrom, md as resolveToolsBySender, p as setTopLevelChannelAllowFrom, r as mergeAllowFromEntries, t as addWildcardAllowFrom, vp as DEFAULT_WEBHOOK_MAX_BODY_BYTES, zo as logTypingFailure } from "./setup-wizard-helpers-BPw-E_P4.js";
import "./provider-env-vars-CWXfFyDU.js";
import "./logger-D1gzveLR.js";
import "./tmp-openclaw-dir-DgWJsVV_.js";
import "./subsystem-0lZt3jI5.js";
import { b as sleep, c as init_utils } from "./utils-DknlDzAi.js";
import "./fetch-CysqlwhH.js";
import "./retry-CyJj_oar.js";
import { t as emptyPluginConfigSchema } from "./config-schema-X8cahxVt.js";
import { t as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-0CmwkA_V.js";
import { A as withFileLock } from "./paths-BDsrA18Z.js";
import { i as normalizeHostnameSuffixAllowlist, n as buildHostnameAllowlistPolicyFromSuffixAllowlist, r as isHttpsUrlAllowedByHostnameSuffixAllowlist, u as mapAllowlistResolutionInputs } from "./plugin-sdk-DQMac3M2.js";
import "./webhook-targets-DiwYmBno.js";
import { n as keepHttpServerTaskAlive } from "./channel-lifecycle-DEuCqmjW.js";
import { G as buildProbeChannelStatusSummary, K as buildRuntimeAccountStatusSnapshot, U as buildBaseChannelStatusSummary, Y as createDefaultChannelRuntimeState, l as MSTeamsConfigSchema, t as resolveChannelMediaMaxBytes } from "./signal-FT4PyBH3.js";
import { u as buildChannelConfigSchema } from "./config-helpers-BQX8LEv1.js";
import "./fetch-CKhAJuFk.js";
import "./exec-DEBhRlDf.js";
import { j as normalizeStringEntries } from "./agent-scope-CgozsAuQ.js";
import { n as createReplyPrefixOptions, u as formatDocsLink } from "./reply-prefix-Dcd4HlHm.js";
import "./logger-CXkOEiRn.js";
import { s as isPrivateIpAddress, t as fetchWithSsrFGuard } from "./fetch-guard-DryYzke6.js";
import "./resolve-route-CPxNiUBg.js";
import "./pairing-token-ukgXF6GK.js";
import { B as extensionForMime, V as getFileExtension, z as detectMime } from "./query-expansion-t4qzEE5Z.js";
import "./redact-DkskT6Xp.js";
import { a as resolveAllowlistMatchSimple, n as formatAllowlistMatchMeta } from "./allowlist-match-CTtlT8WI.js";
import { t as PAIRING_APPROVED_MESSAGE } from "./channel-plugin-common-Cs4waNSc.js";
import "./secret-file-CCHXecQt.js";
import "./line-Bn2R-d2g.js";
import "./text-chunking-BNRYh70S.js";
import { r as dispatchReplyFromConfigWithSettledDispatcher } from "./inbound-reply-dispatch-BiJFwXGs.js";
import { t as loadOutboundMediaFromUrl } from "./outbound-media-CjhBqVNq.js";
import { t as buildMediaPayload } from "./media-payload-DXZ_hive.js";
import "./run-command-Bf9g_LgO.js";
import "./device-pairing-Ccml08d4.js";
import { i as mergeAllowlist, o as summarizeMapping } from "./resolve-utils-D2Wj38Wj.js";
import "./bluebubbles-BG_X_k_x.js";
import "./upsert-with-lock-CJk0IjlB.js";
import "./self-hosted-provider-setup-DGjG2y6M.js";
import "./ollama-setup-dmAAlca1.js";
import "./vllm-setup-BgeFwSMY.js";
import "./compat.js";
import "node:dns/promises";
//#region extensions/msteams/src/attachments/shared.ts
init_group_access();
init_runtime_group_policy();
init_types_secrets();
init_utils();
init_session_key();
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
//#endregion
//#region extensions/msteams/src/sdk.ts
async function loadMSTeamsSdk() {
	return await import("./src-CqQtEeOB.js").then((m) => /* @__PURE__ */ __toESM(m.default, 1));
}
function buildMSTeamsAuthConfig(creds, sdk) {
	return sdk.getAuthConfigWithDefaults({
		clientId: creds.appId,
		clientSecret: creds.appPassword,
		tenantId: creds.tenantId
	});
}
async function loadMSTeamsSdkWithAuth(creds) {
	const sdk = await loadMSTeamsSdk();
	return {
		sdk,
		authConfig: buildMSTeamsAuthConfig(creds, sdk)
	};
}
//#endregion
//#region extensions/msteams/src/token-response.ts
function readAccessToken(value) {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const token = value.accessToken ?? value.token;
		return typeof token === "string" ? token : null;
	}
	return null;
}
//#endregion
//#region extensions/msteams/src/token.ts
function hasConfiguredMSTeamsCredentials(cfg) {
	return Boolean(normalizeSecretInputString(cfg?.appId) && hasConfiguredSecretInput(cfg?.appPassword) && normalizeSecretInputString(cfg?.tenantId));
}
function resolveMSTeamsCredentials(cfg) {
	const appId = normalizeSecretInputString(cfg?.appId) || normalizeSecretInputString(process.env.MSTEAMS_APP_ID);
	const appPassword = normalizeResolvedSecretInputString({
		value: cfg?.appPassword,
		path: "channels.msteams.appPassword"
	}) || normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD);
	const tenantId = normalizeSecretInputString(cfg?.tenantId) || normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID);
	if (!appId || !appPassword || !tenantId) return;
	return {
		appId,
		appPassword,
		tenantId
	};
}
//#endregion
//#region extensions/msteams/src/graph.ts
function normalizeQuery(value) {
	return value?.trim() ?? "";
}
function escapeOData(value) {
	return value.replace(/'/g, "''");
}
async function fetchGraphJson(params) {
	const res = await fetch(`${GRAPH_ROOT}${params.path}`, { headers: {
		Authorization: `Bearer ${params.token}`,
		...params.headers
	} });
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Graph ${params.path} failed (${res.status}): ${text || "unknown error"}`);
	}
	return await res.json();
}
async function resolveGraphToken(cfg) {
	const creds = resolveMSTeamsCredentials(cfg?.channels?.msteams);
	if (!creds) throw new Error("MS Teams credentials missing");
	const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
	const accessToken = readAccessToken(await new sdk.MsalTokenProvider(authConfig).getAccessToken("https://graph.microsoft.com"));
	if (!accessToken) throw new Error("MS Teams graph token unavailable");
	return accessToken;
}
async function listTeamsByName(token, query) {
	const filter = `resourceProvisioningOptions/Any(x:x eq 'Team') and startsWith(displayName,'${escapeOData(query)}')`;
	return (await fetchGraphJson({
		token,
		path: `/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName`
	})).value ?? [];
}
async function listChannelsForTeam(token, teamId) {
	return (await fetchGraphJson({
		token,
		path: `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`
	})).value ?? [];
}
//#endregion
//#region extensions/msteams/src/graph-users.ts
async function searchGraphUsers(params) {
	const query = params.query.trim();
	if (!query) return [];
	if (query.includes("@")) {
		const escaped = escapeOData(query);
		const filter = `(mail eq '${escaped}' or userPrincipalName eq '${escaped}')`;
		const path = `/users?$filter=${encodeURIComponent(filter)}&$select=id,displayName,mail,userPrincipalName`;
		return (await fetchGraphJson({
			token: params.token,
			path
		})).value ?? [];
	}
	const top = typeof params.top === "number" && params.top > 0 ? params.top : 10;
	const path = `/users?$search=${encodeURIComponent(`"displayName:${query}"`)}&$select=id,displayName,mail,userPrincipalName&$top=${top}`;
	return (await fetchGraphJson({
		token: params.token,
		path,
		headers: { ConsistencyLevel: "eventual" }
	})).value ?? [];
}
//#endregion
//#region extensions/msteams/src/resolve-allowlist.ts
function stripProviderPrefix(raw) {
	return raw.replace(/^(msteams|teams):/i, "");
}
function normalizeMSTeamsUserInput(raw) {
	return stripProviderPrefix(raw).replace(/^(user|conversation):/i, "").trim();
}
function normalizeMSTeamsTeamKey(raw) {
	return stripProviderPrefix(raw).replace(/^team:/i, "").trim() || void 0;
}
function normalizeMSTeamsChannelKey(raw) {
	return (raw?.trim().replace(/^#/, "").trim() ?? "") || void 0;
}
function parseMSTeamsTeamChannelInput(raw) {
	const trimmed = stripProviderPrefix(raw).trim();
	if (!trimmed) return {};
	const parts = trimmed.split("/");
	const team = normalizeMSTeamsTeamKey(parts[0] ?? "");
	const channel = parts.length > 1 ? normalizeMSTeamsChannelKey(parts.slice(1).join("/")) : void 0;
	return {
		...team ? { team } : {},
		...channel ? { channel } : {}
	};
}
function parseMSTeamsTeamEntry(raw) {
	const { team, channel } = parseMSTeamsTeamChannelInput(raw);
	if (!team) return null;
	return {
		teamKey: team,
		...channel ? { channelKey: channel } : {}
	};
}
async function resolveMSTeamsChannelAllowlist(params) {
	const token = await resolveGraphToken(params.cfg);
	return await mapAllowlistResolutionInputs({
		inputs: params.entries,
		mapInput: async (input) => {
			const { team, channel } = parseMSTeamsTeamChannelInput(input);
			if (!team) return {
				input,
				resolved: false
			};
			const teams = /^[0-9a-fA-F-]{16,}$/.test(team) ? [{
				id: team,
				displayName: team
			}] : await listTeamsByName(token, team);
			if (teams.length === 0) return {
				input,
				resolved: false,
				note: "team not found"
			};
			const teamMatch = teams[0];
			const graphTeamId = teamMatch.id?.trim();
			const teamName = teamMatch.displayName?.trim() || team;
			if (!graphTeamId) return {
				input,
				resolved: false,
				note: "team id missing"
			};
			let teamChannels = [];
			try {
				teamChannels = await listChannelsForTeam(token, graphTeamId);
			} catch {}
			const teamId = teamChannels.find((ch) => ch.displayName?.toLowerCase() === "general")?.id?.trim() || graphTeamId;
			if (!channel) return {
				input,
				resolved: true,
				teamId,
				teamName,
				note: teams.length > 1 ? "multiple teams; chose first" : void 0
			};
			const channelMatch = teamChannels.find((item) => item.id === channel) ?? teamChannels.find((item) => item.displayName?.toLowerCase() === channel.toLowerCase()) ?? teamChannels.find((item) => item.displayName?.toLowerCase().includes(channel.toLowerCase() ?? ""));
			if (!channelMatch?.id) return {
				input,
				resolved: false,
				note: "channel not found"
			};
			return {
				input,
				resolved: true,
				teamId,
				teamName,
				channelId: channelMatch.id,
				channelName: channelMatch.displayName ?? channel,
				note: teamChannels.length > 1 ? "multiple channels; chose first" : void 0
			};
		}
	});
}
async function resolveMSTeamsUserAllowlist(params) {
	const token = await resolveGraphToken(params.cfg);
	return await mapAllowlistResolutionInputs({
		inputs: params.entries,
		mapInput: async (input) => {
			const query = normalizeQuery(normalizeMSTeamsUserInput(input));
			if (!query) return {
				input,
				resolved: false
			};
			if (/^[0-9a-fA-F-]{16,}$/.test(query)) return {
				input,
				resolved: true,
				id: query
			};
			const users = await searchGraphUsers({
				token,
				query,
				top: 10
			});
			const match = users[0];
			if (!match?.id) return {
				input,
				resolved: false
			};
			return {
				input,
				resolved: true,
				id: match.id,
				name: match.displayName ?? void 0,
				note: users.length > 1 ? "multiple matches; chose first" : void 0
			};
		}
	});
}
//#endregion
//#region extensions/msteams/src/setup-core.ts
const msteamsSetupAdapter = {
	resolveAccountId: () => DEFAULT_ACCOUNT_ID,
	applyAccountConfig: ({ cfg }) => ({
		...cfg,
		channels: {
			...cfg.channels,
			msteams: {
				...cfg.channels?.msteams,
				enabled: true
			}
		}
	})
};
//#endregion
//#region extensions/msteams/src/setup-surface.ts
init_session_key();
const channel = "msteams";
function setMSTeamsDmPolicy(cfg, dmPolicy) {
	return setTopLevelChannelDmPolicyWithAllowFrom({
		cfg,
		channel,
		dmPolicy
	});
}
function setMSTeamsAllowFrom(cfg, allowFrom) {
	return setTopLevelChannelAllowFrom({
		cfg,
		channel,
		allowFrom
	});
}
function looksLikeGuid(value) {
	return /^[0-9a-fA-F-]{16,}$/.test(value);
}
async function promptMSTeamsCredentials(prompter) {
	return {
		appId: String(await prompter.text({
			message: "Enter MS Teams App ID",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim(),
		appPassword: String(await prompter.text({
			message: "Enter MS Teams App Password",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim(),
		tenantId: String(await prompter.text({
			message: "Enter MS Teams Tenant ID",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim()
	};
}
async function promptMSTeamsAllowFrom(params) {
	const existing = params.cfg.channels?.msteams?.allowFrom ?? [];
	await params.prompter.note([
		"Allowlist MS Teams DMs by display name, UPN/email, or user id.",
		"We resolve names to user IDs via Microsoft Graph when credentials allow.",
		"Examples:",
		"- alex@example.com",
		"- Alex Johnson",
		"- 00000000-0000-0000-0000-000000000000"
	].join("\n"), "MS Teams allowlist");
	while (true) {
		const entry = await params.prompter.text({
			message: "MS Teams allowFrom (usernames or ids)",
			placeholder: "alex@example.com, Alex Johnson",
			initialValue: existing[0] ? String(existing[0]) : void 0,
			validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
		});
		const parts = splitSetupEntries(String(entry));
		if (parts.length === 0) {
			await params.prompter.note("Enter at least one user.", "MS Teams allowlist");
			continue;
		}
		const resolved = await resolveMSTeamsUserAllowlist({
			cfg: params.cfg,
			entries: parts
		}).catch(() => null);
		if (!resolved) {
			const ids = parts.filter((part) => looksLikeGuid(part));
			if (ids.length !== parts.length) {
				await params.prompter.note("Graph lookup unavailable. Use user IDs only.", "MS Teams allowlist");
				continue;
			}
			const unique = mergeAllowFromEntries(existing, ids);
			return setMSTeamsAllowFrom(params.cfg, unique);
		}
		const unresolved = resolved.filter((item) => !item.resolved || !item.id);
		if (unresolved.length > 0) {
			await params.prompter.note(`Could not resolve: ${unresolved.map((item) => item.input).join(", ")}`, "MS Teams allowlist");
			continue;
		}
		const unique = mergeAllowFromEntries(existing, resolved.map((item) => item.id));
		return setMSTeamsAllowFrom(params.cfg, unique);
	}
}
async function noteMSTeamsCredentialHelp(prompter) {
	await prompter.note([
		"1) Azure Bot registration -> get App ID + Tenant ID",
		"2) Add a client secret (App Password)",
		"3) Set webhook URL + messaging endpoint",
		"Tip: you can also set MSTEAMS_APP_ID / MSTEAMS_APP_PASSWORD / MSTEAMS_TENANT_ID.",
		`Docs: ${formatDocsLink("/channels/msteams", "msteams")}`
	].join("\n"), "MS Teams credentials");
}
function setMSTeamsGroupPolicy(cfg, groupPolicy) {
	return setTopLevelChannelGroupPolicy({
		cfg,
		channel,
		groupPolicy,
		enabled: true
	});
}
function setMSTeamsTeamsAllowlist(cfg, entries) {
	const teams = { ...cfg.channels?.msteams?.teams ?? {} };
	for (const entry of entries) {
		const teamKey = entry.teamKey;
		if (!teamKey) continue;
		const existing = teams[teamKey] ?? {};
		if (entry.channelKey) {
			const channels = { ...existing.channels };
			channels[entry.channelKey] = channels[entry.channelKey] ?? {};
			teams[teamKey] = {
				...existing,
				channels
			};
		} else teams[teamKey] = existing;
	}
	return {
		...cfg,
		channels: {
			...cfg.channels,
			msteams: {
				...cfg.channels?.msteams,
				enabled: true,
				teams
			}
		}
	};
}
function listMSTeamsGroupEntries(cfg) {
	return Object.entries(cfg.channels?.msteams?.teams ?? {}).flatMap(([teamKey, value]) => {
		const channels = value?.channels ?? {};
		const channelKeys = Object.keys(channels);
		if (channelKeys.length === 0) return [teamKey];
		return channelKeys.map((channelKey) => `${teamKey}/${channelKey}`);
	});
}
async function resolveMSTeamsGroupAllowlist(params) {
	let resolvedEntries = params.entries.map((entry) => parseMSTeamsTeamEntry(entry)).filter(Boolean);
	if (params.entries.length === 0 || !resolveMSTeamsCredentials(params.cfg.channels?.msteams)) return resolvedEntries;
	try {
		const lookups = await resolveMSTeamsChannelAllowlist({
			cfg: params.cfg,
			entries: params.entries
		});
		const resolvedChannels = lookups.filter((entry) => entry.resolved && entry.teamId && entry.channelId);
		const resolvedTeams = lookups.filter((entry) => entry.resolved && entry.teamId && !entry.channelId);
		const unresolved = lookups.filter((entry) => !entry.resolved).map((entry) => entry.input);
		resolvedEntries = [
			...resolvedChannels.map((entry) => ({
				teamKey: entry.teamId,
				channelKey: entry.channelId
			})),
			...resolvedTeams.map((entry) => ({ teamKey: entry.teamId })),
			...unresolved.map((entry) => parseMSTeamsTeamEntry(entry)).filter(Boolean)
		];
		const summary = [];
		if (resolvedChannels.length > 0) summary.push(`Resolved channels: ${resolvedChannels.map((entry) => entry.channelId).filter(Boolean).join(", ")}`);
		if (resolvedTeams.length > 0) summary.push(`Resolved teams: ${resolvedTeams.map((entry) => entry.teamId).filter(Boolean).join(", ")}`);
		if (unresolved.length > 0) summary.push(`Unresolved (kept as typed): ${unresolved.join(", ")}`);
		if (summary.length > 0) await params.prompter.note(summary.join("\n"), "MS Teams channels");
		return resolvedEntries;
	} catch (err) {
		await params.prompter.note(`Channel lookup failed; keeping entries as typed. ${String(err)}`, "MS Teams channels");
		return resolvedEntries;
	}
}
const msteamsSetupWizard = {
	channel,
	resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
	resolveShouldPromptAccountIds: () => false,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs app credentials",
		configuredHint: "configured",
		unconfiguredHint: "needs app creds",
		configuredScore: 2,
		unconfiguredScore: 0,
		resolveConfigured: ({ cfg }) => {
			return Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)) || hasConfiguredMSTeamsCredentials(cfg.channels?.msteams);
		},
		resolveStatusLines: ({ cfg }) => {
			return [`MS Teams: ${Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)) || hasConfiguredMSTeamsCredentials(cfg.channels?.msteams) ? "configured" : "needs app credentials"}`];
		}
	},
	credentials: [],
	finalize: async ({ cfg, prompter }) => {
		const resolved = resolveMSTeamsCredentials(cfg.channels?.msteams);
		const hasConfigCreds = hasConfiguredMSTeamsCredentials(cfg.channels?.msteams);
		const canUseEnv = Boolean(!hasConfigCreds && normalizeSecretInputString(process.env.MSTEAMS_APP_ID) && normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD) && normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID));
		let next = cfg;
		let appId = null;
		let appPassword = null;
		let tenantId = null;
		if (!resolved && !hasConfigCreds) await noteMSTeamsCredentialHelp(prompter);
		if (canUseEnv) if (await prompter.confirm({
			message: "MSTEAMS_APP_ID + MSTEAMS_APP_PASSWORD + MSTEAMS_TENANT_ID detected. Use env vars?",
			initialValue: true
		})) next = msteamsSetupAdapter.applyAccountConfig({
			cfg: next,
			accountId: DEFAULT_ACCOUNT_ID,
			input: {}
		});
		else ({appId, appPassword, tenantId} = await promptMSTeamsCredentials(prompter));
		else if (hasConfigCreds) {
			if (!await prompter.confirm({
				message: "MS Teams credentials already configured. Keep them?",
				initialValue: true
			})) ({appId, appPassword, tenantId} = await promptMSTeamsCredentials(prompter));
		} else ({appId, appPassword, tenantId} = await promptMSTeamsCredentials(prompter));
		if (appId && appPassword && tenantId) next = {
			...next,
			channels: {
				...next.channels,
				msteams: {
					...next.channels?.msteams,
					enabled: true,
					appId,
					appPassword,
					tenantId
				}
			}
		};
		return {
			cfg: next,
			accountId: DEFAULT_ACCOUNT_ID
		};
	},
	dmPolicy: {
		label: "MS Teams",
		channel,
		policyKey: "channels.msteams.dmPolicy",
		allowFromKey: "channels.msteams.allowFrom",
		getCurrent: (cfg) => cfg.channels?.msteams?.dmPolicy ?? "pairing",
		setPolicy: (cfg, policy) => setMSTeamsDmPolicy(cfg, policy),
		promptAllowFrom: promptMSTeamsAllowFrom
	},
	groupAccess: {
		label: "MS Teams channels",
		placeholder: "Team Name/Channel Name, teamId/conversationId",
		currentPolicy: ({ cfg }) => cfg.channels?.msteams?.groupPolicy ?? "allowlist",
		currentEntries: ({ cfg }) => listMSTeamsGroupEntries(cfg),
		updatePrompt: ({ cfg }) => Boolean(cfg.channels?.msteams?.teams),
		setPolicy: ({ cfg, policy }) => setMSTeamsGroupPolicy(cfg, policy),
		resolveAllowlist: async ({ cfg, entries, prompter }) => await resolveMSTeamsGroupAllowlist({
			cfg,
			entries,
			prompter
		}),
		applyAllowlist: ({ cfg, resolved }) => setMSTeamsTeamsAllowlist(cfg, resolved)
	},
	disable: (cfg) => ({
		...cfg,
		channels: {
			...cfg.channels,
			msteams: {
				...cfg.channels?.msteams,
				enabled: false
			}
		}
	})
};
//#endregion
//#region src/plugin-sdk/msteams.ts
init_session_key();
//#endregion
export { DEFAULT_ACCOUNT_ID, DEFAULT_GROUP_HISTORY_LIMIT, DEFAULT_WEBHOOK_MAX_BODY_BYTES, MSTeamsConfigSchema, PAIRING_APPROVED_MESSAGE, SILENT_REPLY_TOKEN, addWildcardAllowFrom, buildBaseChannelStatusSummary, buildChannelConfigSchema, buildChannelKeyCandidates, buildHostnameAllowlistPolicyFromSuffixAllowlist, buildMediaPayload, buildPendingHistoryContextFromMap, buildProbeChannelStatusSummary, buildRuntimeAccountStatusSnapshot, clearHistoryEntriesIfEnabled, createDefaultChannelRuntimeState, createReplyPrefixOptions, createScopedPairingAccess, createTypingCallbacks, detectMime, dispatchReplyFromConfigWithSettledDispatcher, emptyPluginConfigSchema, evaluateSenderGroupAccessForPolicy, extensionForMime, extractOriginalFilename, fetchWithSsrFGuard, formatAllowlistMatchMeta, formatDocsLink, getFileExtension, hasConfiguredSecretInput, isDangerousNameMatchingEnabled, isHttpsUrlAllowedByHostnameSuffixAllowlist, isPrivateIpAddress, isSilentReplyText, keepHttpServerTaskAlive, loadOutboundMediaFromUrl, loadWebMedia, logInboundDrop, logTypingFailure, mergeAllowFromEntries, mergeAllowlist, msteamsSetupAdapter, msteamsSetupWizard, normalizeChannelSlug, normalizeHostnameSuffixAllowlist, normalizeResolvedSecretInputString, normalizeSecretInputString, normalizeStringEntries, readJsonFileWithFallback, readStoreAllowFromForDmPolicy, recordPendingHistoryEntryIfEnabled, resolveAllowlistMatchSimple, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelEntryMatchWithFallback, resolveChannelMediaMaxBytes, resolveControlCommandGate, resolveDefaultGroupPolicy, resolveDmGroupAccessWithLists, resolveDualTextControlCommandGate, resolveEffectiveAllowFromLists, resolveInboundSessionEnvelopeContext, resolveMentionGating, resolveNestedAllowlistDecision, resolveSenderScopedGroupPolicy, resolveToolsBySender, setTopLevelChannelAllowFrom, setTopLevelChannelDmPolicyWithAllowFrom, setTopLevelChannelGroupPolicy, sleep, splitSetupEntries, summarizeMapping, withFileLock, writeJsonFileAtomically };
