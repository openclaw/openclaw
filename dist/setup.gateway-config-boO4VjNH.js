import { d as normalizeSecretInputString, m as resolveSecretInputRef } from "./types.secrets-BxqheYvy.js";
import { a as findTailscaleBinary } from "./tailscale-Drn251l9.js";
import { t as randomToken } from "./random-token-BdabE9M7.js";
import { o as formatPortRangeHint } from "./error-format-ByBZDdph.js";
import { t as resolveSecretInputModeForEnvSelection } from "./provider-auth-mode-BTbGLgZT.js";
import { n as promptSecretRefForSetup } from "./provider-auth-ref-Ytsr5yIt.js";
import { t as DEFAULT_DANGEROUS_NODE_COMMANDS } from "./node-command-policy-rX_utHfg.js";
import { t as maskApiKey } from "./mask-api-key-CtiabOGN.js";
import { c as normalizeGatewayTokenInput, p as validateGatewayPasswordInput } from "./onboard-helpers-D5MK7ND9.js";
import { t as resolveSetupSecretInputString } from "./setup.secret-input-BE7C__Z7.js";
import { a as maybeAddTailnetOriginToControlUiAllowedOrigins, i as TAILSCALE_MISSING_BIN_NOTE_LINES, n as TAILSCALE_DOCS_LINES, r as TAILSCALE_EXPOSURE_OPTIONS, t as validateIPv4AddressInput } from "./ipv4-CQuNe1f5.js";
import { n as ensureControlUiAllowedOriginsForNonLoopbackBind } from "./gateway-control-ui-origins-B0oWiJ-k.js";
//#region src/wizard/setup.gateway-config.ts
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
		message: "Gateway port",
		initialValue: String(localPort),
		validate: validateGatewayPortInput
	})), 10);
	let bind = flow === "quickstart" ? quickstartGateway.bind : await prompter.select({
		message: "Gateway bind address",
		options: [
			{
				value: "loopback",
				label: "Loopback (127.0.0.1)",
				hint: "This machine only"
			},
			{
				value: "lan",
				label: "LAN (0.0.0.0)",
				hint: "Reachable on your local network"
			},
			{
				value: "tailnet",
				label: "Tailnet (Tailscale IP)",
				hint: "Reachable over Tailscale"
			},
			{
				value: "auto",
				label: "Auto (Loopback -> LAN)",
				hint: "Try loopback first"
			},
			{
				value: "custom",
				label: "Custom IP",
				hint: "Bind to one local address"
			}
		]
	});
	let customBindHost = quickstartGateway.customBindHost;
	if (bind === "custom") {
		if (flow !== "quickstart" || !customBindHost) {
			const input = await prompter.text({
				message: "Custom IP address",
				placeholder: "192.168.1.100",
				initialValue: customBindHost ?? "",
				validate: validateIPv4AddressInput
			});
			customBindHost = typeof input === "string" ? input.trim() : void 0;
		}
	}
	let authMode = flow === "quickstart" ? quickstartGateway.authMode : await prompter.select({
		message: "Gateway access protection",
		options: [{
			value: "token",
			label: "Token (recommended)",
			hint: "Recommended default (local + remote)"
		}, {
			value: "password",
			label: "Password"
		}],
		initialValue: "token"
	});
	const tailscaleMode = flow === "quickstart" ? quickstartGateway.tailscaleMode : await prompter.select({
		message: "Tailscale exposure",
		options: [...TAILSCALE_EXPOSURE_OPTIONS]
	});
	let tailscaleBin = null;
	if (tailscaleMode !== "off") {
		tailscaleBin = await findTailscaleBinary();
		if (!tailscaleBin) await prompter.note(TAILSCALE_MISSING_BIN_NOTE_LINES.join("\n"), "Tailscale Warning");
	}
	let tailscaleResetOnExit = flow === "quickstart" ? quickstartGateway.tailscaleResetOnExit : false;
	if (tailscaleMode !== "off" && flow !== "quickstart") {
		await prompter.note(TAILSCALE_DOCS_LINES.join("\n"), "Tailscale");
		tailscaleResetOnExit = await prompter.confirm({
			message: "Reset Tailscale serve/funnel on exit?",
			initialValue: false
		});
	}
	if (tailscaleMode !== "off" && bind !== "loopback") {
		await prompter.note("Tailscale exposure requires bind=loopback. I will switch the bind address to loopback.", "Gateway bind");
		bind = "loopback";
		customBindHost = void 0;
	}
	if (tailscaleMode === "funnel" && authMode !== "password") {
		await prompter.note("Tailscale Funnel requires password auth. I will switch Gateway auth to password.", "Gateway auth");
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
				modeMessage: "How do you want to provide the gateway token?",
				plaintextLabel: "Generate/store plaintext token",
				plaintextHint: "Default",
				refLabel: "Use SecretRef",
				refHint: "Store a reference instead of plaintext"
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
					sourceMessage: "Where is this gateway token stored?",
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
				message: `Use existing gateway token (${maskApiKey(existingToken)})?`,
				initialValue: true
			}) ? existingToken : await prompter.text({
				message: "Gateway token (blank to generate)",
				placeholder: "Needed for multi-machine or non-loopback access",
				sensitive: true
			});
			else tokenInput = await prompter.text({
				message: "Gateway token (blank to generate)",
				placeholder: "Needed for multi-machine or non-loopback access",
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
				modeMessage: "How do you want to provide the gateway password?",
				plaintextLabel: "Enter password now",
				plaintextHint: "Stores the password directly in OpenClaw config"
			}
		}) === "ref") password = (await promptSecretRefForSetup({
			provider: "gateway-auth-password",
			config: nextConfig,
			prompter,
			preferredEnvVar: "OPENCLAW_GATEWAY_PASSWORD",
			copy: {
				sourceMessage: "Where is this gateway password stored?",
				envVarPlaceholder: "OPENCLAW_GATEWAY_PASSWORD"
			}
		})).ref;
		else password = normalizeWizardTextInput(await prompter.text({
			message: "Gateway password",
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
