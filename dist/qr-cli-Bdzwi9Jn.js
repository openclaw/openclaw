import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { h as theme } from "./globals-DqM7Q4km.js";
import { u as resolveGatewayPort } from "./paths-BMo6kTge.js";
import { d as defaultRuntime } from "./subsystem-BXiL6bA6.js";
import { Et as isRfc1918Ipv4Address, lt as secretRefKey, x as resolveSecretRefValues, yt as isCarrierGradeNatIpv4Address, z as loadConfig } from "./auth-profiles-B1fxmUx1.js";
import { t as runCommandWithTimeout } from "./exec-BpP6Q4EB.js";
import { F as normalizeSecretInputString, L as resolveSecretInputRef, j as hasConfiguredSecretInput } from "./registry-DTmGzx3d.js";
import { t as assertExplicitGatewayAuthModeWhenBothConfigured } from "./auth-mode-policy-Df6weHId.js";
import { a as getQrRemoteCommandSecretTargetIds, s as resolveCommandSecretRefsViaGateway } from "./command-secret-targets-BR6DP2Oq.js";
import { t as formatDocsLink } from "./links-dO-svE2W.js";
import os from "node:os";
import qrcode from "qrcode-terminal";

//#region src/shared/gateway-bind-url.ts
function resolveGatewayBindUrl(params) {
	const bind = params.bind ?? "loopback";
	if (bind === "custom") {
		const host = params.customBindHost?.trim();
		if (host) return {
			url: `${params.scheme}://${host}:${params.port}`,
			source: "gateway.bind=custom"
		};
		return { error: "gateway.bind=custom requires gateway.customBindHost." };
	}
	if (bind === "tailnet") {
		const host = params.pickTailnetHost();
		if (host) return {
			url: `${params.scheme}://${host}:${params.port}`,
			source: "gateway.bind=tailnet"
		};
		return { error: "gateway.bind=tailnet set, but no tailnet IP was found." };
	}
	if (bind === "lan") {
		const host = params.pickLanHost();
		if (host) return {
			url: `${params.scheme}://${host}:${params.port}`,
			source: "gateway.bind=lan"
		};
		return { error: "gateway.bind=lan set, but no private LAN IP was found." };
	}
	return null;
}

//#endregion
//#region src/shared/tailscale-status.ts
const TAILSCALE_STATUS_COMMAND_CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
function parsePossiblyNoisyJsonObject(raw) {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return {};
	try {
		return JSON.parse(raw.slice(start, end + 1));
	} catch {
		return {};
	}
}
function extractTailnetHostFromStatusJson(raw) {
	const parsed = parsePossiblyNoisyJsonObject(raw);
	const self = typeof parsed.Self === "object" && parsed.Self !== null ? parsed.Self : void 0;
	const dns = typeof self?.DNSName === "string" ? self.DNSName : void 0;
	if (dns && dns.length > 0) return dns.replace(/\.$/, "");
	const ips = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs : [];
	return ips.length > 0 ? ips[0] ?? null : null;
}
async function resolveTailnetHostWithRunner(runCommandWithTimeout) {
	if (!runCommandWithTimeout) return null;
	for (const candidate of TAILSCALE_STATUS_COMMAND_CANDIDATES) try {
		const result = await runCommandWithTimeout([
			candidate,
			"status",
			"--json"
		], { timeoutMs: 5e3 });
		if (result.code !== 0) continue;
		const raw = result.stdout.trim();
		if (!raw) continue;
		const host = extractTailnetHostFromStatusJson(raw);
		if (host) return host;
	} catch {
		continue;
	}
	return null;
}

