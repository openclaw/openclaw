import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { a as createSetupInputPresenceValidator, i as createPatchedAccountSetupAdapter } from "./setup-helpers-BC9z9VvG.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import { t as addWildcardAllowFrom, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Dbpzm32P.js";
import { a as createDelegatedSetupWizardProxy } from "./setup-wizard-proxy-B15glc8O.js";
import "./setup-DPvocg6M.js";
import { i as resolveZaloAccount, r as resolveDefaultZaloAccountId } from "./accounts-CZtuHf49.js";
//#region extensions/zalo/src/setup-allow-from.ts
const t$1 = createSetupTranslator();
async function noteZaloTokenHelp(prompter) {
	await prompter.note([
		t$1("wizard.zalo.helpOpenPlatform"),
		t$1("wizard.zalo.helpCreateBot"),
		t$1("wizard.zalo.helpTokenFormat"),
		t$1("wizard.zalo.helpEnvTip"),
		`Docs: ${formatDocsLink("/channels/zalo", "zalo")}`
	].join("\n"), t$1("wizard.zalo.botTokenTitle"));
}
async function promptZaloAllowFrom(params) {
	const { cfg, prompter } = params;
	const accountId = params.accountId ?? resolveDefaultZaloAccountId(cfg);
	const existingAllowFrom = resolveZaloAccount({
		cfg,
		accountId
	}).config.allowFrom ?? [];
	const unique = mergeAllowFromEntries(existingAllowFrom, [(await prompter.text({
		message: t$1("wizard.zalo.allowFromPrompt"),
		placeholder: "123456789",
		initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : void 0,
		validate: (value) => {
			const raw = (value ?? "").trim();
			if (!raw) return t$1("common.required");
			if (!/^\d+$/.test(raw)) return t$1("wizard.zalo.allowFromNumeric");
		}
	})).trim()]);
	if (accountId === "default") return {
		...cfg,
		channels: {
			...cfg.channels,
			zalo: {
				...cfg.channels?.zalo,
				enabled: true,
				dmPolicy: "allowlist",
				allowFrom: unique
			}
		}
	};
	const currentAccount = cfg.channels?.zalo?.accounts?.[accountId];
	return {
		...cfg,
		channels: {
			...cfg.channels,
			zalo: {
				...cfg.channels?.zalo,
				enabled: true,
				accounts: {
					...cfg.channels?.zalo?.accounts,
					[accountId]: {
						...currentAccount,
						enabled: currentAccount?.enabled ?? true,
						dmPolicy: "allowlist",
						allowFrom: unique
					}
				}
			}
		}
	};
}
//#endregion
//#region extensions/zalo/src/setup-core.ts
const t = createSetupTranslator();
const channel = "zalo";
const zaloSetupAdapter = createPatchedAccountSetupAdapter({
	channelKey: channel,
	validateInput: createSetupInputPresenceValidator({
		defaultAccountOnlyEnvError: "ZALO_BOT_TOKEN can only be used for the default account.",
		whenNotUseEnv: [{
			someOf: ["token", "tokenFile"],
			message: "Zalo requires token or --token-file (or --use-env)."
		}]
	}),
	buildPatch: (input) => input.useEnv ? {} : input.tokenFile ? { tokenFile: input.tokenFile } : input.token ? { botToken: input.token } : {}
});
const zaloDmPolicy = {
	label: "Zalo",
	channel,
	policyKey: "channels.zalo.dmPolicy",
	allowFromKey: "channels.zalo.allowFrom",
	resolveConfigKeys: (cfg, accountId) => (accountId ?? resolveDefaultZaloAccountId(cfg)) !== "default" ? {
		policyKey: `channels.zalo.accounts.${accountId ?? resolveDefaultZaloAccountId(cfg)}.dmPolicy`,
		allowFromKey: `channels.zalo.accounts.${accountId ?? resolveDefaultZaloAccountId(cfg)}.allowFrom`
	} : {
		policyKey: "channels.zalo.dmPolicy",
		allowFromKey: "channels.zalo.allowFrom"
	},
	getCurrent: (cfg, accountId) => resolveZaloAccount({
		cfg,
		accountId: accountId ?? resolveDefaultZaloAccountId(cfg)
	}).config.dmPolicy ?? "pairing",
	setPolicy: (cfg, policy, accountId) => {
		const resolvedAccountId = accountId && normalizeAccountId(accountId) ? normalizeAccountId(accountId) ?? "default" : resolveDefaultZaloAccountId(cfg);
		const resolved = resolveZaloAccount({
			cfg,
			accountId: resolvedAccountId
		});
		if (resolvedAccountId === "default") return {
			...cfg,
			channels: {
				...cfg.channels,
				zalo: {
					...cfg.channels?.zalo,
					enabled: true,
					dmPolicy: policy,
					...policy === "open" ? { allowFrom: addWildcardAllowFrom(resolved.config.allowFrom) } : {}
				}
			}
		};
		const currentAccount = cfg.channels?.zalo?.accounts?.[resolvedAccountId];
		return {
			...cfg,
			channels: {
				...cfg.channels,
				zalo: {
					...cfg.channels?.zalo,
					enabled: true,
					accounts: {
						...cfg.channels?.zalo?.accounts,
						[resolvedAccountId]: {
							...currentAccount,
							enabled: currentAccount?.enabled ?? true,
							dmPolicy: policy,
							...policy === "open" ? { allowFrom: addWildcardAllowFrom(resolved.config.allowFrom) } : {}
						}
					}
				}
			}
		};
	},
	promptAllowFrom: async ({ cfg, prompter, accountId }) => promptZaloAllowFrom({
		cfg,
		prompter,
		accountId: accountId ?? resolveDefaultZaloAccountId(cfg)
	})
};
function createZaloSetupWizardProxy(loadWizard) {
	return createDelegatedSetupWizardProxy({
		channel,
		loadWizard,
		status: {
			configuredLabel: t("wizard.channels.statusConfigured"),
			unconfiguredLabel: t("wizard.channels.statusNeedsToken"),
			configuredHint: t("wizard.channels.statusRecommendedConfigured"),
			unconfiguredHint: t("wizard.channels.statusRecommendedNewcomerFriendly"),
			configuredScore: 1,
			unconfiguredScore: 10
		},
		credentials: [],
		delegateFinalize: true,
		dmPolicy: zaloDmPolicy,
		disable: (cfg) => ({
			...cfg,
			channels: {
				...cfg.channels,
				zalo: {
					...cfg.channels?.zalo,
					enabled: false
				}
			}
		})
	});
}
//#endregion
export { promptZaloAllowFrom as a, noteZaloTokenHelp as i, zaloDmPolicy as n, zaloSetupAdapter as r, createZaloSetupWizardProxy as t };
