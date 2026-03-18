import { C_ as promptSecretRefForSetup, Ju as detectBinary, w_ as resolveSecretInputModeForEnvSelection } from "./auth-profiles-DAOR1fRn.js";
import { o as isSecureWebSocketUrl } from "./device-metadata-normalization-a2oQYp64.js";
import { n as resolveWideAreaDiscoveryDomain } from "./widearea-dns-DVdQjuuE.js";
import { t as discoverGatewayBeacons } from "./bonjour-discovery-CTOMF9_m.js";
//#region src/commands/onboard-remote.ts
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
function pickHost(beacon) {
	return beacon.host || beacon.tailnetDns || beacon.lanHost;
}
function buildLabel(beacon) {
	const host = pickHost(beacon);
	const port = beacon.port ?? beacon.gatewayPort ?? 18789;
	return `${beacon.displayName ?? beacon.instanceName} (${host ? `${host}:${port}` : "host unknown"})`;
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
				const idx = Number.parseInt(String(selection), 10);
				selectedBeacon = Number.isFinite(idx) ? beacons[idx] ?? null : null;
			}
		}
	}
	if (selectedBeacon) {
		const host = pickHost(selectedBeacon);
		const port = selectedBeacon.port ?? selectedBeacon.gatewayPort ?? 18789;
		if (host) if (await prompter.select({
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
			await prompter.note([
				"Direct remote access defaults to TLS.",
				`Using: ${suggestedUrl}`,
				"If your gateway is loopback-only, choose SSH tunnel and keep ws://127.0.0.1:18789."
			].join("\n"), "Direct remote");
		} else {
			suggestedUrl = DEFAULT_GATEWAY_URL;
			await prompter.note([
				"Start a tunnel before using the CLI:",
				`ssh -N -L 18789:127.0.0.1:18789 <user>@${host}${selectedBeacon.sshPort ? ` -p ${selectedBeacon.sshPort}` : ""}`,
				"Docs: https://docs.openclaw.ai/gateway/remote"
			].join("\n"), "SSH tunnel");
		}
	}
	const urlInput = await prompter.text({
		message: "Gateway WebSocket URL",
		initialValue: suggestedUrl,
		validate: (value) => validateGatewayWebSocketUrl(String(value))
	});
	const url = ensureWsUrl(String(urlInput));
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
		else token = String(await prompter.text({
			message: "Gateway token",
			initialValue: typeof token === "string" ? token : void 0,
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim();
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
		else password = String(await prompter.text({
			message: "Gateway password",
			initialValue: typeof password === "string" ? password : void 0,
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim();
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
				...password !== void 0 ? { password } : {}
			}
		}
	};
}
//#endregion
export { promptRemoteGatewayConfig as t };
