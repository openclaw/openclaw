import { s as isSecureWebSocketUrl } from "./net-DCUMtgJy.js";
import { t as resolveSecretInputModeForEnvSelection } from "./provider-auth-mode-pYim_v-q.js";
import { n as promptSecretRefForSetup } from "./provider-auth-ref-jlzCUrxx.js";
import { n as t } from "./i18n-CWNhN747.js";
import { t as detectBinary } from "./detect-binary-C4HxcF68.js";
import { t as maskApiKey } from "./mask-api-key-CbfeqQaR.js";
import { i as resolveWideAreaDiscoveryDomain } from "./widearea-dns-CxmrR0V1.js";
import "./onboard-helpers-BaLdeEkj.js";
import { t as discoverGatewayBeacons } from "./bonjour-discovery-DJOeAqVy.js";
import { n as buildGatewayDiscoveryTarget, t as buildGatewayDiscoveryLabel } from "./gateway-discovery-targets-FNcBbrXr.js";
//#region src/commands/onboard-remote.ts
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
function buildLabel(beacon) {
	return buildGatewayDiscoveryLabel(beacon);
}
function ensureWsUrl(value) {
	const trimmed = value.trim();
	if (!trimmed) return DEFAULT_GATEWAY_URL;
	return trimmed;
}
function validateGatewayWebSocketUrl(value) {
	const trimmed = value.trim();
	if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) return t("wizard.remote.validWebSocketUrl");
	if (!isSecureWebSocketUrl(trimmed, { allowPrivateWs: process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1" })) return t("wizard.remote.insecureRemoteUrl");
}
async function promptRemoteGatewayConfig(cfg, prompter, options) {
	let selectedBeacon = null;
	let suggestedUrl = cfg.gateway?.remote?.url ?? DEFAULT_GATEWAY_URL;
	let discoveryTlsFingerprint;
	let trustedDiscoveryUrl;
	const hasBonjourTool = await detectBinary("dns-sd") || await detectBinary("avahi-browse");
	const wantsDiscover = hasBonjourTool ? await prompter.confirm({
		message: t("wizard.remote.bonjour"),
		initialValue: true
	}) : false;
	if (!hasBonjourTool) await prompter.note(["Bonjour discovery requires dns-sd (macOS) or avahi-browse (Linux).", "Docs: https://docs.openclaw.ai/gateway/discovery"].join("\n"), "Discovery");
	if (wantsDiscover) {
		const wideAreaDomain = resolveWideAreaDiscoveryDomain({ configDomain: cfg.discovery?.wideArea?.domain });
		const spin = prompter.progress(t("wizard.remote.searchProgress"));
		const beacons = await discoverGatewayBeacons({
			timeoutMs: 2e3,
			wideAreaDomain
		});
		spin.stop(beacons.length > 0 ? t("wizard.remote.foundGateways", { count: beacons.length }) : t("wizard.remote.noGatewaysFound"));
		if (beacons.length > 0) {
			const selection = await prompter.select({
				message: t("wizard.remote.selectGateway"),
				options: [...beacons.map((beacon, index) => ({
					value: String(index),
					label: buildLabel(beacon)
				})), {
					value: "manual",
					label: t("wizard.remote.enterUrlManually")
				}]
			});
			if (selection !== "manual") {
				const idx = Number.parseInt(selection, 10);
				selectedBeacon = Number.isFinite(idx) ? beacons[idx] ?? null : null;
			}
		}
	}
	if (selectedBeacon) {
		const target = buildGatewayDiscoveryTarget(selectedBeacon);
		if (target.endpoint) {
			const { host, port } = target.endpoint;
			if (await prompter.select({
				message: t("wizard.remote.connectionMethod"),
				options: [{
					value: "direct",
					label: `Direct gateway WS (${host}:${port})`
				}, {
					value: "ssh",
					label: t("wizard.remote.sshTunnel")
				}]
			}) === "direct") {
				suggestedUrl = `wss://${host}:${port}`;
				const fingerprint = target.endpoint.gatewayTlsFingerprintSha256;
				if (await prompter.confirm({
					message: t("wizard.remote.trustGateway", {
						host: `${host}:${port}`,
						fingerprint: fingerprint ?? t("wizard.remote.fingerprintMissing")
					}),
					initialValue: false
				})) {
					discoveryTlsFingerprint = fingerprint;
					trustedDiscoveryUrl = suggestedUrl;
					await prompter.note([
						t("wizard.remote.directDefaultsTls"),
						`Using: ${suggestedUrl}`,
						...fingerprint ? [`TLS pin: ${fingerprint}`] : [],
						t("wizard.remote.loopbackSshHint")
					].join("\n"), t("wizard.remote.directAccessTitle"));
				} else suggestedUrl = DEFAULT_GATEWAY_URL;
			} else {
				suggestedUrl = DEFAULT_GATEWAY_URL;
				await prompter.note([
					"Start a tunnel before using the CLI:",
					`ssh -N -L 18789:127.0.0.1:18789 <user>@${host}${target.sshPort ? ` -p ${target.sshPort}` : ""}`,
					"Docs: https://docs.openclaw.ai/gateway/remote"
				].join("\n"), t("wizard.remote.sshTunnelTitle"));
			}
		}
	}
	const url = ensureWsUrl(await prompter.text({
		message: t("wizard.remote.websocketUrl"),
		initialValue: suggestedUrl,
		validate: (value) => validateGatewayWebSocketUrl(value)
	}));
	const pinnedDiscoveryFingerprint = discoveryTlsFingerprint && url === trustedDiscoveryUrl ? discoveryTlsFingerprint : void 0;
	const authChoice = await prompter.select({
		message: t("wizard.remote.auth"),
		options: [
			{
				value: "token",
				label: t("common.tokenRecommended")
			},
			{
				value: "password",
				label: t("common.password")
			},
			{
				value: "off",
				label: t("common.noAuth")
			}
		]
	});
	let token = cfg.gateway?.remote?.token;
	let password = cfg.gateway?.remote?.password;
	if (authChoice === "token") {
		if (await resolveSecretInputModeForEnvSelection({
			prompter,
			explicitMode: options?.secretInputMode,
			copy: {
				modeMessage: t("wizard.gateway.remoteTokenMode"),
				plaintextLabel: t("wizard.remote.plaintextTokenLabel"),
				plaintextHint: t("wizard.remote.plaintextTokenHint")
			}
		}) === "ref") token = (await promptSecretRefForSetup({
			provider: "gateway-remote-token",
			config: cfg,
			prompter,
			preferredEnvVar: "OPENCLAW_GATEWAY_TOKEN",
			copy: {
				sourceMessage: t("wizard.remote.gatewayTokenStoredMessage"),
				envVarPlaceholder: "OPENCLAW_GATEWAY_TOKEN"
			}
		})).ref;
		else {
			const existingToken = typeof token === "string" ? token : void 0;
			if (existingToken && await prompter.confirm({
				message: t("wizard.gateway.existingTokenConfirm", { token: maskApiKey(existingToken) }),
				initialValue: true
			})) token = existingToken;
			else token = (await prompter.text({
				message: t("wizard.remote.tokenPrompt"),
				validate: (value) => value?.trim() ? void 0 : t("common.required"),
				sensitive: true
			})).trim();
		}
		password = void 0;
	} else if (authChoice === "password") {
		if (await resolveSecretInputModeForEnvSelection({
			prompter,
			explicitMode: options?.secretInputMode,
			copy: {
				modeMessage: t("wizard.gateway.remotePasswordMode"),
				plaintextLabel: t("wizard.remote.plaintextPasswordLabel"),
				plaintextHint: t("wizard.remote.plaintextPasswordHint")
			}
		}) === "ref") password = (await promptSecretRefForSetup({
			provider: "gateway-remote-password",
			config: cfg,
			prompter,
			preferredEnvVar: "OPENCLAW_GATEWAY_PASSWORD",
			copy: {
				sourceMessage: t("wizard.remote.gatewayPasswordStoredMessage"),
				envVarPlaceholder: "OPENCLAW_GATEWAY_PASSWORD"
			}
		})).ref;
		else {
			const existingPassword = typeof password === "string" ? password : void 0;
			if (existingPassword && await prompter.confirm({
				message: t("wizard.gateway.existingPasswordConfirm", { password: maskApiKey(existingPassword) }),
				initialValue: true
			})) password = existingPassword;
			else password = (await prompter.text({
				message: t("wizard.remote.passwordPrompt"),
				validate: (value) => value?.trim() ? void 0 : t("common.required"),
				sensitive: true
			})).trim();
		}
		token = void 0;
	} else {
		token = void 0;
		password = void 0;
	}
	return {
		...cfg,
		gateway: {
			...cfg.gateway,
			mode: "remote",
			remote: {
				url,
				...token !== void 0 ? { token } : {},
				...password !== void 0 ? { password } : {},
				...pinnedDiscoveryFingerprint ? { tlsFingerprint: pinnedDiscoveryFingerprint } : {}
			}
		}
	};
}
//#endregion
export { promptRemoteGatewayConfig as t };
