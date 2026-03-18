import { o as __toESM } from "./chunk-DORXReHP.js";
import { d as init_utils } from "./utils-BiUV1eIQ.js";
import { t as formatDocsLink } from "./links-DPi3kBux.js";
import { __ as splitSetupEntries, g_ as setTopLevelChannelGroupPolicy, h_ as setTopLevelChannelDmPolicyWithAllowFrom, m_ as setTopLevelChannelAllowFrom, n_ as mergeAllowFromEntries, tt as createPluginRuntimeStore } from "./auth-profiles-DAOR1fRn.js";
import { et as isPrivateIpAddress } from "./plugins-allowlist-E4LSkJ7R.js";
import { Xt as init_runtime_group_policy, qt as init_group_access } from "./registry-ep1yQ6WN.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-DSKLJ_RM.js";
import { s as init_session_key } from "./session-key-B-Mu-04L.js";
import { a as hasConfiguredSecretInput, l as normalizeResolvedSecretInputString, o as init_types_secrets, u as normalizeSecretInputString } from "./types.secrets-Cu0Lz6pi.js";
import { T as mapAllowlistResolutionInputs, a as isHttpsUrlAllowedByHostnameSuffixAllowlist, i as buildHostnameAllowlistPolicyFromSuffixAllowlist, o as normalizeHostnameSuffixAllowlist } from "./compat-aC6dpiEb.js";
import { lookup } from "node:dns/promises";
//#region extensions/msteams/src/resolve-allowlist.ts
function stripProviderPrefix(raw) {
	return raw.replace(/^(msteams|teams):/i, "");
}
function normalizeMSTeamsMessagingTarget(raw) {
	let trimmed = raw.trim();
	if (!trimmed) return;
	trimmed = stripProviderPrefix(trimmed).trim();
	if (/^conversation:/i.test(trimmed)) {
		const id = trimmed.slice(13).trim();
		return id ? `conversation:${id}` : void 0;
	}
	if (/^user:/i.test(trimmed)) {
		const id = trimmed.slice(5).trim();
		return id ? `user:${id}` : void 0;
	}
	return trimmed || void 0;
}
function normalizeMSTeamsUserInput(raw) {
	return stripProviderPrefix(raw).replace(/^(user|conversation):/i, "").trim();
}
function parseMSTeamsConversationId(raw) {
	const trimmed = stripProviderPrefix(raw).trim();
	if (!/^conversation:/i.test(trimmed)) return null;
	return trimmed.slice(13).trim();
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
init_session_key();
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
init_runtime_group_policy();
init_types_secrets();
init_session_key();
init_group_access();
init_utils();
//#endregion
//#region extensions/msteams/src/attachments/shared.ts
const IMAGE_EXT_RE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;
const IMG_SRC_RE = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
const ATTACHMENT_TAG_RE = /<attachment[^>]+id=["']([^"']+)["'][^>]*>/gi;
const DEFAULT_MEDIA_HOST_ALLOWLIST = [
	"graph.microsoft.com",
	"graph.microsoft.us",
	"graph.microsoft.de",
	"graph.microsoft.cn",
	"sharepoint.com",
	"sharepoint.us",
	"sharepoint.de",
	"sharepoint.cn",
	"sharepoint-df.com",
	"1drv.ms",
	"onedrive.com",
	"teams.microsoft.com",
	"teams.cdn.office.net",
	"statics.teams.cdn.office.net",
	"office.com",
	"office.net",
	"asm.skype.com",
	"ams.skype.com",
	"media.ams.skype.com",
	"trafficmanager.net",
	"blob.core.windows.net",
	"azureedge.net",
	"microsoft.com"
];
const DEFAULT_MEDIA_AUTH_HOST_ALLOWLIST = [
	"api.botframework.com",
	"botframework.com",
	"graph.microsoft.com",
	"graph.microsoft.us",
	"graph.microsoft.de",
	"graph.microsoft.cn"
];
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function resolveRequestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (typeof input === "object" && input && "url" in input && typeof input.url === "string") return input.url;
	return String(input);
}
function normalizeContentType(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function inferPlaceholder(params) {
	const mime = params.contentType?.toLowerCase() ?? "";
	const name = params.fileName?.toLowerCase() ?? "";
	const fileType = params.fileType?.toLowerCase() ?? "";
	return mime.startsWith("image/") || IMAGE_EXT_RE.test(name) || IMAGE_EXT_RE.test(`x.${fileType}`) ? "<media:image>" : "<media:document>";
}
function isLikelyImageAttachment(att) {
	const contentType = normalizeContentType(att.contentType) ?? "";
	const name = typeof att.name === "string" ? att.name : "";
	if (contentType.startsWith("image/")) return true;
	if (IMAGE_EXT_RE.test(name)) return true;
	if (contentType === "application/vnd.microsoft.teams.file.download.info" && isRecord(att.content)) {
		const fileType = typeof att.content.fileType === "string" ? att.content.fileType : "";
		if (fileType && IMAGE_EXT_RE.test(`x.${fileType}`)) return true;
		const fileName = typeof att.content.fileName === "string" ? att.content.fileName : "";
		if (fileName && IMAGE_EXT_RE.test(fileName)) return true;
	}
	return false;
}
/**
* Returns true if the attachment can be downloaded (any file type).
* Used when downloading all files, not just images.
*/
function isDownloadableAttachment(att) {
	if ((normalizeContentType(att.contentType) ?? "") === "application/vnd.microsoft.teams.file.download.info" && isRecord(att.content) && typeof att.content.downloadUrl === "string") return true;
	if (typeof att.contentUrl === "string" && att.contentUrl.trim()) return true;
	return false;
}
function isHtmlAttachment(att) {
	return (normalizeContentType(att.contentType) ?? "").startsWith("text/html");
}
function extractHtmlFromAttachment(att) {
	if (!isHtmlAttachment(att)) return;
	if (typeof att.content === "string") return att.content;
	if (!isRecord(att.content)) return;
	return typeof att.content.text === "string" ? att.content.text : typeof att.content.body === "string" ? att.content.body : typeof att.content.content === "string" ? att.content.content : void 0;
}
function decodeDataImage(src) {
	const match = /^data:(image\/[a-z0-9.+-]+)?(;base64)?,(.*)$/i.exec(src);
	if (!match) return null;
	const contentType = match[1]?.toLowerCase();
	if (!Boolean(match[2])) return null;
	const payload = match[3] ?? "";
	if (!payload) return null;
	try {
		return {
			kind: "data",
			data: Buffer.from(payload, "base64"),
			contentType,
			placeholder: "<media:image>"
		};
	} catch {
		return null;
	}
}
function fileHintFromUrl(src) {
	try {
		return new URL(src).pathname.split("/").pop() || void 0;
	} catch {
		return;
	}
}
function extractInlineImageCandidates(attachments) {
	const out = [];
	for (const att of attachments) {
		const html = extractHtmlFromAttachment(att);
		if (!html) continue;
		IMG_SRC_RE.lastIndex = 0;
		let match = IMG_SRC_RE.exec(html);
		while (match) {
			const src = match[1]?.trim();
			if (src && !src.startsWith("cid:")) if (src.startsWith("data:")) {
				const decoded = decodeDataImage(src);
				if (decoded) out.push(decoded);
			} else out.push({
				kind: "url",
				url: src,
				fileHint: fileHintFromUrl(src),
				placeholder: "<media:image>"
			});
			match = IMG_SRC_RE.exec(html);
		}
	}
	return out;
}
function safeHostForUrl(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "invalid-url";
	}
}
function resolveAllowedHosts(input) {
	return normalizeHostnameSuffixAllowlist(input, DEFAULT_MEDIA_HOST_ALLOWLIST);
}
function resolveAuthAllowedHosts(input) {
	return normalizeHostnameSuffixAllowlist(input, DEFAULT_MEDIA_AUTH_HOST_ALLOWLIST);
}
function resolveAttachmentFetchPolicy(params) {
	return {
		allowHosts: resolveAllowedHosts(params?.allowHosts),
		authAllowHosts: resolveAuthAllowedHosts(params?.authAllowHosts)
	};
}
function isUrlAllowed(url, allowlist) {
	return isHttpsUrlAllowedByHostnameSuffixAllowlist(url, allowlist);
}
function applyAuthorizationHeaderForUrl(params) {
	if (!params.bearerToken) {
		params.headers.delete("Authorization");
		return;
	}
	if (isUrlAllowed(params.url, params.authAllowHosts)) {
		params.headers.set("Authorization", `Bearer ${params.bearerToken}`);
		return;
	}
	params.headers.delete("Authorization");
}
function resolveMediaSsrfPolicy(allowHosts) {
	return buildHostnameAllowlistPolicyFromSuffixAllowlist(allowHosts);
}
/**
* Returns true if the given IPv4 or IPv6 address is in a private, loopback,
* or link-local range that must never be reached from media downloads.
*
* Delegates to the SDK's `isPrivateIpAddress` which handles IPv4-mapped IPv6,
* expanded notation, NAT64, 6to4, Teredo, octal IPv4, and fails closed on
* parse errors.
*/
const isPrivateOrReservedIP = isPrivateIpAddress;
/**
* Resolve a hostname via DNS and reject private/reserved IPs.
* Throws if the resolved IP is private or resolution fails.
*/
async function resolveAndValidateIP(hostname, resolveFn) {
	const resolve = resolveFn ?? lookup;
	let resolved;
	try {
		resolved = await resolve(hostname);
	} catch {
		throw new Error(`DNS resolution failed for "${hostname}"`);
	}
	if (isPrivateOrReservedIP(resolved.address)) throw new Error(`Hostname "${hostname}" resolves to private/reserved IP (${resolved.address})`);
	return resolved.address;
}
/** Maximum number of redirects to follow in safeFetch. */
const MAX_SAFE_REDIRECTS = 5;
/**
* Fetch a URL with redirect: "manual", validating each redirect target
* against the hostname allowlist and optional DNS-resolved IP (anti-SSRF).
*
* This prevents:
* - Auto-following redirects to non-allowlisted hosts
* - DNS rebinding attacks when a lookup function is provided
*/
async function safeFetch(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const resolveFn = params.resolveFn;
	const hasDispatcher = Boolean(params.requestInit && typeof params.requestInit === "object" && "dispatcher" in params.requestInit);
	const currentHeaders = new Headers(params.requestInit?.headers);
	let currentUrl = params.url;
	if (!isUrlAllowed(currentUrl, params.allowHosts)) throw new Error(`Initial download URL blocked: ${currentUrl}`);
	if (resolveFn) try {
		const initialHost = new URL(currentUrl).hostname;
		await resolveAndValidateIP(initialHost, resolveFn);
	} catch {
		throw new Error(`Initial download URL blocked: ${currentUrl}`);
	}
	for (let i = 0; i <= MAX_SAFE_REDIRECTS; i++) {
		const res = await fetchFn(currentUrl, {
			...params.requestInit,
			headers: currentHeaders,
			redirect: "manual"
		});
		if (![
			301,
			302,
			303,
			307,
			308
		].includes(res.status)) return res;
		const location = res.headers.get("location");
		if (!location) return res;
		let redirectUrl;
		try {
			redirectUrl = new URL(location, currentUrl).toString();
		} catch {
			throw new Error(`Invalid redirect URL: ${location}`);
		}
		if (!isUrlAllowed(redirectUrl, params.allowHosts)) throw new Error(`Media redirect target blocked by allowlist: ${redirectUrl}`);
		if (currentHeaders.has("authorization") && params.authorizationAllowHosts && !isUrlAllowed(redirectUrl, params.authorizationAllowHosts)) currentHeaders.delete("authorization");
		if (hasDispatcher) return res;
		if (resolveFn) {
			const redirectHost = new URL(redirectUrl).hostname;
			await resolveAndValidateIP(redirectHost, resolveFn);
		}
		currentUrl = redirectUrl;
	}
	throw new Error(`Too many redirects (>${MAX_SAFE_REDIRECTS})`);
}
async function safeFetchWithPolicy(params) {
	return await safeFetch({
		url: params.url,
		allowHosts: params.policy.allowHosts,
		authorizationAllowHosts: params.policy.authAllowHosts,
		fetchFn: params.fetchFn,
		requestInit: params.requestInit,
		resolveFn: params.resolveFn
	});
}
//#endregion
//#region extensions/msteams/src/sdk.ts
async function loadMSTeamsSdk() {
	return await import("./src-DDLjM5YN.js").then((m) => /* @__PURE__ */ __toESM(m.default, 1));
}
function buildMSTeamsAuthConfig(creds, sdk) {
	return sdk.getAuthConfigWithDefaults({
		clientId: creds.appId,
		clientSecret: creds.appPassword,
		tenantId: creds.tenantId
	});
}
function createMSTeamsAdapter(authConfig, sdk) {
	return new sdk.CloudAdapter(authConfig);
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
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime } = createPluginRuntimeStore("MSTeams runtime not initialized");
//#endregion
export { normalizeMSTeamsMessagingTarget as A, resolveMediaSsrfPolicy as C, msteamsSetupWizard as D, safeHostForUrl as E, resolveMSTeamsUserAllowlist as F, parseMSTeamsConversationId as M, parseMSTeamsTeamChannelInput as N, resolveMSTeamsCredentials as O, resolveMSTeamsChannelAllowlist as P, resolveAttachmentFetchPolicy as S, safeFetchWithPolicy as T, isDownloadableAttachment as _, normalizeQuery as a, isUrlAllowed as b, createMSTeamsAdapter as c, GRAPH_ROOT as d, IMG_SRC_RE as f, inferPlaceholder as g, extractInlineImageCandidates as h, listTeamsByName as i, normalizeMSTeamsUserInput as j, msteamsSetupAdapter as k, loadMSTeamsSdkWithAuth as l, extractHtmlFromAttachment as m, searchGraphUsers as n, resolveGraphToken as o, applyAuthorizationHeaderForUrl as p, listChannelsForTeam as r, readAccessToken as s, getMSTeamsRuntime as t, ATTACHMENT_TAG_RE as u, isLikelyImageAttachment as v, resolveRequestUrl as w, normalizeContentType as x, isRecord as y };
