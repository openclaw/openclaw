import { s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import { B as runSingleChannelSecretStep, P as promptSingleChannelSecretInput, f as createStandardChannelSetupStatus, n as buildSingleChannelSecretPromptState } from "./setup-wizard-helpers-Dbpzm32P.js";
import "./setup-DPvocg6M.js";
import { i as resolveZaloAccount } from "./accounts-CZtuHf49.js";
import { a as promptZaloAllowFrom, i as noteZaloTokenHelp, n as zaloDmPolicy } from "./setup-core-B97EObg2.js";
//#region extensions/zalo/src/setup-surface.ts
const t = createSetupTranslator();
const channel = "zalo";
function setZaloUpdateMode(cfg, accountId, mode, webhookUrl, webhookSecret, webhookPath) {
	const isDefault = accountId === DEFAULT_ACCOUNT_ID;
	if (mode === "polling") {
		if (isDefault) {
			const { webhookUrl: _url, webhookSecret: _secret, webhookPath: _path, ...rest } = cfg.channels?.zalo ?? {};
			return {
				...cfg,
				channels: {
					...cfg.channels,
					zalo: rest
				}
			};
		}
		const accounts = { ...cfg.channels?.zalo?.accounts };
		const { webhookUrl: _url, webhookSecret: _secret, webhookPath: _path, ...rest } = accounts[accountId] ?? {};
		accounts[accountId] = rest;
		return {
			...cfg,
			channels: {
				...cfg.channels,
				zalo: {
					...cfg.channels?.zalo,
					accounts
				}
			}
		};
	}
	if (isDefault) return {
		...cfg,
		channels: {
			...cfg.channels,
			zalo: {
				...cfg.channels?.zalo,
				webhookUrl,
				webhookSecret,
				webhookPath
			}
		}
	};
	const accounts = { ...cfg.channels?.zalo?.accounts };
	accounts[accountId] = {
		...accounts[accountId],
		webhookUrl,
		webhookSecret,
		webhookPath
	};
	return {
		...cfg,
		channels: {
			...cfg.channels,
			zalo: {
				...cfg.channels?.zalo,
				accounts
			}
		}
	};
}
const zaloSetupWizard = {
	channel,
	status: createStandardChannelSetupStatus({
		channelLabel: "Zalo",
		configuredLabel: t("wizard.channels.statusConfigured"),
		unconfiguredLabel: t("wizard.channels.statusNeedsToken"),
		configuredHint: t("wizard.channels.statusRecommendedConfigured"),
		unconfiguredHint: t("wizard.channels.statusRecommendedNewcomerFriendly"),
		configuredScore: 1,
		unconfiguredScore: 10,
		includeStatusLine: true,
		resolveConfigured: ({ cfg, accountId }) => {
			const account = resolveZaloAccount({
				cfg,
				accountId,
				allowUnresolvedSecretRef: true
			});
			return Boolean(account.token) || hasConfiguredSecretInput(account.config.botToken) || Boolean(account.config.tokenFile?.trim());
		}
	}),
	credentials: [],
	finalize: async ({ cfg, accountId, forceAllowFrom, options, prompter }) => {
		let next = cfg;
		const resolvedAccount = resolveZaloAccount({
			cfg: next,
			accountId,
			allowUnresolvedSecretRef: true
		});
		const accountConfigured = Boolean(resolvedAccount.token);
		const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
		const hasConfigToken = Boolean(hasConfiguredSecretInput(resolvedAccount.config.botToken) || resolvedAccount.config.tokenFile);
		next = (await runSingleChannelSecretStep({
			cfg: next,
			prompter,
			providerHint: "zalo",
			credentialLabel: t("wizard.zalo.botToken"),
			secretInputMode: options?.secretInputMode,
			accountConfigured,
			hasConfigToken,
			allowEnv,
			envValue: process.env.ZALO_BOT_TOKEN,
			envPrompt: t("wizard.zalo.tokenEnvPrompt"),
			keepPrompt: t("wizard.zalo.tokenKeep"),
			inputPrompt: t("wizard.zalo.tokenInput"),
			preferredEnvVar: "ZALO_BOT_TOKEN",
			onMissingConfigured: async () => await noteZaloTokenHelp(prompter),
			applyUseEnv: async (currentCfg) => accountId === "default" ? {
				...currentCfg,
				channels: {
					...currentCfg.channels,
					zalo: {
						...currentCfg.channels?.zalo,
						enabled: true
					}
				}
			} : currentCfg,
			applySet: async (currentCfg, value) => accountId === "default" ? {
				...currentCfg,
				channels: {
					...currentCfg.channels,
					zalo: {
						...currentCfg.channels?.zalo,
						enabled: true,
						botToken: value
					}
				}
			} : {
				...currentCfg,
				channels: {
					...currentCfg.channels,
					zalo: {
						...currentCfg.channels?.zalo,
						enabled: true,
						accounts: {
							...currentCfg.channels?.zalo?.accounts,
							[accountId]: {
								...currentCfg.channels?.zalo?.accounts?.[accountId],
								enabled: true,
								botToken: value
							}
						}
					}
				}
			}
		})).cfg;
		if (await prompter.confirm({
			message: t("wizard.zalo.webhookModePrompt"),
			initialValue: Boolean(resolvedAccount.config.webhookUrl)
		})) {
			const webhookUrl = (await prompter.text({
				message: t("wizard.zalo.webhookUrlPrompt"),
				initialValue: resolvedAccount.config.webhookUrl,
				validate: (value) => value?.trim()?.startsWith("https://") ? void 0 : "HTTPS URL required"
			})).trim();
			const defaultPath = (() => {
				try {
					return new URL(webhookUrl).pathname || "/zalo-webhook";
				} catch {
					return "/zalo-webhook";
				}
			})();
			let webhookSecretResult = await promptSingleChannelSecretInput({
				cfg: next,
				prompter,
				providerHint: "zalo-webhook",
				credentialLabel: t("wizard.zalo.webhookSecret"),
				secretInputMode: options?.secretInputMode,
				...buildSingleChannelSecretPromptState({
					accountConfigured: hasConfiguredSecretInput(resolvedAccount.config.webhookSecret),
					hasConfigToken: hasConfiguredSecretInput(resolvedAccount.config.webhookSecret),
					allowEnv: false
				}),
				envPrompt: "",
				keepPrompt: t("wizard.zalo.webhookSecretKeep"),
				inputPrompt: t("wizard.zalo.webhookSecretInput"),
				preferredEnvVar: "ZALO_WEBHOOK_SECRET"
			});
			while (webhookSecretResult.action === "set" && typeof webhookSecretResult.value === "string" && (webhookSecretResult.value.length < 8 || webhookSecretResult.value.length > 256)) {
				await prompter.note(t("wizard.zalo.webhookSecretLength"), t("wizard.zalo.webhookTitle"));
				webhookSecretResult = await promptSingleChannelSecretInput({
					cfg: next,
					prompter,
					providerHint: "zalo-webhook",
					credentialLabel: t("wizard.zalo.webhookSecret"),
					secretInputMode: options?.secretInputMode,
					...buildSingleChannelSecretPromptState({
						accountConfigured: false,
						hasConfigToken: false,
						allowEnv: false
					}),
					envPrompt: "",
					keepPrompt: t("wizard.zalo.webhookSecretKeep"),
					inputPrompt: t("wizard.zalo.webhookSecretInput"),
					preferredEnvVar: "ZALO_WEBHOOK_SECRET"
				});
			}
			const webhookSecret = webhookSecretResult.action === "set" ? webhookSecretResult.value : resolvedAccount.config.webhookSecret;
			const webhookPath = (await prompter.text({
				message: t("wizard.zalo.webhookPathPrompt"),
				initialValue: resolvedAccount.config.webhookPath ?? defaultPath
			})).trim();
			next = setZaloUpdateMode(next, accountId, "webhook", webhookUrl, webhookSecret, webhookPath || void 0);
		} else next = setZaloUpdateMode(next, accountId, "polling");
		if (forceAllowFrom) next = await promptZaloAllowFrom({
			cfg: next,
			prompter,
			accountId
		});
		return { cfg: next };
	},
	dmPolicy: zaloDmPolicy
};
//#endregion
export { zaloSetupWizard };
