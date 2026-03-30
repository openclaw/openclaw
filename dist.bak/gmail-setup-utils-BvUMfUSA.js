import { qt as resolveGatewayPort, st as resolveUserPath, zt as DEFAULT_GATEWAY_PORT } from "./entry.js";
import { t as runCommandWithTimeout } from "./exec-BhaMholX.js";
import { d as hasBinary } from "./frontmatter-DzgKaILZ.js";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

//#region src/hooks/gmail.ts
const DEFAULT_GMAIL_LABEL = "INBOX";
const DEFAULT_GMAIL_TOPIC = "gog-gmail-watch";
const DEFAULT_GMAIL_SUBSCRIPTION = "gog-gmail-watch-push";
const DEFAULT_GMAIL_SERVE_BIND = "127.0.0.1";
const DEFAULT_GMAIL_SERVE_PORT = 8788;
const DEFAULT_GMAIL_SERVE_PATH = "/gmail-pubsub";
const DEFAULT_GMAIL_MAX_BYTES = 2e4;
const DEFAULT_GMAIL_RENEW_MINUTES = 720;
const DEFAULT_HOOKS_PATH = "/hooks";
function generateHookToken(bytes = 24) {
	return randomBytes(bytes).toString("hex");
}
function mergeHookPresets(existing, preset) {
	const next = new Set((existing ?? []).map((item) => item.trim()).filter(Boolean));
	next.add(preset);
	return Array.from(next);
}
function normalizeHooksPath(raw) {
	const base = raw?.trim() || DEFAULT_HOOKS_PATH;
	if (base === "/") return DEFAULT_HOOKS_PATH;
	return (base.startsWith("/") ? base : `/${base}`).replace(/\/+$/, "");
}
function normalizeServePath(raw) {
	const base = raw?.trim() || DEFAULT_GMAIL_SERVE_PATH;
	if (base === "/") return "/";
	return (base.startsWith("/") ? base : `/${base}`).replace(/\/+$/, "");
}
function buildDefaultHookUrl(hooksPath, port = DEFAULT_GATEWAY_PORT) {
	const basePath = normalizeHooksPath(hooksPath);
	return joinUrl(`http://127.0.0.1:${port}`, `${basePath}/gmail`);
}
function resolveGmailHookRuntimeConfig(cfg, overrides) {
	const hooks = cfg.hooks;
	const gmail = hooks?.gmail;
	const hookToken = overrides.hookToken ?? hooks?.token ?? "";
	if (!hookToken) return {
		ok: false,
		error: "hooks.token missing (needed for gmail hook)"
	};
	const account = overrides.account ?? gmail?.account ?? "";
	if (!account) return {
		ok: false,
		error: "gmail account required"
	};
	const topic = overrides.topic ?? gmail?.topic ?? "";
	if (!topic) return {
		ok: false,
		error: "gmail topic required"
	};
	const subscription = overrides.subscription ?? gmail?.subscription ?? DEFAULT_GMAIL_SUBSCRIPTION;
	const pushToken = overrides.pushToken ?? gmail?.pushToken ?? "";
	if (!pushToken) return {
		ok: false,
		error: "gmail push token required"
	};
	const hookUrl = overrides.hookUrl ?? gmail?.hookUrl ?? buildDefaultHookUrl(hooks?.path, resolveGatewayPort(cfg));
	const includeBody = overrides.includeBody ?? gmail?.includeBody ?? true;
	const maxBytesRaw = overrides.maxBytes ?? gmail?.maxBytes;
	const maxBytes = typeof maxBytesRaw === "number" && Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? Math.floor(maxBytesRaw) : DEFAULT_GMAIL_MAX_BYTES;
	const renewEveryMinutesRaw = overrides.renewEveryMinutes ?? gmail?.renewEveryMinutes;
	const renewEveryMinutes = typeof renewEveryMinutesRaw === "number" && Number.isFinite(renewEveryMinutesRaw) && renewEveryMinutesRaw > 0 ? Math.floor(renewEveryMinutesRaw) : DEFAULT_GMAIL_RENEW_MINUTES;
	const serveBind = overrides.serveBind ?? gmail?.serve?.bind ?? DEFAULT_GMAIL_SERVE_BIND;
	const servePortRaw = overrides.servePort ?? gmail?.serve?.port;
	const servePort = typeof servePortRaw === "number" && Number.isFinite(servePortRaw) && servePortRaw > 0 ? Math.floor(servePortRaw) : DEFAULT_GMAIL_SERVE_PORT;
	const servePathRaw = overrides.servePath ?? gmail?.serve?.path;
	const normalizedServePathRaw = typeof servePathRaw === "string" && servePathRaw.trim().length > 0 ? normalizeServePath(servePathRaw) : DEFAULT_GMAIL_SERVE_PATH;
	const tailscaleTargetRaw = overrides.tailscaleTarget ?? gmail?.tailscale?.target;
	const tailscaleMode = overrides.tailscaleMode ?? gmail?.tailscale?.mode ?? "off";
	const tailscaleTarget = tailscaleMode !== "off" && typeof tailscaleTargetRaw === "string" && tailscaleTargetRaw.trim().length > 0 ? tailscaleTargetRaw.trim() : void 0;
	const servePath = normalizeServePath(tailscaleMode !== "off" && !tailscaleTarget ? "/" : normalizedServePathRaw);
	const tailscalePathRaw = overrides.tailscalePath ?? gmail?.tailscale?.path;
	const tailscalePath = normalizeServePath(tailscaleMode !== "off" ? tailscalePathRaw ?? normalizedServePathRaw : tailscalePathRaw ?? servePath);
	return {
		ok: true,
		value: {
			account,
			label: overrides.label ?? gmail?.label ?? DEFAULT_GMAIL_LABEL,
			topic,
			subscription,
			pushToken,
			hookToken,
			hookUrl,
			includeBody,
			maxBytes,
			renewEveryMinutes,
			serve: {
				bind: serveBind,
				port: servePort,
				path: servePath
			},
			tailscale: {
				mode: tailscaleMode,
				path: tailscalePath,
				target: tailscaleTarget
			}
		}
	};
}
function buildGogWatchStartArgs(cfg) {
	return [
		"gmail",
		"watch",
		"start",
		"--account",
		cfg.account,
		"--label",
		cfg.label,
		"--topic",
		cfg.topic
	];
}
function buildGogWatchServeArgs(cfg) {
	const args = [
		"gmail",
		"watch",
		"serve",
		"--account",
		cfg.account,
		"--bind",
		cfg.serve.bind,
		"--port",
		String(cfg.serve.port),
		"--path",
		cfg.serve.path,
		"--token",
		cfg.pushToken,
		"--hook-url",
		cfg.hookUrl,
		"--hook-token",
		cfg.hookToken
	];
	if (cfg.includeBody) args.push("--include-body");
	if (cfg.maxBytes > 0) args.push("--max-bytes", String(cfg.maxBytes));
	return args;
}
function buildTopicPath(projectId, topicName) {
	return `projects/${projectId}/topics/${topicName}`;
}
function parseTopicPath(topic) {
	const match = topic.trim().match(/^projects\/([^/]+)\/topics\/([^/]+)$/i);
	if (!match) return null;
	return {
		projectId: match[1] ?? "",
		topicName: match[2] ?? ""
	};
}
function joinUrl(base, path) {
	const url = new URL(base);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
	return url.toString();
}

