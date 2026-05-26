import { d as normalizeSecretInputString, m as resolveSecretInputRef } from "./types.secrets-DwPik3M8.js";
import { a as findTailscaleBinary } from "./tailscale-BvtowUdS.js";
import { t as randomToken } from "./random-token-hQenuzDT.js";
import { o as formatPortRangeHint } from "./error-format-BfFDdqsq.js";
import { t as resolveSecretInputModeForEnvSelection } from "./provider-auth-mode-pYim_v-q.js";
import { n as promptSecretRefForSetup } from "./provider-auth-ref-jlzCUrxx.js";
import { n as t } from "./i18n-CWNhN747.js";
import { t as DEFAULT_DANGEROUS_NODE_COMMANDS } from "./node-command-policy-Bsyvfkrl.js";
import { t as maskApiKey } from "./mask-api-key-CbfeqQaR.js";
import { c as normalizeGatewayTokenInput, p as validateGatewayPasswordInput } from "./onboard-helpers-BaLdeEkj.js";
import { t as resolveSetupSecretInputString } from "./setup.secret-input-CDzkHBam.js";
import { a as maybeAddTailnetOriginToControlUiAllowedOrigins, r as TAILSCALE_EXPOSURE_OPTIONS, t as validateIPv4AddressInput } from "./ipv4-CztOOH8R.js";
import { n as ensureControlUiAllowedOriginsForNonLoopbackBind } from "./gateway-control-ui-origins-BX09k5CR.js";
//#region src/wizard/setup.gateway-config.ts
function getLocalizedTailscaleExposureOptions() {
	return TAILSCALE_EXPOSURE_OPTIONS.map((option) => ({
		hint: t(`wizard.gatewayTailscale.${option.value}Hint`),
		label: t(`wizard.gatewayTailscale.${option.value}`),
		value: option.value
	}));
}
function normalizeWizardTextInput(value) {
	return typeof value === "string" ? value.trim() : "";
}
function validateGatewayPortInput(value) {
	const port = Number(normalizeWizardTextInput(value));
	if (!Number.isInteger(port) || port < 1 || port > 65535) return formatPortRangeHint();
}
async function configureGatewayForSetup(opts) {
	const { flow, localPort, quickstartGateway, prompter } = opts;
	let { nextConfig } = opts;
	const port = flow === "quickstart" ? quickstartGateway.port : Number.parseInt(normalizeWizardTextInput(await prompter.text({
		message: t("wizard.gateway.port"),
		initialValue: String(localPort),
		validate: validateGatewayPortInput
	})), 10);
	let bind = flow === "quickstart" ? quickstartGateway.bind : await prompter.select({
		message: t("wizard.gateway.bindAddress"),
		options: [
			{
				value: "loopback",
				label: t("wizard.gateway.bindLoopback"),
				hint: t("wizard.gateway.bindLoopbackHint")
			},
			{
				value: "lan",
				label: t("wizard.gateway.bindLan"),
				hint: t("wizard.gateway.bindLanHint")
			},
			{
				value: "tailnet",
				label: t("wizard.gateway.bindTailnet"),
				hint: t("wizard.gateway.bindTailnetHint")
			},
			{
				value: "auto",
				label: t("wizard.gateway.bindAuto"),
				hint: t("wizard.gateway.bindAutoHint")
			},
			{
				value: "custom",
				label: t("wizard.gateway.bindCustom"),
				hint: t("wizard.gateway.bindCustomHint")
			}
		]
	});
	let customBindHost = quickstartGateway.customBindHost;
	if (bind === "custom") {
		if (flow !== "quickstart" || !customBindHost) {
			const input = await prompter.text({
				message: t("wizard.gateway.bindCustomIp"),
				placeholder: "192.168.1.100",
				initialValue: customBindHost ?? "",
				validate: validateIPv4AddressInput
			});
			customBindHost = typeof input === "string" ? input.trim() : void 0;
		}
	}
	let authMode = flow === "quickstart" ? quickstartGateway.authMode : await prompter.select({
		message: t("wizard.gateway.accessProtection"),
		options: [{
			value: "token",
			label: t("common.tokenRecommended"),
			hint: t("wizard.gateway.plaintextTokenHint")
		}, {
			value: "password",
			label: t("common.password")
		}],
		initialValue: "token"
	});
	const tailscaleMode = flow === "quickstart" ? quickstartGateway.tailscaleMode : await prompter.select({
		message: t("wizard.gateway.tailscaleExposure"),
		options: getLocalizedTailscaleExposureOptions()
	});
	let tailscaleBin = null;
	if (tailscaleMode !== "off") {
		tailscaleBin = await findTailscaleBinary();
		if (!tailscaleBin) await prompter.note(t("wizard.gatewayTailscale.missingBinNote"), t("wizard.gatewayTailscale.warningTitle"));
	}
	let tailscaleResetOnExit = flow === "quickstart" ? quickstartGateway.tailscaleResetOnExit : false;
	if (tailscaleMode !== "off" && flow !== "quickstart") {
		await prompter.note(t("wizard.gatewayTailscale.docsNote"), "Tailscale");
		tailscaleResetOnExit = await prompter.confirm({
			message: t("wizard.gateway.tailscaleReset"),
			initialValue: false
		});
	}
	if (tailscaleMode !== "off" && bind !== "loopback") {
		await prompter.note(t("wizard.gatewayNotes.tailscaleBindLoopback"), t("wizard.gatewayNotes.bindTitle"));
		bind = "loopback";
		customBindHost = void 0;
	}
	if (tailscaleMode === "funnel" && authMode !== "password") {
		await prompter.note(t("wizard.gatewayNotes.tailscaleFunnelPassword"), t("wizard.gateway.auth"));
		authMode = "password";
	}
	let gatewayToken;
	let gatewayTokenInput;
	if (authMode === "token") {
		const quickstartTokenString = normalizeSecretInputString(quickstartGateway.token);
		const quickstartTokenRef = resolveSecretInputRef({
			value: quickstartGateway.token,
			defaults: nextConfig.secrets?.defaults
		}).ref;
		if ((flow === "quickstart" && opts.secretInputMode !== "ref" ? quickstartTokenRef ? "ref" : "plaintext" : await resolveSecretInputModeForEnvSelection({
			prompter,
			explicitMode: opts.secretInputMode,
			copy: {
				modeMessage: t("wizard.gateway.authTokenMode"),
				plaintextLabel: t("wizard.gateway.plaintextTokenLabel"),
				plaintextHint: t("wizard.gateway.plaintextTokenHint"),
				refLabel: t("wizard.gateway.refLabel"),
				refHint: t("wizard.gateway.refHint")
			}
		})) === "ref") if (flow === "quickstart" && quickstartTokenRef) {
			gatewayTokenInput = quickstartTokenRef;
			gatewayToken = await resolveSetupSecretInputString({
				config: nextConfig,
				value: quickstartTokenRef,
				path: "gateway.auth.token",
				env: process.env
			});
		} else {
			const resolved = await promptSecretRefForSetup({
				provider: "gateway-auth-token",
				config: nextConfig,
				prompter,
				preferredEnvVar: "OPENCLAW_GATEWAY_TOKEN",
				copy: {
					sourceMessage: t("wizard.gateway.authTokenStoredMessage"),
					envVarPlaceholder: "OPENCLAW_GATEWAY_TOKEN"
				}
			});
			gatewayTokenInput = resolved.ref;
			gatewayToken = resolved.resolvedValue;
		}
		else if (flow === "quickstart") {
			gatewayToken = (quickstartTokenString ?? normalizeGatewayTokenInput(process.env.OPENCLAW_GATEWAY_TOKEN)) || randomToken();
			gatewayTokenInput = gatewayToken;
		} else {
			const existingToken = quickstartTokenString ?? normalizeGatewayTokenInput(process.env.OPENCLAW_GATEWAY_TOKEN);
			let tokenInput;
			if (existingToken) tokenInput = await prompter.confirm({
				message: t("wizard.gateway.existingTokenConfirm", { token: maskApiKey(existingToken) }),
				initialValue: true
			}) ? existingToken : await prompter.text({
				message: t("wizard.gateway.tokenPromptGenerate"),
				placeholder: t("wizard.gateway.tokenPlaceholder"),
				sensitive: true
			});
			else tokenInput = await prompter.text({
				message: t("wizard.gateway.tokenPromptGenerate"),
				placeholder: t("wizard.gateway.tokenPlaceholder"),
				sensitive: true
			});
			gatewayToken = normalizeGatewayTokenInput(tokenInput) || randomToken();
			gatewayTokenInput = gatewayToken;
		}
	}
	if (authMode === "password") {
		let password = flow === "quickstart" && quickstartGateway.password ? quickstartGateway.password : void 0;
		if (!password) if (await resolveSecretInputModeForEnvSelection({
			prompter,
			explicitMode: opts.secretInputMode,
			copy: {
				modeMessage: t("wizard.gateway.authPasswordMode"),
				plaintextLabel: t("wizard.gateway.plaintextPasswordLabel"),
				plaintextHint: t("wizard.gateway.plaintextPasswordHint")
			}
		}) === "ref") password = (await promptSecretRefForSetup({
			provider: "gateway-auth-password",
			config: nextConfig,
			prompter,
			preferredEnvVar: "OPENCLAW_GATEWAY_PASSWORD",
			copy: {
				sourceMessage: t("wizard.gateway.authPasswordStoredMessage"),
				envVarPlaceholder: "OPENCLAW_GATEWAY_PASSWORD"
			}
		})).ref;
		else password = normalizeWizardTextInput(await prompter.text({
			message: t("wizard.gateway.passwordPrompt"),
			validate: validateGatewayPasswordInput,
			sensitive: true
		}));
		nextConfig = {
			...nextConfig,
			gateway: {
				...nextConfig.gateway,
				auth: {
					...nextConfig.gateway?.auth,
					mode: "password",
					password
				}
			}
		};
	} else if (authMode === "token") nextConfig = {
		...nextConfig,
		gateway: {
			...nextConfig.gateway,
			auth: {
				...nextConfig.gateway?.auth,
				mode: "token",
				token: gatewayTokenInput
			}
		}
	};
	nextConfig = {
		...nextConfig,
		gateway: {
			...nextConfig.gateway,
			port,
			bind,
			...bind === "custom" && customBindHost ? { customBindHost } : {},
			tailscale: {
				...nextConfig.gateway?.tailscale,
				mode: tailscaleMode,
				resetOnExit: tailscaleResetOnExit
			}
		}
	};
	if (flow === "quickstart" && bind === "loopback" && nextConfig.gateway?.controlUi?.allowInsecureAuth === void 0) nextConfig = {
		...nextConfig,
		gateway: {
			...nextConfig.gateway,
			controlUi: {
				...nextConfig.gateway?.controlUi,
				allowInsecureAuth: true
			}
		}
	};
	nextConfig = ensureControlUiAllowedOriginsForNonLoopbackBind(nextConfig, { requireControlUiEnabled: true }).config;
	nextConfig = await maybeAddTailnetOriginToControlUiAllowedOrigins({
		config: nextConfig,
		tailscaleMode,
		tailscaleBin
	});
	if (!quickstartGateway.hasExisting && nextConfig.gateway?.nodes?.denyCommands === void 0 && nextConfig.gateway?.nodes?.allowCommands === void 0 && nextConfig.gateway?.nodes?.browser === void 0) nextConfig = {
		...nextConfig,
		gateway: {
			...nextConfig.gateway,
			nodes: {
				...nextConfig.gateway?.nodes,
				denyCommands: [...DEFAULT_DANGEROUS_NODE_COMMANDS]
			}
		}
	};
	return {
		nextConfig,
		settings: {
			port,
			bind,
			customBindHost: bind === "custom" ? customBindHost : void 0,
			authMode,
			gatewayToken,
			tailscaleMode,
			tailscaleResetOnExit
		}
	};
}
//#endregion
export { configureGatewayForSetup };
