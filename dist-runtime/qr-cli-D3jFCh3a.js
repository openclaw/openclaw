import { u as resolveGatewayPort } from "./paths-1qR_mW4i.js";
import { r as theme } from "./theme-UkqnBJaj.js";
import { l as defaultRuntime } from "./subsystem-EnljYYs1.js";
import { t as formatDocsLink } from "./links-Cx-Xmp-Y.js";
import { $y as resolveRequiredConfiguredSecretRefInputString, Bb as loadConfig, Ha as resolveCommandSecretRefsViaGateway, ib as assertExplicitGatewayAuthModeWhenBothConfigured } from "./auth-profiles-DqxBs6Au.js";
import { a as hasConfiguredSecretInput, d as resolveSecretInputRef, l as normalizeSecretInputString } from "./types.secrets-CgNgVfYE.js";
import { t as runCommandWithTimeout } from "./exec-Fh3CK0qE.js";
import { C as readGatewayPasswordEnv, w as readGatewayTokenEnv } from "./config-VO8zzMSR.js";
import { a as isCarrierGradeNatIpv4Address, f as isRfc1918Ipv4Address } from "./ip-Cdtea-sx.js";
import { a as getQrRemoteCommandSecretTargetIds } from "./command-secret-targets-7sQA1Mwd.js";
import { n as resolveGatewayBindUrl, t as resolveTailnetHostWithRunner } from "./tailscale-status-CFWRCoZk.js";
import { t as issueDeviceBootstrapToken } from "./device-bootstrap-CKQ4DI9B.js";
import os from "node:os";
import qrcode from "qrcode-terminal";
//#region src/pairing/setup-code.ts
function normalizeUrl(raw, schemeFallback) {
	const trimmed = raw.trim();
	if (!trimmed) {return null;}
	try {
		const parsed = new URL(trimmed);
		const scheme = parsed.protocol.replace(":", "");
		if (!scheme) {return null;}
		const resolvedScheme = scheme === "http" ? "ws" : scheme === "https" ? "wss" : scheme;
		if (resolvedScheme !== "ws" && resolvedScheme !== "wss") {return null;}
		const host = parsed.hostname;
		if (!host) {return null;}
		return `${resolvedScheme}://${host}${parsed.port ? `:${parsed.port}` : ""}`;
	} catch {}
	const withoutPath = trimmed.split("/")[0] ?? "";
	if (!withoutPath) {return null;}
	return `${schemeFallback}://${withoutPath}`;
}
function resolveScheme(cfg, opts) {
	if (opts?.forceSecure) {return "wss";}
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
		if (!entries) {continue;}
		for (const entry of entries) {
			const isIpv4 = entry?.family === "IPv4";
			if (!entry || entry.internal || !isIpv4) {continue;}
			const address = entry.address?.trim() ?? "";
			if (!address) {continue;}
			if (matches(address)) {return address;}
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
function resolveGatewayTokenFromEnv(env) {
	return env.OPENCLAW_GATEWAY_TOKEN?.trim() || env.CLAWDBOT_GATEWAY_TOKEN?.trim() || void 0;
}
function resolveGatewayPasswordFromEnv(env) {
	return env.OPENCLAW_GATEWAY_PASSWORD?.trim() || env.CLAWDBOT_GATEWAY_PASSWORD?.trim() || void 0;
}
function resolvePairingSetupAuthLabel(cfg, env) {
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
	const envToken = resolveGatewayTokenFromEnv(env);
	const envPassword = resolveGatewayPasswordFromEnv(env);
	const token = envToken || (tokenRef ? void 0 : normalizeSecretInputString(cfg.gateway?.auth?.token));
	const password = envPassword || (passwordRef ? void 0 : normalizeSecretInputString(cfg.gateway?.auth?.password));
	if (mode === "password") {
		if (!password) {return { error: "Gateway auth is set to password, but no password is configured." };}
		return { label: "password" };
	}
	if (mode === "token") {
		if (!token) {return { error: "Gateway auth is set to token, but no token is configured." };}
		return { label: "token" };
	}
	if (token) {return { label: "token" };}
	if (password) {return { label: "password" };}
	return { error: "Gateway auth is not configured (no token or password)." };
}
async function resolveGatewayTokenSecretRef(cfg, env) {
	if (resolveGatewayTokenFromEnv(env)) {return cfg;}
	const mode = cfg.gateway?.auth?.mode;
	if (mode === "password" || mode === "none" || mode === "trusted-proxy") {return cfg;}
	if (mode !== "token") {
		if (env.OPENCLAW_GATEWAY_PASSWORD?.trim() || env.CLAWDBOT_GATEWAY_PASSWORD?.trim()) {return cfg;}
	}
	const token = await resolveRequiredConfiguredSecretRefInputString({
		config: cfg,
		env,
		value: cfg.gateway?.auth?.token,
		path: "gateway.auth.token"
	});
	if (!token) {return cfg;}
	return {
		...cfg,
		gateway: {
			...cfg.gateway,
			auth: {
				...cfg.gateway?.auth,
				token
			}
		}
	};
}
async function resolveGatewayPasswordSecretRef(cfg, env) {
	if (resolveGatewayPasswordFromEnv(env)) {return cfg;}
	const mode = cfg.gateway?.auth?.mode;
	if (mode === "token" || mode === "none" || mode === "trusted-proxy") {return cfg;}
	if (mode !== "password") {
		if (Boolean(resolveGatewayTokenFromEnv(env)) || hasConfiguredSecretInput(cfg.gateway?.auth?.token, cfg.secrets?.defaults)) {return cfg;}
	}
	const password = await resolveRequiredConfiguredSecretRefInputString({
		config: cfg,
		env,
		value: cfg.gateway?.auth?.password,
		path: "gateway.auth.password"
	});
	if (!password) {return cfg;}
	return {
		...cfg,
		gateway: {
			...cfg.gateway,
			auth: {
				...cfg.gateway?.auth,
				password
			}
		}
	};
}
async function materializePairingSetupAuthConfig(cfg, env) {
	return await resolveGatewayPasswordSecretRef(await resolveGatewayTokenSecretRef(cfg, env), env);
}
async function resolveGatewayUrl(cfg, opts) {
	const scheme = resolveScheme(cfg, { forceSecure: opts.forceSecure });
	const port = resolveGatewayPort(cfg, opts.env);
	if (typeof opts.publicUrl === "string" && opts.publicUrl.trim()) {
		const url = normalizeUrl(opts.publicUrl, scheme);
		if (url) {return {
			url,
			source: "plugins.entries.device-pair.config.publicUrl"
		};}
		return { error: "Configured publicUrl is invalid." };
	}
	const remoteUrlRaw = cfg.gateway?.remote?.url;
	const remoteUrl = typeof remoteUrlRaw === "string" && remoteUrlRaw.trim() ? normalizeUrl(remoteUrlRaw, scheme) : null;
	if (opts.preferRemoteUrl && remoteUrl) {return {
		url: remoteUrl,
		source: "gateway.remote.url"
	};}
	const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
	if (tailscaleMode === "serve" || tailscaleMode === "funnel") {
		const host = await resolveTailnetHostWithRunner(opts.runCommandWithTimeout);
		if (!host) {return { error: "Tailscale Serve is enabled, but MagicDNS could not be resolved." };}
		return {
			url: `wss://${host}`,
			source: `gateway.tailscale.mode=${tailscaleMode}`
		};
	}
	if (remoteUrl) {return {
		url: remoteUrl,
		source: "gateway.remote.url"
	};}
	const bindResult = resolveGatewayBindUrl({
		bind: cfg.gateway?.bind,
		customBindHost: cfg.gateway?.customBindHost,
		scheme,
		port,
		pickTailnetHost: () => pickTailnetIPv4(opts.networkInterfaces),
		pickLanHost: () => pickLanIPv4(opts.networkInterfaces)
	});
	if (bindResult) {return bindResult;}
	return { error: "Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl." };
}
function encodePairingSetupCode(payload) {
	const json = JSON.stringify(payload);
	return Buffer.from(json, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function resolvePairingSetupFromConfig(cfg, options = {}) {
	assertExplicitGatewayAuthModeWhenBothConfigured(cfg);
	const env = options.env ?? process.env;
	const cfgForAuth = await materializePairingSetupAuthConfig(cfg, env);
	const authLabel = resolvePairingSetupAuthLabel(cfgForAuth, env);
	if (authLabel.error) {return {
		ok: false,
		error: authLabel.error
	};}
	const urlResult = await resolveGatewayUrl(cfgForAuth, {
		env,
		publicUrl: options.publicUrl,
		preferRemoteUrl: options.preferRemoteUrl,
		forceSecure: options.forceSecure,
		runCommandWithTimeout: options.runCommandWithTimeout,
		networkInterfaces: options.networkInterfaces ?? os.networkInterfaces
	});
	if (!urlResult.url) {return {
		ok: false,
		error: urlResult.error ?? "Gateway URL unavailable."
	};}
	if (!authLabel.label) {return {
		ok: false,
		error: "Gateway auth is not configured (no token or password)."
	};}
	return {
		ok: true,
		payload: {
			url: urlResult.url,
			bootstrapToken: (await issueDeviceBootstrapToken({ baseDir: options.pairingBaseDir })).token
		},
		authLabel: authLabel.label,
		urlSource: urlResult.source ?? "unknown"
	};
}
//#endregion
//#region src/cli/qr-cli.ts
function renderQrAscii(data) {
	return new Promise((resolve) => {
		qrcode.generate(data, { small: true }, (output) => {
			resolve(output);
		});
	});
}
function readDevicePairPublicUrlFromConfig(cfg) {
	const value = cfg.plugins?.entries?.["device-pair"]?.config?.["publicUrl"];
	if (typeof value !== "string") {return;}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function shouldResolveLocalGatewayPasswordSecret(cfg, env) {
	if (readGatewayPasswordEnv(env)) {return false;}
	const authMode = cfg.gateway?.auth?.mode;
	if (authMode === "password") {return true;}
	if (authMode === "token" || authMode === "none" || authMode === "trusted-proxy") {return false;}
	const envToken = readGatewayTokenEnv(env);
	const configTokenConfigured = hasConfiguredSecretInput(cfg.gateway?.auth?.token, cfg.secrets?.defaults);
	return !envToken && !configTokenConfigured;
}
async function resolveLocalGatewayPasswordSecretIfNeeded(cfg) {
	const resolvedPassword = await resolveRequiredConfiguredSecretRefInputString({
		config: cfg,
		env: process.env,
		value: cfg.gateway?.auth?.password,
		path: "gateway.auth.password"
	});
	if (!resolvedPassword) {return;}
	if (!cfg.gateway?.auth) {return;}
	cfg.gateway.auth.password = resolvedPassword;
}
function emitQrSecretResolveDiagnostics(diagnostics, opts) {
	if (diagnostics.length === 0) {return;}
	const toStderr = opts.json === true || opts.setupCodeOnly === true;
	for (const entry of diagnostics) {
		const message = theme.warn(`[secrets] ${entry}`);
		if (toStderr) {defaultRuntime.error(message);}
		else {defaultRuntime.log(message);}
	}
}
function registerQrCli(program) {
	program.command("qr").description("Generate an iOS pairing QR code and setup code").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/qr", "docs.openclaw.ai/cli/qr")}\n`).option("--remote", "Use gateway.remote.url and gateway.remote token/password (ignores device-pair publicUrl)", false).option("--url <url>", "Override gateway URL used in the setup payload").option("--public-url <url>", "Override gateway public URL used in the setup payload").option("--token <token>", "Override gateway token for setup payload").option("--password <password>", "Override gateway password for setup payload").option("--setup-code-only", "Print only the setup code", false).option("--no-ascii", "Skip ASCII QR rendering").option("--json", "Output JSON", false).action(async (opts) => {
		try {
			if (opts.token && opts.password) {throw new Error("Use either --token or --password, not both.");}
			const token = typeof opts.token === "string" ? opts.token.trim() : "";
			const password = typeof opts.password === "string" ? opts.password.trim() : "";
			const wantsRemote = opts.remote === true;
			const loadedRaw = loadConfig();
			if (wantsRemote && !opts.url && !opts.publicUrl) {
				const tailscaleMode = loadedRaw.gateway?.tailscale?.mode ?? "off";
				const remoteUrl = loadedRaw.gateway?.remote?.url;
				if (!(typeof remoteUrl === "string" && remoteUrl.trim().length > 0) && !(tailscaleMode === "serve" || tailscaleMode === "funnel")) {throw new Error("qr --remote requires gateway.remote.url (or gateway.tailscale.mode=serve/funnel).");}
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
			if (!wantsRemote && !password && !token && shouldResolveLocalGatewayPasswordSecret(cfg, process.env)) {await resolveLocalGatewayPasswordSecretIfNeeded(cfg);}
			const resolved = await resolvePairingSetupFromConfig(cfg, {
				publicUrl: (typeof opts.url === "string" && opts.url.trim() ? opts.url.trim() : typeof opts.publicUrl === "string" && opts.publicUrl.trim() ? opts.publicUrl.trim() : void 0) ?? (wantsRemote ? void 0 : readDevicePairPublicUrlFromConfig(cfg)),
				preferRemoteUrl: wantsRemote,
				runCommandWithTimeout: async (argv, runOpts) => await runCommandWithTimeout(argv, { timeoutMs: runOpts.timeoutMs })
			});
			if (!resolved.ok) {throw new Error(resolved.error);}
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
export { registerQrCli as t };
