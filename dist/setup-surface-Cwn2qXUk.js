import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { d as normalizeSecretInputString } from "./types.secrets-BxqheYvy.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-CwBWagLE.js";
import { Q as splitSetupEntries, f as createStandardChannelSetupStatus, g as createTopLevelChannelGroupPolicySetter, m as createTopLevelChannelDmPolicy, p as createTopLevelChannelAllowFromSetter, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Cm8y4liy.js";
import "./setup-BmF6Yxnk.js";
import "./setup-tools-WOmaR-iv.js";
import { D as formatUnknownError, g as saveDelegatedTokens, h as resolveMSTeamsCredentials, p as hasConfiguredMSTeamsCredentials } from "./graph-users-CJauCWFY.js";
import { c as resolveMSTeamsUserAllowlist, o as parseMSTeamsTeamEntry, s as resolveMSTeamsChannelAllowlist } from "./resolve-allowlist-Dd5ZL3E1.js";
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
const channel$1 = "msteams";
async function promptMSTeamsCredentials(prompter) {
	return {
		appId: (await prompter.text({
			message: "Enter MS Teams App ID",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim(),
		appPassword: (await prompter.text({
			message: "Enter MS Teams App Password",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim(),
		tenantId: (await prompter.text({
			message: "Enter MS Teams Tenant ID",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim()
	};
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
function createMSTeamsSetupWizardBase() {
	return {
		channel: channel$1,
		resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
		resolveShouldPromptAccountIds: () => false,
		status: createStandardChannelSetupStatus({
			channelLabel: "MS Teams",
			configuredLabel: "configured",
			unconfiguredLabel: "needs app credentials",
			configuredHint: "configured",
			unconfiguredHint: "needs app creds",
			configuredScore: 2,
			unconfiguredScore: 0,
			includeStatusLine: true,
			resolveConfigured: ({ cfg }) => Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)) || hasConfiguredMSTeamsCredentials(cfg.channels?.msteams)
		}),
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
		}
	};
}
//#endregion
//#region extensions/msteams/src/setup-surface.ts
const channel = "msteams";
const setMSTeamsAllowFrom = createTopLevelChannelAllowFromSetter({ channel });
const setMSTeamsGroupPolicy = createTopLevelChannelGroupPolicySetter({
	channel,
	enabled: true
});
function openDelegatedOAuthUrl(url) {
	return Promise.reject(/* @__PURE__ */ new Error(`Automatic browser launch is not available. Open this URL manually: ${url}`));
}
function looksLikeGuid(value) {
	return /^[0-9a-fA-F-]{16,}$/.test(value);
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
		const parts = splitSetupEntries(await params.prompter.text({
			message: "MS Teams allowFrom (usernames or ids)",
			placeholder: "alex@example.com, Alex Johnson",
			initialValue: existing[0] ? existing[0] : void 0,
			validate: (value) => value.trim() ? void 0 : "Required"
		}));
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
		await params.prompter.note(`Channel lookup failed; keeping entries as typed. ${formatUnknownError(err)}`, "MS Teams channels");
		return resolvedEntries;
	}
}
const msteamsGroupAccess = {
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
};
const msteamsDmPolicy = createTopLevelChannelDmPolicy({
	label: "MS Teams",
	channel,
	policyKey: "channels.msteams.dmPolicy",
	allowFromKey: "channels.msteams.allowFrom",
	getCurrent: (cfg) => cfg.channels?.msteams?.dmPolicy ?? "pairing",
	promptAllowFrom: promptMSTeamsAllowFrom
});
const msteamsSetupWizardBase = createMSTeamsSetupWizardBase();
const msteamsSetupWizard = {
	...msteamsSetupWizardBase,
	finalize: async (params) => {
		const baseFinalize = msteamsSetupWizardBase.finalize;
		const baseResult = baseFinalize ? await baseFinalize(params) : void 0;
		let next = baseResult?.cfg ?? params.cfg;
		const finalCreds = resolveMSTeamsCredentials(next.channels?.msteams);
		if (finalCreds?.type === "secret") {
			if (await params.prompter.confirm({
				message: "Enable delegated auth? (required for reactions and write operations)",
				initialValue: false
			})) {
				next = {
					...next,
					channels: {
						...next.channels,
						msteams: {
							...next.channels?.msteams,
							delegatedAuth: { enabled: true }
						}
					}
				};
				try {
					const { loginMSTeamsDelegated } = await import("./oauth-Dy4bI-gG.js");
					const progress = params.prompter.progress("MSTeams Delegated OAuth");
					saveDelegatedTokens(await loginMSTeamsDelegated({
						isRemote: true,
						openUrl: openDelegatedOAuthUrl,
						log: (msg) => params.prompter.note(msg),
						note: (msg, title) => params.prompter.note(msg, title),
						prompt: (msg) => params.prompter.text({ message: msg }),
						progress
					}, {
						tenantId: finalCreds.tenantId,
						clientId: finalCreds.appId,
						clientSecret: finalCreds.appPassword
					}));
					progress.stop("Delegated auth configured");
				} catch (err) {
					await params.prompter.note(`Delegated auth setup failed: ${formatUnknownError(err)}\nYou can retry later via the setup wizard.`, "MS Teams delegated auth");
				}
			}
		}
		return {
			...baseResult,
			cfg: next
		};
	},
	dmPolicy: msteamsDmPolicy,
	groupAccess: msteamsGroupAccess,
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
export { msteamsSetupAdapter as i, openDelegatedOAuthUrl as n, createMSTeamsSetupWizardBase as r, msteamsSetupWizard as t };
