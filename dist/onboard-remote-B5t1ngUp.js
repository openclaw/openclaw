import { s as isSecureWebSocketUrl } from "./net-Gkm1Cz9b.js";
import { t as resolveSecretInputModeForEnvSelection } from "./provider-auth-mode-BTbGLgZT.js";
import { n as promptSecretRefForSetup } from "./provider-auth-ref-Ytsr5yIt.js";
import { t as detectBinary } from "./detect-binary-D0DCWl0p.js";
import { t as maskApiKey } from "./mask-api-key-CtiabOGN.js";
import { i as resolveWideAreaDiscoveryDomain } from "./widearea-dns-CtG3ymb9.js";
import { t as discoverGatewayBeacons } from "./bonjour-discovery-BENm8CI2.js";
import { n as buildGatewayDiscoveryTarget, t as buildGatewayDiscoveryLabel } from "./gateway-discovery-targets-V6k4Zgel.js";
import "./onboard-helpers-D5MK7ND9.js";
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
	if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) return "URL must start with ws:// or wss://";
	if (!isSecureWebSocketUrl(trimmed, { allowPrivateWs: process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1" })) return "Use wss:// for remote hosts, or ws://127.0.0.1/localhost via SSH tunnel. Break-glass: OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 for trusted private networks.";
}
async function promptRemoteGatewayConfig(cfg, prompter, options) {
	let selectedBeacon = null;
	let suggestedUrl = cfg.gateway?.remote?.url ?? DEFAULT_GATEWAY_URL;
	let discoveryTlsFingerprint;
	let trustedDiscoveryUrl;
	const hasBonjourTool = await detectBinary("dns-sd") || await detectBinary("avahi-browse");
	const wantsDiscover = hasBonjourTool ? await prompter.confirm({
		message: "Discover gateway on LAN (Bonjour)?",
		initialValue: true
	}) : false;
	if (!hasBonjourTool) await prompter.note(["Bonjour discovery requires dns-sd (macOS) or avahi-browse (Linux).", "Docs: https://docs.openclaw.ai/gateway/discovery"].join("\n"), "Discovery");
	if (wantsDiscover) {
		const wideAreaDomain = resolveWideAreaDiscoveryDomain({ configDomain: cfg.discovery?.wideArea?.domain });
		const spin = prompter.progress("Searching for gateways…");
		const beacons = await discoverGatewayBeacons({
			timeoutMs: 2e3,
			wideAreaDomain
		});
		spin.stop(beacons.length > 0 ? `Found ${beacons.length} gateway(s)` : "No gateways found");
		if (beacons.length > 0) {
			const selection = await prompter.select({
				message: "Select gateway",
				options: [...beacons.map((beacon, index) => ({
					value: String(index),
					label: buildLabel(beacon)
				})), {
					value: "manual",
					label: "Enter URL manually"
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
				message: "Connection method",
				options: [{
					value: "direct",
					label: `Direct gateway WS (${host}:${port})`
				}, {
					value: "ssh",
					label: "SSH tunnel (loopback)"
				}]
			}) === "direct") {
				suggestedUrl = `wss://${host}:${port}`;
				const fingerprint = target.endpoint.gatewayTlsFingerprintSha256;
				if (await prompter.confirm({
					message: `Trust this gateway? Host: ${host}:${port} TLS fingerprint: ${fingerprint ?? "not advertised (connection will not be pinned)"}`,
					initialValue: false
				})) {
					discoveryTlsFingerprint = fingerprint;
					trustedDiscoveryUrl = suggestedUrl;
					await prompter.note([
						"Direct remote access defaults to TLS.",
						`Using: ${suggestedUrl}`,
						...fingerprint ? [`TLS pin: ${fingerprint}`] : [],
						"If your gateway is loopback-only, choose SSH tunnel and keep ws://127.0.0.1:18789."
					].join("\n"), "Direct remote");
				} else suggestedUrl = DEFAULT_GATEWAY_URL;
			} else {
				suggestedUrl = DEFAULT_GATEWAY_URL;
				await prompter.note([
					"Start a tunnel before using the CLI:",
					`ssh -N -L 18789:127.0.0.1:18789 <user>@${host}${target.sshPort ? ` -p ${target.sshPort}` : ""}`,
					"Docs: https://docs.openclaw.ai/gateway/remote"
				].join("\n"), "SSH tunnel");
			}
		}
	}
	const url = ensureWsUrl(await prompter.text({
		message: "Gateway WebSocket URL",
		initialValue: suggestedUrl,
		validate: (value) => validateGatewayWebSocketUrl(value)
	}));
	const pinnedDiscoveryFingerprint = discoveryTlsFingerprint && url === trustedDiscoveryUrl ? discoveryTlsFingerprint : void 0;
	const authChoice = await prompter.select({
		message: "Gateway auth",
		options: [
			{
				value: "token",
				label: "Token (recommended)"
			},
			{
				value: "password",
				label: "Password"
			},
			{
				value: "off",
				label: "No auth"
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
				modeMessage: "How do you want to provide this gateway token?",
				plaintextLabel: "Enter token now",
				plaintextHint: "Stores the token directly in OpenClaw config"
			}
		}) === "ref") token = (await promptSecretRefForSetup({
			provider: "gateway-remote-token",
			config: cfg,
			prompter,
			preferredEnvVar: "OPENCLAW_GATEWAY_TOKEN",
			copy: {
				sourceMessage: "Where is this gateway token stored?",
				envVarPlaceholder: "OPENCLAW_GATEWAY_TOKEN"
			}
		})).ref;
		else {
			const existingToken = typeof token === "string" ? token : void 0;
			if (existingToken && await prompter.confirm({
				message: `Use existing gateway token (${maskApiKey(existingToken)})?`,
				initialValue: true
			})) token = existingToken;
			else token = (await prompter.text({
				message: "Gateway token",
				validate: (value) => value?.trim() ? void 0 : "Required",
				sensitive: true
			})).trim();
		}
		password = void 0;
	} else if (authChoice === "password") {
		if (await resolveSecretInputModeForEnvSelection({
			prompter,
			explicitMode: options?.secretInputMode,
			copy: {
				modeMessage: "How do you want to provide this gateway password?",
				plaintextLabel: "Enter password now",
				plaintextHint: "Stores the password directly in OpenClaw config"
			}
		}) === "ref") password = (await promptSecretRefForSetup({
			provider: "gateway-remote-password",
			config: cfg,
			prompter,
			preferredEnvVar: "OPENCLAW_GATEWAY_PASSWORD",
			copy: {
				sourceMessage: "Where is this gateway password stored?",
				envVarPlaceholder: "OPENCLAW_GATEWAY_PASSWORD"
			}
		})).ref;
		else {
			const existingPassword = typeof password === "string" ? password : void 0;
			if (existingPassword && await prompter.confirm({
				message: `Use existing gateway password (${maskApiKey(existingPassword)})?`,
				initialValue: true
			})) password = existingPassword;
			else password = (await prompter.text({
				message: "Gateway password",
				validate: (value) => value?.trim() ? void 0 : "Required",
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
