import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { n as normalizeAccountId } from "./account-id-CwBWagLE.js";
import { a as createSetupInputPresenceValidator, i as createPatchedAccountSetupAdapter } from "./setup-helpers-D1h9Zq-C.js";
import { t as addWildcardAllowFrom, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Cm8y4liy.js";
import { a as createDelegatedSetupWizardProxy } from "./setup-wizard-proxy-HeBrCZ-u.js";
import "./setup-BmF6Yxnk.js";
import { i as resolveZaloAccount, r as resolveDefaultZaloAccountId } from "./accounts-dBYbLVC_.js";
//#region extensions/zalo/src/setup-allow-from.ts
async function noteZaloTokenHelp(prompter) {
	await prompter.note([
		"1) Open Zalo Bot Platform: https://bot.zaloplatforms.com",
		"2) Create a bot and get the token",
		"3) Token looks like 12345689:abc-xyz",
		"Tip: you can also set ZALO_BOT_TOKEN in your env.",
		`Docs: ${formatDocsLink("/channels/zalo", "zalo")}`
	].join("\n"), "Zalo bot token");
}
async function promptZaloAllowFrom(params) {
	const { cfg, prompter } = params;
	const accountId = params.accountId ?? resolveDefaultZaloAccountId(cfg);
	const existingAllowFrom = resolveZaloAccount({
		cfg,
		accountId
	}).config.allowFrom ?? [];
	const unique = mergeAllowFromEntries(existingAllowFrom, [(await prompter.text({
		message: "Zalo allowFrom (user id)",
		placeholder: "123456789",
		initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : void 0,
		validate: (value) => {
			const raw = (value ?? "").trim();
			if (!raw) return "Required";
			if (!/^\d+$/.test(raw)) return "Use a numeric Zalo user id";
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
			configuredLabel: "configured",
			unconfiguredLabel: "needs token",
			configuredHint: "recommended · configured",
			unconfiguredHint: "recommended · newcomer-friendly",
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