//#endregion
//#region src/hooks/gmail-setup-utils.ts
let cachedPythonPath;
const MAX_OUTPUT_CHARS = 800;
function trimOutput(value) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
	return `${trimmed.slice(0, MAX_OUTPUT_CHARS)}…`;
}
function formatCommandResultInternal(command, result, statusLabel) {
	const code = result.code ?? "null";
	const signal = result.signal ? `, signal=${result.signal}` : "";
	const killed = result.killed ? ", killed=true" : "";
	const stderr = trimOutput(result.stderr);
	const stdout = trimOutput(result.stdout);
	const lines = [`${command} ${statusLabel} (code=${code}${signal}${killed})`];
	if (stderr) lines.push(`stderr: ${stderr}`);
	if (stdout) lines.push(`stdout: ${stdout}`);
	return lines.join("\n");
}
function formatCommandFailure(command, result) {
	return formatCommandResultInternal(command, result, "failed");
}
function formatCommandResult(command, result) {
	return formatCommandResultInternal(command, result, "exited");
}
function formatJsonParseFailure(command, result, err) {
	return `${command} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}\n${formatCommandResult(command, result)}`;
}
function formatCommand(command, args) {
	return [command, ...args].join(" ");
}
function findExecutablesOnPath(bins) {
	const parts = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const seen = /* @__PURE__ */ new Set();
	const matches = [];
	for (const part of parts) for (const bin of bins) {
		const candidate = path.join(part, bin);
		if (seen.has(candidate)) continue;
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			matches.push(candidate);
			seen.add(candidate);
		} catch {}
	}
	return matches;
}
function ensurePathIncludes(dirPath, position) {
	const parts = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	if (parts.includes(dirPath)) return;
	const next = position === "prepend" ? [dirPath, ...parts] : [...parts, dirPath];
	process.env.PATH = next.join(path.delimiter);
}
function ensureGcloudOnPath() {
	if (hasBinary("gcloud")) return true;
	for (const candidate of [
		"/opt/homebrew/share/google-cloud-sdk/bin/gcloud",
		"/usr/local/share/google-cloud-sdk/bin/gcloud",
		"/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin/gcloud",
		"/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin/gcloud"
	]) try {
		fs.accessSync(candidate, fs.constants.X_OK);
		ensurePathIncludes(path.dirname(candidate), "append");
		return true;
	} catch {}
	return false;
}
async function resolvePythonExecutablePath() {
	if (cachedPythonPath !== void 0) return cachedPythonPath ?? void 0;
	const candidates = findExecutablesOnPath(["python3", "python"]);
	for (const candidate of candidates) {
		const res = await runCommandWithTimeout([
			candidate,
			"-c",
			"import os, sys; print(os.path.realpath(sys.executable))"
		], { timeoutMs: 2e3 });
		if (res.code !== 0) continue;
		const resolved = res.stdout.trim().split(/\s+/)[0];
		if (!resolved) continue;
		try {
			fs.accessSync(resolved, fs.constants.X_OK);
			cachedPythonPath = resolved;
			return resolved;
		} catch {}
	}
	cachedPythonPath = null;
}
async function gcloudEnv() {
	if (process.env.CLOUDSDK_PYTHON) return;
	const pythonPath = await resolvePythonExecutablePath();
	if (!pythonPath) return;
	return { CLOUDSDK_PYTHON: pythonPath };
}
async function runGcloudCommand(args, timeoutMs) {
	return await runCommandWithTimeout(["gcloud", ...args], {
		timeoutMs,
		env: await gcloudEnv()
	});
}
async function ensureDependency(bin, brewArgs) {
	if (bin === "gcloud" && ensureGcloudOnPath()) return;
	if (hasBinary(bin)) return;
	if (process.platform !== "darwin") throw new Error(`${bin} not installed; install it and retry`);
	if (!hasBinary("brew")) throw new Error("Homebrew not installed (install brew and retry)");
	const brewEnv = bin === "gcloud" ? await gcloudEnv() : void 0;
	const result = await runCommandWithTimeout([
		"brew",
		"install",
		...brewArgs
	], {
		timeoutMs: 6e5,
		env: brewEnv
	});
	if (result.code !== 0) throw new Error(`brew install failed for ${bin}: ${result.stderr || result.stdout}`);
	if (!hasBinary(bin)) throw new Error(`${bin} still not available after brew install`);
}
async function ensureGcloudAuth() {
	const res = await runGcloudCommand([
		"auth",
		"list",
		"--filter",
		"status:ACTIVE",
		"--format",
		"value(account)"
	], 3e4);
	if (res.code === 0 && res.stdout.trim()) return;
	const login = await runGcloudCommand(["auth", "login"], 6e5);
	if (login.code !== 0) throw new Error(login.stderr || "gcloud auth login failed");
}
async function runGcloud(args) {
	const result = await runGcloudCommand(args, 12e4);
	if (result.code !== 0) throw new Error(result.stderr || result.stdout || "gcloud command failed");
	return result;
}
async function ensureTopic(projectId, topicName) {
	if ((await runGcloudCommand([
		"pubsub",
		"topics",
		"describe",
		topicName,
		"--project",
		projectId
	], 3e4)).code === 0) return;
	await runGcloud([
		"pubsub",
		"topics",
		"create",
		topicName,
		"--project",
		projectId
	]);
}
async function ensureSubscription(projectId, subscription, topicName, pushEndpoint) {
	if ((await runGcloudCommand([
		"pubsub",
		"subscriptions",
		"describe",
		subscription,
		"--project",
		projectId
	], 3e4)).code === 0) {
		await runGcloud([
			"pubsub",
			"subscriptions",
			"update",
			subscription,
			"--project",
			projectId,
			"--push-endpoint",
			pushEndpoint
		]);
		return;
	}
	await runGcloud([
		"pubsub",
		"subscriptions",
		"create",
		subscription,
		"--project",
		projectId,
		"--topic",
		topicName,
		"--push-endpoint",
		pushEndpoint
	]);
}
async function ensureTailscaleEndpoint(params) {
	if (params.mode === "off") return "";
	const statusArgs = ["status", "--json"];
	const statusCommand = formatCommand("tailscale", statusArgs);
	const status = await runCommandWithTimeout(["tailscale", ...statusArgs], { timeoutMs: 3e4 });
	if (status.code !== 0) throw new Error(formatCommandFailure(statusCommand, status));
	let parsed;
	try {
		parsed = JSON.parse(status.stdout);
	} catch (err) {
		throw new Error(formatJsonParseFailure(statusCommand, status, err), { cause: err });
	}
	const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "");
	if (!dnsName) throw new Error("tailscale DNS name missing; run tailscale up");
	const target = typeof params.target === "string" && params.target.trim().length > 0 ? params.target.trim() : params.port ? String(params.port) : "";
	if (!target) throw new Error("tailscale target missing; set a port or target URL");
	const pathArg = normalizeServePath(params.path);
	const funnelArgs = [
		params.mode,
		"--bg",
		"--set-path",
		pathArg,
		"--yes",
		target
	];
	const funnelCommand = formatCommand("tailscale", funnelArgs);
	const funnelResult = await runCommandWithTimeout(["tailscale", ...funnelArgs], { timeoutMs: 3e4 });
	if (funnelResult.code !== 0) throw new Error(formatCommandFailure(funnelCommand, funnelResult));
	const baseUrl = `https://${dnsName}${pathArg}`;
	return params.token ? `${baseUrl}?token=${params.token}` : baseUrl;
}
async function resolveProjectIdFromGogCredentials() {
	const candidates = gogCredentialsPaths();
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			const raw = fs.readFileSync(candidate, "utf-8");
			const projectNumber = extractProjectNumber(extractGogClientId(JSON.parse(raw)));
			if (!projectNumber) continue;
			const res = await runGcloudCommand([
				"projects",
				"list",
				"--filter",
				`projectNumber=${projectNumber}`,
				"--format",
				"value(projectId)"
			], 3e4);
			if (res.code !== 0) continue;
			const projectId = res.stdout.trim().split(/\s+/)[0];
			if (projectId) return projectId;
		} catch {}
	}
	return null;
}
function gogCredentialsPaths() {
	const paths = [];
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg) paths.push(path.join(xdg, "gogcli", "credentials.json"));
	paths.push(resolveUserPath("~/.config/gogcli/credentials.json"));
	if (process.platform === "darwin") paths.push(resolveUserPath("~/Library/Application Support/gogcli/credentials.json"));
	return paths;
}
function extractGogClientId(parsed) {
	const installed = parsed.installed;
	const web = parsed.web;
	const candidate = installed?.client_id || web?.client_id || parsed.client_id || "";
	return typeof candidate === "string" ? candidate : null;
}
function extractProjectNumber(clientId) {
	if (!clientId) return null;
	return clientId.match(/^(\d+)-/)?.[1] ?? null;
}

//#endregion
export { normalizeServePath as C, normalizeHooksPath as S, resolveGmailHookRuntimeConfig as T, buildGogWatchServeArgs as _, ensureTopic as a, generateHookToken as b, DEFAULT_GMAIL_LABEL as c, DEFAULT_GMAIL_SERVE_BIND as d, DEFAULT_GMAIL_SERVE_PATH as f, buildDefaultHookUrl as g, DEFAULT_GMAIL_TOPIC as h, ensureTailscaleEndpoint as i, DEFAULT_GMAIL_MAX_BYTES as l, DEFAULT_GMAIL_SUBSCRIPTION as m, ensureGcloudAuth as n, resolveProjectIdFromGogCredentials as o, DEFAULT_GMAIL_SERVE_PORT as p, ensureSubscription as r, runGcloud as s, ensureDependency as t, DEFAULT_GMAIL_RENEW_MINUTES as u, buildGogWatchStartArgs as v, parseTopicPath as w, mergeHookPresets as x, buildTopicPath as y };