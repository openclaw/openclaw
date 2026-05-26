import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as resolveGatewayPort } from "./paths-Cw7f9XhU.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { d as normalizeSecretInputString, m as resolveSecretInputRef, s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { n as assertExplicitGatewayAuthModeWhenBothConfigured } from "./auth-mode-policy-DXdptBl7.js";
import { a as trimToUndefined } from "./credential-planner-DPeD90hR.js";
import "./credentials-BJ7jvgw3.js";
import { r as resolveRequiredConfiguredSecretRefInputString } from "./resolve-configured-secret-input-string-DuewGZmy.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { i as pickMatchingExternalInterfaceAddress, o as safeNetworkInterfaces } from "./tailnet-D6Ui4WCo.js";
import { a as isCarrierGradeNatIpv4Address, c as isIpv4Address, f as isLoopbackIpAddress, g as parseCanonicalIpAddress, l as isIpv6Address, m as isRfc1918Ipv4Address } from "./ip-WAe3-2zT.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { t as resolveCommandSecretRefsViaGateway } from "./command-secret-gateway-BpOVXOFV.js";
import { u as getQrRemoteCommandSecretTargetIds } from "./command-secret-targets-UUlaHEu2.js";
import { n as resolveGatewayBindUrl, t as resolveTailnetHostWithRunner } from "./tailscale-status-zDpKLtE_.js";
import { t as renderQrTerminal } from "./qr-terminal-CJoQsh1V.js";
import { n as materializeGatewayAuthSecretRefs } from "./auth-config-utils-DgPWcy4S.js";
import { d as PAIRING_SETUP_BOOTSTRAP_PROFILE, i as issueDeviceBootstrapToken } from "./device-bootstrap-Db5YGvK1.js";
import os from "node:os";
//#region src/pairing/setup-code.ts
function describeSecureMobilePairingFix(source) {
	return "Tailscale and public mobile pairing require a secure gateway URL (wss://) or Tailscale Serve/Funnel." + (source ? ` Resolved source: ${source}.` : "") + " Fix: use a private LAN address, prefer gateway.tailscale.mode=serve, or set gateway.remote.url / plugins.entries.device-pair.config.publicUrl to a wss:// URL. ws:// is only valid for localhost, private LAN addresses, .local hosts, or the Android emulator.";
}
function normalizeMobilePairingHost(host) {
	let normalized = normalizeLowercaseStringOrEmpty(host);
	if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
	if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
	const zoneIndex = normalized.indexOf("%");
	if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
	return normalized;
}
function isPrivateLanHost(host) {
	const normalized = normalizeMobilePairingHost(host);
	if (normalized.endsWith(".local")) return true;
	if (isRfc1918Ipv4Address(normalized)) return true;
	const parsed = parseCanonicalIpAddress(normalized);
	if (!parsed) return false;
	if (isIpv4Address(parsed)) {
		const normalizedIp = parsed.toString();
		return normalizedIp.startsWith("169.254.") && !isCarrierGradeNatIpv4Address(normalizedIp);
	}
	if (!isIpv6Address(parsed)) return false;
	const normalizedIp = normalizeLowercaseStringOrEmpty(parsed.toString());
	return normalizedIp.startsWith("fe80:") || normalizedIp.startsWith("fc") || normalizedIp.startsWith("fd");
}
function isMobilePairingCleartextAllowedHost(host) {
	const normalized = normalizeMobilePairingHost(host);
	return normalized === "localhost" || isLoopbackIpAddress(normalized) || normalized === "10.0.2.2" || isPrivateLanHost(normalized);
}
function validateMobilePairingUrl(url, source) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return "Resolved mobile pairing URL is invalid.";
	}
	const protocol = parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : parsed.protocol;
	if (protocol === "wss:") return null;
	if (protocol !== "ws:" || isMobilePairingCleartextAllowedHost(parsed.hostname)) return null;
	return describeSecureMobilePairingFix(source);
}
const GATEWAY_SCHEME_WITHOUT_AUTHORITY_RE = /^(?:https?|wss?):(?!\/\/)/i;
const SCHEME_LIKE_PATH_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\//;
function normalizeUrl(raw, schemeFallback) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (GATEWAY_SCHEME_WITHOUT_AUTHORITY_RE.test(trimmed)) return null;
	const parsedUrl = parseNormalizedGatewayUrl(trimmed);
	if (parsedUrl) return parsedUrl;
	if (trimmed.includes("://") || SCHEME_LIKE_PATH_RE.test(trimmed)) return null;
	const withoutPath = normalizeOptionalString(trimmed.split("/", 1)[0]) ?? "";
	return withoutPath ? parseNormalizedGatewayUrl(`${schemeFallback}://${withoutPath}`) : null;
}
function parseNormalizedGatewayUrl(raw) {
	try {
		const parsed = new URL(raw);
		if (parsed.username || parsed.password) return null;
		const scheme = parsed.protocol.replace(":", "");
		if (!scheme) return null;
		const resolvedScheme = scheme === "http" ? "ws" : scheme === "https" ? "wss" : scheme;
		if (resolvedScheme !== "ws" && resolvedScheme !== "wss") return null;
		const host = parsed.hostname;
		if (!host) return null;
		return `${resolvedScheme}://${host}${parsed.port ? `:${parsed.port}` : ""}`;
	} catch {
		return null;
	}
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
	return pickMatchingExternalInterfaceAddress(safeNetworkInterfaces(networkInterfaces), {
		family: "IPv4",
		matches
	}) ?? null;
}
function pickLanIPv4(networkInterfaces) {
	return pickIPv4Matching(networkInterfaces, isPrivateIPv4);
}
function pickTailnetIPv4(networkInterfaces) {
	return pickIPv4Matching(networkInterfaces, isTailnetIPv4);
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
	const envToken = normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN);
	const envPassword = normalizeOptionalString(env.OPENCLAW_GATEWAY_PASSWORD);
	const token = envToken || (tokenRef ? void 0 : normalizeSecretInputString(cfg.gateway?.auth?.token));
	const password = envPassword || (passwordRef ? void 0 : normalizeSecretInputString(cfg.gateway?.auth?.password));
	if (mode === "password") {
		if (!password) return { error: "Gateway auth is set to password, but no password is configured." };
		return { label: "password" };
	}
	if (mode === "token") {
		if (!token) return { error: "Gateway auth is set to token, but no token is configured." };
		return { label: "token" };
	}
	if (token) return { label: "token" };
	if (password) return { label: "password" };
	return { error: "Gateway auth is not configured (no token or password)." };
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
	const hasRemoteUrl = typeof remoteUrlRaw === "string" && remoteUrlRaw.trim();
	const remoteUrl = hasRemoteUrl ? normalizeUrl(remoteUrlRaw, scheme) : null;
	if (hasRemoteUrl && !remoteUrl) return { error: "Configured gateway.remote.url is invalid." };
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
	const cfgForAuth = await materializeGatewayAuthSecretRefs({
		cfg,
		env,
		mode: cfg.gateway?.auth?.mode,
		hasTokenCandidate: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN)),
		hasPasswordCandidate: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_PASSWORD))
	});
	const authLabel = resolvePairingSetupAuthLabel(cfgForAuth, env);
	if (authLabel.error) return {
		ok: false,
		error: authLabel.error
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
	const mobilePairingUrlError = validateMobilePairingUrl(urlResult.url, urlResult.source);
	if (mobilePairingUrlError) return {
		ok: false,
		error: mobilePairingUrlError
	};
	if (!authLabel.label) return {
		ok: false,
		error: "Gateway auth is not configured (no token or password)."
	};
	return {
		ok: true,
		payload: {
			url: urlResult.url,
			bootstrapToken: (await issueDeviceBootstrapToken({
				baseDir: options.pairingBaseDir,
				profile: PAIRING_SETUP_BOOTSTRAP_PROFILE
			})).token
		},
		authLabel: authLabel.label,
		urlSource: urlResult.source ?? "unknown"
	};
}
//#endregion
//#region src/cli/qr-cli.ts
function renderQrAscii(data) {
	return renderQrTerminal(data);
}
function readDevicePairPublicUrlFromConfig(cfg) {
	const value = cfg.plugins?.entries?.["device-pair"]?.config?.["publicUrl"];
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function shouldResolveLocalGatewayPasswordSecret(cfg, env) {
	if (trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD)) return false;
	const authMode = cfg.gateway?.auth?.mode;
	if (authMode === "password") return true;
	if (authMode === "token" || authMode === "none" || authMode === "trusted-proxy") return false;
	const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
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
	if (!resolvedPassword) return;
	if (!cfg.gateway?.auth) return;
	cfg.gateway.auth.password = resolvedPassword;
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
	program.command("qr").description("Generate a mobile pairing QR code and setup code").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/qr", "docs.openclaw.ai/cli/qr")}\n`).option("--remote", "Use gateway.remote.url and gateway.remote token/password (ignores device-pair publicUrl)", false).option("--url <url>", "Override gateway URL used in the setup payload").option("--public-url <url>", "Override gateway public URL used in the setup payload").option("--token <token>", "Override gateway token for setup payload").option("--password <password>", "Override gateway password for setup payload").option("--setup-code-only", "Print only the setup code", false).option("--no-ascii", "Skip ASCII QR rendering").option("--json", "Output JSON", false).action(async (opts) => {
		try {
			if (opts.token && opts.password) throw new Error("Use either --token or --password, not both.");
			const token = trimToUndefined(opts.token) ?? "";
			const password = trimToUndefined(opts.password) ?? "";
			const wantsRemote = opts.remote === true;
			const loadedRaw = getRuntimeConfig();
			if (wantsRemote && !opts.url && !opts.publicUrl) {
				const tailscaleMode = loadedRaw.gateway?.tailscale?.mode ?? "off";
				const remoteUrl = loadedRaw.gateway?.remote?.url;
				if (!Boolean(trimToUndefined(remoteUrl)) && !(tailscaleMode === "serve" || tailscaleMode === "funnel")) throw new Error("qr --remote requires gateway.remote.url (or gateway.tailscale.mode=serve/funnel).");
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
				const remoteToken = trimToUndefined(cfg.gateway?.remote?.token) ?? "";
				const remotePassword = trimToUndefined(cfg.gateway?.remote?.password) ?? "";
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
				defaultRuntime.writeJson({
					setupCode,
					gatewayUrl: resolved.payload.url,
					auth: resolved.authLabel,
					urlSource: resolved.urlSource
				});
				return;
			}
			const lines = [
				theme.heading("Pairing QR"),
				"Scan this with the OpenClaw mobile app (Onboarding -> Scan QR).",
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
