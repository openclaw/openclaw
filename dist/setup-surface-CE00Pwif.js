import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { l as patchScopedAccountConfig } from "./setup-helpers-BC9z9VvG.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import { t as addWildcardAllowFrom, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Dbpzm32P.js";
import { t as formatResolvedUnresolvedNote } from "./setup-DPvocg6M.js";
import { a as resolveZalouserAccountSync, i as resolveDefaultZalouserAccountId, r as listZalouserAccountIds, t as checkZcaAuthenticated } from "./accounts-BM0qCh20.js";
import { r as writeQrDataUrlToTempFile } from "./setup-core-SEVjHNaY.js";
import { b as waitForZaloQrLogin, c as logoutZaloProfile, d as resolveZaloGroupsByEntries, l as resolveZaloAllowFromEntries, y as startZaloQrLogin } from "./zalo-js-DWwYy3d3.js";
//#region extensions/zalouser/src/setup-surface.ts
const t = createSetupTranslator();
const channel = "zalouser";
const ZALOUSER_ALLOW_FROM_PLACEHOLDER = t("wizard.zalouser.allowFromPlaceholder");
const ZALOUSER_GROUPS_PLACEHOLDER = t("wizard.zalouser.groupsPlaceholder");
const ZALOUSER_DM_ACCESS_TITLE = t("wizard.zalouser.dmAccessTitle");
const ZALOUSER_ALLOWLIST_TITLE = t("wizard.zalouser.allowlistTitle");
const ZALOUSER_GROUPS_TITLE = t("wizard.zalouser.groupsTitle");
function parseZalouserEntries(raw) {
	return raw.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
}
function setZalouserAccountScopedConfig(cfg, accountId, defaultPatch, accountPatch = defaultPatch) {
	return patchScopedAccountConfig({
		cfg,
		channelKey: channel,
		accountId,
		patch: defaultPatch,
		accountPatch
	});
}
function setZalouserDmPolicy(cfg, accountId, policy) {
	const resolvedAccountId = normalizeAccountId(accountId) ?? "default";
	const resolved = resolveZalouserAccountSync({
		cfg,
		accountId: resolvedAccountId
	});
	return setZalouserAccountScopedConfig(cfg, resolvedAccountId, {
		dmPolicy: policy,
		...policy === "open" ? { allowFrom: addWildcardAllowFrom(resolved.config.allowFrom) } : {}
	}, {
		dmPolicy: policy,
		...policy === "open" ? { allowFrom: addWildcardAllowFrom(resolved.config.allowFrom) } : {}
	});
}
function setZalouserGroupPolicy(cfg, accountId, groupPolicy) {
	return setZalouserAccountScopedConfig(cfg, accountId, { groupPolicy });
}
function setZalouserGroupAllowlist(cfg, accountId, groupKeys) {
	return setZalouserAccountScopedConfig(cfg, accountId, { groups: Object.fromEntries(groupKeys.map((key) => [key, {
		enabled: true,
		requireMention: true
	}])) });
}
function ensureZalouserPluginEnabled(cfg) {
	const next = {
		...cfg,
		plugins: {
			...cfg.plugins,
			entries: {
				...cfg.plugins?.entries,
				zalouser: {
					...cfg.plugins?.entries?.zalouser,
					enabled: true
				}
			}
		}
	};
	const allow = next.plugins?.allow;
	if (!Array.isArray(allow) || allow.includes(channel)) return next;
	return {
		...next,
		plugins: {
			...next.plugins,
			allow: [...allow, channel]
		}
	};
}
async function noteZalouserHelp(prompter) {
	await prompter.note([
		t("wizard.zalouser.helpQrLogin"),
		"",
		t("wizard.zalouser.helpZcaJs"),
		"",
		`Docs: ${formatDocsLink("/channels/zalouser", "zalouser")}`
	].join("\n"), t("wizard.zalouser.setupTitle"));
}
async function promptZalouserAllowFrom(params) {
	const { cfg, prompter, accountId } = params;
	const resolved = resolveZalouserAccountSync({
		cfg,
		accountId
	});
	const existingAllowFrom = resolved.config.allowFrom ?? [];
	while (true) {
		const parts = parseZalouserEntries(await prompter.text({
			message: t("wizard.zalouser.allowFromPrompt"),
			placeholder: ZALOUSER_ALLOW_FROM_PLACEHOLDER,
			initialValue: existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : void 0
		}));
		if (parts.length === 0) {
			await prompter.note([
				t("wizard.zalouser.noDmAllowlist"),
				t("wizard.zalouser.directChatsBlocked"),
				t("wizard.zalouser.peersLookupTip", { command: formatCliCommand("openclaw directory peers list --channel zalouser") })
			].join("\n"), ZALOUSER_ALLOWLIST_TITLE);
			return setZalouserAccountScopedConfig(cfg, accountId, {
				dmPolicy: "allowlist",
				allowFrom: []
			});
		}
		const resolvedEntries = await resolveZaloAllowFromEntries({
			profile: resolved.profile,
			entries: parts
		});
		const unresolved = resolvedEntries.filter((item) => !item.resolved).map((item) => item.input);
		if (unresolved.length > 0) {
			await prompter.note(t("wizard.zalouser.couldNotResolve", { entries: unresolved.join(", ") }), ZALOUSER_ALLOWLIST_TITLE);
			continue;
		}
		const unique = mergeAllowFromEntries(existingAllowFrom, resolvedEntries.filter((item) => item.resolved && item.id).map((item) => item.id));
		const notes = resolvedEntries.filter((item) => item.note).map((item) => `${item.input} -> ${item.id} (${item.note})`);
		if (notes.length > 0) await prompter.note(notes.join("\n"), ZALOUSER_ALLOWLIST_TITLE);
		return setZalouserAccountScopedConfig(cfg, accountId, {
			dmPolicy: "allowlist",
			allowFrom: unique
		});
	}
}
const zalouserDmPolicy = {
	label: "Zalo Personal",
	channel,
	policyKey: "channels.zalouser.dmPolicy",
	allowFromKey: "channels.zalouser.allowFrom",
	resolveConfigKeys: (cfg, accountId) => (accountId ?? resolveDefaultZalouserAccountId(cfg)) !== "default" ? {
		policyKey: `channels.zalouser.accounts.${accountId ?? resolveDefaultZalouserAccountId(cfg)}.dmPolicy`,
		allowFromKey: `channels.zalouser.accounts.${accountId ?? resolveDefaultZalouserAccountId(cfg)}.allowFrom`
	} : {
		policyKey: "channels.zalouser.dmPolicy",
		allowFromKey: "channels.zalouser.allowFrom"
	},
	getCurrent: (cfg, accountId) => resolveZalouserAccountSync({
		cfg,
		accountId: accountId ?? resolveDefaultZalouserAccountId(cfg)
	}).config.dmPolicy ?? "pairing",
	setPolicy: (cfg, policy, accountId) => setZalouserDmPolicy(cfg, accountId ?? resolveDefaultZalouserAccountId(cfg), policy),
	promptAllowFrom: async ({ cfg, prompter, accountId }) => {
		return await promptZalouserAllowFrom({
			cfg,
			prompter,
			accountId: accountId && normalizeAccountId(accountId) ? normalizeAccountId(accountId) ?? "default" : resolveDefaultZalouserAccountId(cfg)
		});
	}
};
async function promptZalouserQuickstartDmPolicy(params) {
	const { cfg, prompter, accountId } = params;
	const resolved = resolveZalouserAccountSync({
		cfg,
		accountId
	});
	const existingPolicy = resolved.config.dmPolicy ?? "pairing";
	const existingAllowFrom = resolved.config.allowFrom ?? [];
	const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";
	await prompter.note([
		t("wizard.zalouser.dmHelpSeparate"),
		t("wizard.zalouser.dmHelpPairing"),
		t("wizard.zalouser.dmHelpAllowlist"),
		t("wizard.zalouser.dmHelpOpen"),
		t("wizard.zalouser.dmHelpDisabled"),
		"",
		`Current: dmPolicy=${existingPolicy}, allowFrom=${existingLabel}`,
		t("wizard.zalouser.dmHelpAllowlistEmpty")
	].join("\n"), ZALOUSER_DM_ACCESS_TITLE);
	const policy = await prompter.select({
		message: t("wizard.zalouser.dmPolicyPrompt"),
		options: [
			{
				value: "pairing",
				label: t("wizard.channels.dmPolicyPairing")
			},
			{
				value: "allowlist",
				label: t("wizard.channels.dmPolicyAllowlistOption")
			},
			{
				value: "open",
				label: t("wizard.channels.dmPolicyOpenOption")
			},
			{
				value: "disabled",
				label: t("wizard.channels.dmPolicyDisabledOption")
			}
		],
		initialValue: existingPolicy
	});
	if (policy === "allowlist") return await promptZalouserAllowFrom({
		cfg,
		prompter,
		accountId
	});
	return setZalouserDmPolicy(cfg, accountId, policy);
}
const zalouserSetupWizard = {
	channel,
	status: {
		configuredLabel: t("wizard.channels.statusLoggedIn"),
		unconfiguredLabel: t("wizard.channels.statusNeedsQrLogin"),
		configuredHint: t("wizard.channels.statusRecommendedLoggedIn"),
		unconfiguredHint: t("wizard.channels.statusRecommendedQrLogin"),
		configuredScore: 1,
		unconfiguredScore: 15,
		resolveConfigured: async ({ cfg, accountId }) => {
			const ids = accountId ? [accountId] : listZalouserAccountIds(cfg);
			for (const resolvedAccountId of ids) if (await checkZcaAuthenticated(resolveZalouserAccountSync({
				cfg,
				accountId: resolvedAccountId
			}).profile)) return true;
			return false;
		},
		resolveStatusLines: async ({ cfg, accountId, configured }) => {
			return [`${accountId && accountId !== "default" ? `Zalo Personal (${accountId})` : "Zalo Personal"}: ${configured ? "logged in" : "needs QR login"}`];
		}
	},
	prepare: async ({ cfg, accountId, prompter, options }) => {
		let next = cfg;
		const account = resolveZalouserAccountSync({
			cfg: next,
			accountId
		});
		if (!await checkZcaAuthenticated(account.profile)) {
			await noteZalouserHelp(prompter);
			if (await prompter.confirm({
				message: t("wizard.zalouser.loginQrPrompt"),
				initialValue: true
			})) {
				const start = await startZaloQrLogin({
					profile: account.profile,
					timeoutMs: 35e3
				});
				if (start.qrDataUrl) {
					const qrPath = await writeQrDataUrlToTempFile(start.qrDataUrl, account.profile);
					await prompter.note([
						start.message,
						qrPath ? t("wizard.zalouser.qrImageSaved", { path: qrPath }) : t("wizard.zalouser.qrImageWriteFailed"),
						t("wizard.zalouser.scanApproveContinue")
					].join("\n"), t("wizard.zalouser.qrLoginTitle"));
					if (await prompter.confirm({
						message: t("wizard.zalouser.qrScannedPrompt"),
						initialValue: true
					})) {
						const waited = await waitForZaloQrLogin({
							profile: account.profile,
							timeoutMs: 12e4
						});
						await prompter.note(waited.message, waited.connected ? t("common.done") : t("wizard.zalouser.loginPendingTitle"));
					}
				} else await prompter.note(start.message, t("wizard.zalouser.loginPendingTitle"));
			}
		} else if (!await prompter.confirm({
			message: t("wizard.zalouser.keepSessionPrompt"),
			initialValue: true
		})) {
			await logoutZaloProfile(account.profile);
			const start = await startZaloQrLogin({
				profile: account.profile,
				force: true,
				timeoutMs: 35e3
			});
			if (start.qrDataUrl) {
				const qrPath = await writeQrDataUrlToTempFile(start.qrDataUrl, account.profile);
				await prompter.note([start.message, qrPath ? t("wizard.zalouser.qrImageSaved", { path: qrPath }) : void 0].filter(Boolean).join("\n"), t("wizard.zalouser.qrLoginTitle"));
				const waited = await waitForZaloQrLogin({
					profile: account.profile,
					timeoutMs: 12e4
				});
				await prompter.note(waited.message, waited.connected ? t("common.done") : t("wizard.zalouser.loginPendingTitle"));
			}
		}
		next = setZalouserAccountScopedConfig(next, accountId, { profile: account.profile !== "default" ? account.profile : void 0 }, {
			profile: account.profile,
			enabled: true
		});
		if (options?.quickstartDefaults) next = await promptZalouserQuickstartDmPolicy({
			cfg: next,
			prompter,
			accountId
		});
		return { cfg: next };
	},
	credentials: [],
	groupAccess: {
		label: "Zalo groups",
		placeholder: ZALOUSER_GROUPS_PLACEHOLDER,
		currentPolicy: ({ cfg, accountId }) => resolveZalouserAccountSync({
			cfg,
			accountId
		}).config.groupPolicy ?? "allowlist",
		currentEntries: ({ cfg, accountId }) => Object.keys(resolveZalouserAccountSync({
			cfg,
			accountId
		}).config.groups ?? {}),
		updatePrompt: ({ cfg, accountId }) => Boolean(resolveZalouserAccountSync({
			cfg,
			accountId
		}).config.groups),
		setPolicy: ({ cfg, accountId, policy }) => setZalouserGroupPolicy(cfg, accountId, policy),
		resolveAllowlist: async ({ cfg, accountId, entries, prompter }) => {
			if (entries.length === 0) {
				await prompter.note([
					t("wizard.zalouser.noGroupAllowlist"),
					t("wizard.zalouser.groupChatsBlocked"),
					t("wizard.zalouser.groupsLookupTip", { command: formatCliCommand("openclaw directory groups list --channel zalouser") }),
					t("wizard.zalouser.groupMentionRequirement")
				].join("\n"), ZALOUSER_GROUPS_TITLE);
				return [];
			}
			const updatedAccount = resolveZalouserAccountSync({
				cfg,
				accountId
			});
			try {
				const resolved = await resolveZaloGroupsByEntries({
					profile: updatedAccount.profile,
					entries
				});
				const resolvedIds = resolved.filter((entry) => entry.resolved && entry.id).map((entry) => entry.id);
				const unresolved = resolved.filter((entry) => !entry.resolved).map((entry) => entry.input);
				const keys = [...resolvedIds, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
				const resolution = formatResolvedUnresolvedNote({
					resolved: resolvedIds,
					unresolved
				});
				if (resolution) await prompter.note(resolution, ZALOUSER_GROUPS_TITLE);
				return keys;
			} catch (err) {
				await prompter.note(t("wizard.zalouser.groupLookupFailed", { error: String(err) }), ZALOUSER_GROUPS_TITLE);
				return entries.map((entry) => entry.trim()).filter(Boolean);
			}
		},
		applyAllowlist: ({ cfg, accountId, resolved }) => setZalouserGroupAllowlist(cfg, accountId, resolved)
	},
	finalize: async ({ cfg, accountId, forceAllowFrom, options, prompter }) => {
		let next = cfg;
		if (forceAllowFrom && !options?.quickstartDefaults) next = await promptZalouserAllowFrom({
			cfg: next,
			prompter,
			accountId
		});
		return { cfg: ensureZalouserPluginEnabled(next) };
	},
	dmPolicy: zalouserDmPolicy
};
//#endregion
export { zalouserSetupWizard as t };