//#endregion
//#region src/pairing/setup-code.ts
function normalizeUrl(raw, schemeFallback) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	try {
		const parsed = new URL(trimmed);
		const scheme = parsed.protocol.replace(":", "");
		if (!scheme) return null;
		const resolvedScheme = scheme === "http" ? "ws" : scheme === "https" ? "wss" : scheme;
		if (resolvedScheme !== "ws" && resolvedScheme !== "wss") return null;
		const host = parsed.hostname;
		if (!host) return null;
		return `${resolvedScheme}://${host}${parsed.port ? `:${parsed.port}` : ""}`;
	} catch {}
	const withoutPath = trimmed.split("/")[0] ?? "";
	if (!withoutPath) return null;
	return `${schemeFallback}://${withoutPath}`;
}
function resolveScheme(cfg, opts) {
	if (opts?.forceSecure) return "wss";
	return cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
}
function isPrivateIPv4(address) {
	return isRfc1918Ipv4Address(address);
}
function isTailnetIPv4(address) {
	return isCarrierGradeNatIpv4Address(address);
}
function pickIPv4Matching(networkInterfaces, matches) {
	const nets = networkInterfaces();
	for (const entries of Object.values(nets)) {
		if (!entries) continue;
		for (const entry of entries) {
			const isIpv4 = entry?.family === "IPv4";
			if (!entry || entry.internal || !isIpv4) continue;
			const address = entry.address?.trim() ?? "";
			if (!address) continue;
			if (matches(address)) return address;
		}
	}
	return null;
}
function pickLanIPv4(networkInterfaces) {
	return pickIPv4Matching(networkInterfaces, isPrivateIPv4);
}
function pickTailnetIPv4(networkInterfaces) {
	return pickIPv4Matching(networkInterfaces, isTailnetIPv4);
}
function resolveAuth(cfg, env) {
	const mode = cfg.gateway?.auth?.mode;
	const defaults = cfg.secrets?.defaults;
	const tokenRef = resolveSecretInputRef({
		value: cfg.gateway?.auth?.token,
		defaults
	}).ref;
	const passwordRef = resolveSecretInputRef({
		value: cfg.gateway?.auth?.password,
		defaults
	}).ref;
	const token = env.OPENCLAW_GATEWAY_TOKEN?.trim() || env.CLAWDBOT_GATEWAY_TOKEN?.trim() || (tokenRef ? void 0 : normalizeSecretInputString(cfg.gateway?.auth?.token));
	const password = env.OPENCLAW_GATEWAY_PASSWORD?.trim() || env.CLAWDBOT_GATEWAY_PASSWORD?.trim() || (passwordRef ? void 0 : normalizeSecretInputString(cfg.gateway?.auth?.password));
	if (mode === "password") {
		if (!password) return { error: "Gateway auth is set to password, but no password is configured." };
		return {
			password,
			label: "password"
		};
	}
	if (mode === "token") {
		if (!token) return { error: "Gateway auth is set to token, but no token is configured." };
		return {
			token,
			label: "token"
		};
	}
	if (token) return {
		token,
		label: "token"
	};
	if (password) return {
		password,
		label: "password"
	};
	return { error: "Gateway auth is not configured (no token or password)." };
}
async function resolveGatewayTokenSecretRef(cfg, env) {
	const authToken = cfg.gateway?.auth?.token;
	const { ref } = resolveSecretInputRef({
		value: authToken,
		defaults: cfg.secrets?.defaults
	});
	if (!ref) return cfg;
	if (Boolean(env.OPENCLAW_GATEWAY_TOKEN?.trim() || env.CLAWDBOT_GATEWAY_TOKEN?.trim())) return cfg;
	const mode = cfg.gateway?.auth?.mode;
	if (mode === "password" || mode === "none" || mode === "trusted-proxy") return cfg;
	if (mode !== "token") {
		if (Boolean(env.OPENCLAW_GATEWAY_PASSWORD?.trim() || env.CLAWDBOT_GATEWAY_PASSWORD?.trim())) return cfg;
	}
	const value = (await resolveSecretRefValues([ref], {
		config: cfg,
		env
	})).get(secretRefKey(ref));
	if (typeof value !== "string" || value.trim().length === 0) throw new Error("gateway.auth.token resolved to an empty or non-string value.");
	return {
		...cfg,
		gateway: {
			...cfg.gateway,
			auth: {
				...cfg.gateway?.auth,
				token: value.trim()
			}
		}
	};
}
async function resolveGatewayPasswordSecretRef(cfg, env) {
	const authPassword = cfg.gateway?.auth?.password;
	const { ref } = resolveSecretInputRef({
		value: authPassword,
		defaults: cfg.secrets?.defaults
	});
	if (!ref) return cfg;
	if (Boolean(env.OPENCLAW_GATEWAY_PASSWORD?.trim() || env.CLAWDBOT_GATEWAY_PASSWORD?.trim())) return cfg;
	const mode = cfg.gateway?.auth?.mode;
	if (mode === "token" || mode === "none" || mode === "trusted-proxy") return cfg;
	if (mode !== "password") {
		if (Boolean(env.OPENCLAW_GATEWAY_TOKEN?.trim() || env.CLAWDBOT_GATEWAY_TOKEN?.trim()) || hasConfiguredSecretInput(cfg.gateway?.auth?.token, cfg.secrets?.defaults)) return cfg;
	}
	const value = (await resolveSecretRefValues([ref], {
		config: cfg,
		env
	})).get(secretRefKey(ref));
	if (typeof value !== "string" || value.trim().length === 0) throw new Error("gateway.auth.password resolved to an empty or non-string value.");
	return {
		...cfg,
		gateway: {
			...cfg.gateway,
			auth: {
				...cfg.gateway?.auth,
				password: value.trim()
			}
		}
	};
}
async function resolveGatewayUrl(cfg, opts) {
	const scheme = resolveScheme(cfg, { forceSecure: opts.forceSecure });
	const port = resolveGatewayPort(cfg, opts.env);
	if (typeof opts.publicUrl === "string" && opts.publicUrl.trim()) {
		const url = normalizeUrl(opts.publicUrl, scheme);
		if (url) return {
			url,
			source: "plugins.entries.device-pair.config.publicUrl"
		};
		return { error: "Configured publicUrl is invalid." };
	}
	const remoteUrlRaw = cfg.gateway?.remote?.url;
	const remoteUrl = typeof remoteUrlRaw === "string" && remoteUrlRaw.trim() ? normalizeUrl(remoteUrlRaw, scheme) : null;
	if (opts.preferRemoteUrl && remoteUrl) return {
		url: remoteUrl,
		source: "gateway.remote.url"
	};
	const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
	if (tailscaleMode === "serve" || tailscaleMode === "funnel") {
		const host = await resolveTailnetHostWithRunner(opts.runCommandWithTimeout);
		if (!host) return { error: "Tailscale Serve is enabled, but MagicDNS could not be resolved." };
		return {
			url: `wss://${host}`,
			source: `gateway.tailscale.mode=${tailscaleMode}`
		};
	}
	if (remoteUrl) return {
		url: remoteUrl,
		source: "gateway.remote.url"
	};
	const bindResult = resolveGatewayBindUrl({
		bind: cfg.gateway?.bind,
		customBindHost: cfg.gateway?.customBindHost,
		scheme,
		port,
		pickTailnetHost: () => pickTailnetIPv4(opts.networkInterfaces),
		pickLanHost: () => pickLanIPv4(opts.networkInterfaces)
	});
	if (bindResult) return bindResult;
	return { error: "Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl." };
}
function encodePairingSetupCode(payload) {
	const json = JSON.stringify(payload);
	return Buffer.from(json, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function resolvePairingSetupFromConfig(cfg, options = {}) {
	assertExplicitGatewayAuthModeWhenBothConfigured(cfg);
	const env = options.env ?? process.env;
	const cfgForAuth = await resolveGatewayPasswordSecretRef(await resolveGatewayTokenSecretRef(cfg, env), env);
	const auth = resolveAuth(cfgForAuth, env);
	if (auth.error) return {
		ok: false,
		error: auth.error
	};
	const urlResult = await resolveGatewayUrl(cfgForAuth, {
		env,
		publicUrl: options.publicUrl,
		preferRemoteUrl: options.preferRemoteUrl,
		forceSecure: options.forceSecure,
		runCommandWithTimeout: options.runCommandWithTimeout,
		networkInterfaces: options.networkInterfaces ?? os.networkInterfaces
	});
	if (!urlResult.url) return {
		ok: false,
		error: urlResult.error ?? "Gateway URL unavailable."
	};
	if (!auth.label) return {
		ok: false,
		error: "Gateway auth is not configured (no token or password)."
	};
	return {
		ok: true,
		payload: {
			url: urlResult.url,
			token: auth.token,
			password: auth.password
		},
		authLabel: auth.label,
		urlSource: urlResult.source ?? "unknown"
	};
}

//#endregion
//#region src/cli/qr-cli.ts
var qr_cli_exports = /* @__PURE__ */ __exportAll({ registerQrCli: () => registerQrCli });
function renderQrAscii(data) {
	return new Promise((resolve) => {
		qrcode.generate(data, { small: true }, (output) => {
			resolve(output);
		});
	});
}
function readDevicePairPublicUrlFromConfig(cfg) {
	const value = cfg.plugins?.entries?.["device-pair"]?.config?.["publicUrl"];
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function readGatewayTokenEnv(env) {
	const primary = typeof env.OPENCLAW_GATEWAY_TOKEN === "string" ? env.OPENCLAW_GATEWAY_TOKEN : "";
	if (primary.trim().length > 0) return primary.trim();
	const legacy = typeof env.CLAWDBOT_GATEWAY_TOKEN === "string" ? env.CLAWDBOT_GATEWAY_TOKEN : "";
	if (legacy.trim().length > 0) return legacy.trim();
}
function readGatewayPasswordEnv(env) {
	const primary = typeof env.OPENCLAW_GATEWAY_PASSWORD === "string" ? env.OPENCLAW_GATEWAY_PASSWORD : "";
	if (primary.trim().length > 0) return primary.trim();
	const legacy = typeof env.CLAWDBOT_GATEWAY_PASSWORD === "string" ? env.CLAWDBOT_GATEWAY_PASSWORD : "";
	if (legacy.trim().length > 0) return legacy.trim();
}
function shouldResolveLocalGatewayPasswordSecret(cfg, env) {
	if (readGatewayPasswordEnv(env)) return false;
	const authMode = cfg.gateway?.auth?.mode;
	if (authMode === "password") return true;
	if (authMode === "token" || authMode === "none" || authMode === "trusted-proxy") return false;
	const envToken = readGatewayTokenEnv(env);
	const configTokenConfigured = hasConfiguredSecretInput(cfg.gateway?.auth?.token, cfg.secrets?.defaults);
	return !envToken && !configTokenConfigured;
}
async function resolveLocalGatewayPasswordSecretIfNeeded(cfg) {
	const authPassword = cfg.gateway?.auth?.password;
	const { ref } = resolveSecretInputRef({
		value: authPassword,
		defaults: cfg.secrets?.defaults
	});
	if (!ref) return;
	const value = (await resolveSecretRefValues([ref], {
		config: cfg,
		env: process.env
	})).get(secretRefKey(ref));
	if (typeof value !== "string" || value.trim().length === 0) throw new Error("gateway.auth.password resolved to an empty or non-string value.");
	if (!cfg.gateway?.auth) return;
	cfg.gateway.auth.password = value.trim();
}
function emitQrSecretResolveDiagnostics(diagnostics, opts) {
	if (diagnostics.length === 0) return;
	const toStderr = opts.json === true || opts.setupCodeOnly === true;
	for (const entry of diagnostics) {
		const message = theme.warn(`[secrets] ${entry}`);
		if (toStderr) defaultRuntime.error(message);
		else defaultRuntime.log(message);
	}
}
function registerQrCli(program) {
	program.command("qr").description("Generate an iOS pairing QR code and setup code").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/qr", "docs.openclaw.ai/cli/qr")}\n`).option("--remote", "Use gateway.remote.url and gateway.remote token/password (ignores device-pair publicUrl)", false).option("--url <url>", "Override gateway URL used in the setup payload").option("--public-url <url>", "Override gateway public URL used in the setup payload").option("--token <token>", "Override gateway token for setup payload").option("--password <password>", "Override gateway password for setup payload").option("--setup-code-only", "Print only the setup code", false).option("--no-ascii", "Skip ASCII QR rendering").option("--json", "Output JSON", false).action(async (opts) => {
		try {
			if (opts.token && opts.password) throw new Error("Use either --token or --password, not both.");
			const token = typeof opts.token === "string" ? opts.token.trim() : "";
			const password = typeof opts.password === "string" ? opts.password.trim() : "";
			const wantsRemote = opts.remote === true;
			const loadedRaw = loadConfig();
			if (wantsRemote && !opts.url && !opts.publicUrl) {
				const tailscaleMode = loadedRaw.gateway?.tailscale?.mode ?? "off";
				const remoteUrl = loadedRaw.gateway?.remote?.url;
				if (!(typeof remoteUrl === "string" && remoteUrl.trim().length > 0) && !(tailscaleMode === "serve" || tailscaleMode === "funnel")) throw new Error("qr --remote requires gateway.remote.url (or gateway.tailscale.mode=serve/funnel).");
			}
			let loaded = loadedRaw;
			let remoteDiagnostics = [];
			if (wantsRemote && !token && !password) {
				const resolvedRemote = await resolveCommandSecretRefsViaGateway({
					config: loadedRaw,
					commandName: "qr --remote",
					targetIds: getQrRemoteCommandSecretTargetIds()
				});
				loaded = resolvedRemote.resolvedConfig;
				remoteDiagnostics = resolvedRemote.diagnostics;
			}
			const cfg = {
				...loaded,
				gateway: {
					...loaded.gateway,
					auth: { ...loaded.gateway?.auth }
				}
			};
			emitQrSecretResolveDiagnostics(remoteDiagnostics, opts);
			if (token) {
				cfg.gateway.auth.mode = "token";
				cfg.gateway.auth.token = token;
				cfg.gateway.auth.password = void 0;
			}
			if (password) {
				cfg.gateway.auth.mode = "password";
				cfg.gateway.auth.password = password;
				cfg.gateway.auth.token = void 0;
			}
			if (wantsRemote && !token && !password) {
				const remoteToken = typeof cfg.gateway?.remote?.token === "string" ? cfg.gateway.remote.token.trim() : "";
				const remotePassword = typeof cfg.gateway?.remote?.password === "string" ? cfg.gateway.remote.password.trim() : "";
				if (remoteToken) {
					cfg.gateway.auth.mode = "token";
					cfg.gateway.auth.token = remoteToken;
					cfg.gateway.auth.password = void 0;
				} else if (remotePassword) {
					cfg.gateway.auth.mode = "password";
					cfg.gateway.auth.password = remotePassword;
					cfg.gateway.auth.token = void 0;
				}
			}
			if (!wantsRemote && !password && !token && shouldResolveLocalGatewayPasswordSecret(cfg, process.env)) await resolveLocalGatewayPasswordSecretIfNeeded(cfg);
			const resolved = await resolvePairingSetupFromConfig(cfg, {
				publicUrl: (typeof opts.url === "string" && opts.url.trim() ? opts.url.trim() : typeof opts.publicUrl === "string" && opts.publicUrl.trim() ? opts.publicUrl.trim() : void 0) ?? (wantsRemote ? void 0 : readDevicePairPublicUrlFromConfig(cfg)),
				preferRemoteUrl: wantsRemote,
				runCommandWithTimeout: async (argv, runOpts) => await runCommandWithTimeout(argv, { timeoutMs: runOpts.timeoutMs })
			});
			if (!resolved.ok) throw new Error(resolved.error);
			const setupCode = encodePairingSetupCode(resolved.payload);
			if (opts.setupCodeOnly) {
				defaultRuntime.log(setupCode);
				return;
			}
			if (opts.json) {
				defaultRuntime.log(JSON.stringify({
					setupCode,
					gatewayUrl: resolved.payload.url,
					auth: resolved.authLabel,
					urlSource: resolved.urlSource
				}, null, 2));
				return;
			}
			const lines = [
				theme.heading("Pairing QR"),
				"Scan this with the OpenClaw iOS app (Onboarding -> Scan QR).",
				""
			];
			if (opts.ascii !== false) {
				const qrAscii = await renderQrAscii(setupCode);
				lines.push(qrAscii.trimEnd(), "");
			}
			lines.push(`${theme.muted("Setup code:")} ${setupCode}`, `${theme.muted("Gateway:")} ${resolved.payload.url}`, `${theme.muted("Auth:")} ${resolved.authLabel}`, `${theme.muted("Source:")} ${resolved.urlSource}`, "", "Approve after scan with:", `  ${theme.command("openclaw devices list")}`, `  ${theme.command("openclaw devices approve <requestId>")}`);
			defaultRuntime.log(lines.join("\n"));
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	});
}

//#endregion
export { registerQrCli as n, qr_cli_exports as t };