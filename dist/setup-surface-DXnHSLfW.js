import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { d as normalizeSecretInputString } from "./types.secrets-DwPik3M8.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import { Q as splitSetupEntries, f as createStandardChannelSetupStatus, g as createTopLevelChannelGroupPolicySetter, m as createTopLevelChannelDmPolicy, p as createTopLevelChannelAllowFromSetter, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Dbpzm32P.js";
import "./setup-DPvocg6M.js";
import "./setup-tools-DuiMNzp5.js";
import { D as formatUnknownError, g as saveDelegatedTokens, h as resolveMSTeamsCredentials, p as hasConfiguredMSTeamsCredentials } from "./graph-users-_25MXF-j.js";
import { c as resolveMSTeamsUserAllowlist, o as parseMSTeamsTeamEntry, s as resolveMSTeamsChannelAllowlist } from "./resolve-allowlist-RCWaHejE.js";
//#region extensions/msteams/src/setup-core.ts
const t$1 = createSetupTranslator();
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
			message: t$1("wizard.msteams.appIdPrompt"),
			validate: (value) => value?.trim() ? void 0 : t$1("common.required")
		})).trim(),
		appPassword: (await prompter.text({
			message: t$1("wizard.msteams.appPasswordPrompt"),
			validate: (value) => value?.trim() ? void 0 : t$1("common.required")
		})).trim(),
		tenantId: (await prompter.text({
			message: t$1("wizard.msteams.tenantIdPrompt"),
			validate: (value) => value?.trim() ? void 0 : t$1("common.required")
		})).trim()
	};
}
async function noteMSTeamsCredentialHelp(prompter) {
	await prompter.note([
		t$1("wizard.msteams.helpAzureBot"),
		t$1("wizard.msteams.helpClientSecret"),
		t$1("wizard.msteams.helpWebhook"),
		t$1("wizard.msteams.helpEnvTip"),
		t$1("wizard.channels.docs", { link: formatDocsLink("/channels/msteams", "msteams") })
	].join("\n"), t$1("wizard.msteams.credentialsTitle"));
}
function createMSTeamsSetupWizardBase() {
	return {
		channel: channel$1,
		resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
		resolveShouldPromptAccountIds: () => false,
		status: createStandardChannelSetupStatus({
			channelLabel: "MS Teams",
			configuredLabel: t$1("wizard.channels.statusConfigured"),
			unconfiguredLabel: t$1("wizard.channels.statusNeedsAppCredentials"),
			configuredHint: t$1("wizard.channels.statusConfigured"),
			unconfiguredHint: t$1("wizard.channels.statusNeedsAppCreds"),
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
				message: t$1("wizard.msteams.envPrompt"),
				initialValue: true
			})) next = msteamsSetupAdapter.applyAccountConfig({
				cfg: next,
				accountId: DEFAULT_ACCOUNT_ID,
				input: {}
			});
			else ({appId, appPassword, tenantId} = await promptMSTeamsCredentials(prompter));
			else if (hasConfigCreds) {
				if (!await prompter.confirm({
					message: t$1("wizard.msteams.credentialsKeep"),
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
const t = createSetupTranslator();
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
		t("wizard.msteams.allowlistIntro"),
		t("wizard.msteams.allowlistResolve"),
		t("wizard.msteams.examples"),
		"- alex@example.com",
		"- Alex Johnson",
		"- 00000000-0000-0000-0000-000000000000"
	].join("\n"), t("wizard.msteams.allowlistTitle"));
	while (true) {
		const parts = splitSetupEntries(await params.prompter.text({
			message: t("wizard.msteams.allowFromPrompt"),
			placeholder: "alex@example.com, Alex Johnson",
			initialValue: existing[0] ? existing[0] : void 0,
			validate: (value) => value.trim() ? void 0 : t("common.required")
		}));
		if (parts.length === 0) {
			await params.prompter.note(t("wizard.msteams.enterAtLeastOneUser"), t("wizard.msteams.allowlistTitle"));
			continue;
		}
		const resolved = await resolveMSTeamsUserAllowlist({
			cfg: params.cfg,
			entries: parts
		}).catch(() => null);
		if (!resolved) {
			const ids = parts.filter((part) => looksLikeGuid(part));
			if (ids.length !== parts.length) {
				await params.prompter.note(t("wizard.msteams.graphLookupUnavailable"), t("wizard.msteams.allowlistTitle"));
				continue;
			}
			const unique = mergeAllowFromEntries(existing, ids);
			return setMSTeamsAllowFrom(params.cfg, unique);
		}
		const unresolved = resolved.filter((item) => !item.resolved || !item.id);
		if (unresolved.length > 0) {
			await params.prompter.note(t("wizard.msteams.couldNotResolve", { entries: unresolved.map((item) => item.input).join(", ") }), t("wizard.msteams.allowlistTitle"));
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
		if (resolvedChannels.length > 0) summary.push(t("wizard.msteams.resolvedChannels", { entries: resolvedChannels.map((entry) => entry.channelId).filter(Boolean).join(", ") }));
		if (resolvedTeams.length > 0) summary.push(t("wizard.msteams.resolvedTeams", { entries: resolvedTeams.map((entry) => entry.teamId).filter(Boolean).join(", ") }));
		if (unresolved.length > 0) summary.push(t("wizard.msteams.unresolvedKept", { entries: unresolved.join(", ") }));
		if (summary.length > 0) await params.prompter.note(summary.join("\n"), t("wizard.msteams.channelsLabel"));
		return resolvedEntries;
	} catch (err) {
		await params.prompter.note(t("wizard.msteams.channelLookupFailed", { error: formatUnknownError(err) }), t("wizard.msteams.channelsLabel"));
		return resolvedEntries;
	}
}
const msteamsGroupAccess = {
	label: t("wizard.msteams.channelsLabel"),
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
				message: t("wizard.msteams.delegatedAuthPrompt"),
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
					const { loginMSTeamsDelegated } = await import("./oauth-8G1QcUX9.js");
					const progress = params.prompter.progress(t("wizard.msteams.delegatedOAuthProgress"));
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
					progress.stop(t("wizard.msteams.delegatedAuthConfigured"));
				} catch (err) {
					await params.prompter.note(`Delegated auth setup failed: ${formatUnknownError(err)}\n` + t("wizard.msteams.delegatedAuthRetry"), t("wizard.msteams.delegatedAuthTitle"));
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
