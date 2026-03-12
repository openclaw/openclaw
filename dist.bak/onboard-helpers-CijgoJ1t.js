import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { Rt as CONFIG_PATH, W as CONFIG_DIR, dt as sleep, lt as shortenHomeInString, st as resolveUserPath, ut as shortenHomePath } from "./entry.js";
import { Qt as isSafeExecutableValue, ct as isAvatarImageDataUrl, ft as looksLikeAvatarPath, st as isAvatarHttpUrl } from "./auth-profiles-D6H-HVV8.js";
import { E as ensureAgentWorkspace, N as resolveAgentModelPrimaryValue, _ as DEFAULT_AGENT_WORKSPACE_DIR } from "./agent-scope-C2k6BQnt.js";
import { t as runCommandWithTimeout } from "./exec-BhaMholX.js";
import { r as VERSION } from "./env-vars-DPtuUD7z.js";
import { h as GATEWAY_CLIENT_NAMES, m as GATEWAY_CLIENT_MODES } from "./message-channel-CJUwnCYd.js";
import { c as resolveSessionTranscriptsDirForAgent } from "./paths-DWsXK0S0.js";
import { n as callGateway } from "./call-D6IYi30Z.js";
import { c as pickPrimaryLanIPv4, o as isValidIPv4 } from "./net-DBrsyv8q.js";
import { n as pickPrimaryTailnetIPv4 } from "./tailnet-Ca1WnFBq.js";
import { t as isWSL } from "./wsl-D9-kubbW.js";
import { r as stylePromptTitle } from "./prompt-style-wsroINzm.js";
import path from "node:path";
import { inspect } from "node:util";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { cancel, isCancel } from "@clack/prompts";

//#region src/gateway/control-ui-shared.ts
const CONTROL_UI_AVATAR_PREFIX = "/avatar";
function normalizeControlUiBasePath(basePath) {
	if (!basePath) return "";
	let normalized = basePath.trim();
	if (!normalized) return "";
	if (!normalized.startsWith("/")) normalized = `/${normalized}`;
	if (normalized === "/") return "";
	if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
	return normalized;
}
function buildControlUiAvatarUrl(basePath, agentId) {
	return basePath ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/${agentId}` : `${CONTROL_UI_AVATAR_PREFIX}/${agentId}`;
}
function resolveAssistantAvatarUrl(params) {
	const avatar = params.avatar?.trim();
	if (!avatar) return;
	if (isAvatarHttpUrl(avatar) || isAvatarImageDataUrl(avatar)) return avatar;
	const basePath = normalizeControlUiBasePath(params.basePath);
	const baseAvatarPrefix = basePath ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/` : `${CONTROL_UI_AVATAR_PREFIX}/`;
	if (basePath && avatar.startsWith(`${CONTROL_UI_AVATAR_PREFIX}/`)) return `${basePath}${avatar}`;
	if (avatar.startsWith(baseAvatarPrefix)) return avatar;
	if (!params.agentId) return avatar;
	if (looksLikeAvatarPath(avatar)) return buildControlUiAvatarUrl(basePath, params.agentId);
	return avatar;
}

//#endregion
//#region src/commands/onboard-helpers.ts
var onboard_helpers_exports = /* @__PURE__ */ __exportAll({
	DEFAULT_WORKSPACE: () => DEFAULT_WORKSPACE,
	applyWizardMetadata: () => applyWizardMetadata,
	detectBinary: () => detectBinary,
	detectBrowserOpenSupport: () => detectBrowserOpenSupport,
	ensureWorkspaceAndSessions: () => ensureWorkspaceAndSessions,
	formatControlUiSshHint: () => formatControlUiSshHint,
	guardCancel: () => guardCancel,
	handleReset: () => handleReset,
	moveToTrash: () => moveToTrash,
	normalizeGatewayTokenInput: () => normalizeGatewayTokenInput,
	openUrl: () => openUrl,
	printWizardHeader: () => printWizardHeader,
	probeGatewayReachable: () => probeGatewayReachable,
	randomToken: () => randomToken,
	resolveBrowserOpenCommand: () => resolveBrowserOpenCommand,
	resolveControlUiLinks: () => resolveControlUiLinks,
	resolveNodeManagerOptions: () => resolveNodeManagerOptions,
	summarizeExistingConfig: () => summarizeExistingConfig,
	validateGatewayPasswordInput: () => validateGatewayPasswordInput,
	waitForGatewayReachable: () => waitForGatewayReachable
});
function guardCancel(value, runtime) {
	if (isCancel(value)) {
		cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
		runtime.exit(0);
		throw new Error("unreachable");
	}
	return value;
}
function summarizeExistingConfig(config) {
	const rows = [];
	const defaults = config.agents?.defaults;
	if (defaults?.workspace) rows.push(shortenHomeInString(`workspace: ${defaults.workspace}`));
	if (defaults?.model) {
		const model = resolveAgentModelPrimaryValue(defaults.model);
		if (model) rows.push(shortenHomeInString(`model: ${model}`));
	}
	if (config.gateway?.mode) rows.push(shortenHomeInString(`gateway.mode: ${config.gateway.mode}`));
	if (typeof config.gateway?.port === "number") rows.push(shortenHomeInString(`gateway.port: ${config.gateway.port}`));
	if (config.gateway?.bind) rows.push(shortenHomeInString(`gateway.bind: ${config.gateway.bind}`));
	if (config.gateway?.remote?.url) rows.push(shortenHomeInString(`gateway.remote.url: ${config.gateway.remote.url}`));
	if (config.skills?.install?.nodeManager) rows.push(shortenHomeInString(`skills.nodeManager: ${config.skills.install.nodeManager}`));
	return rows.length ? rows.join("\n") : "No key settings detected.";
}
function randomToken() {
	return crypto.randomBytes(24).toString("hex");
}
function normalizeGatewayTokenInput(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (trimmed === "undefined" || trimmed === "null") return "";
	return trimmed;
}
function validateGatewayPasswordInput(value) {
	if (typeof value !== "string") return "Required";
	const trimmed = value.trim();
	if (!trimmed) return "Required";
	if (trimmed === "undefined" || trimmed === "null") return "Cannot be the literal string \"undefined\" or \"null\"";
}
function printWizardHeader(runtime) {
	const header = [
		"▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
		"██░▄▄▄░██░▄▄░██░▄▄▄██░▀██░██░▄▄▀██░████░▄▄▀██░███░██",
		"██░███░██░▀▀░██░▄▄▄██░█░█░██░█████░████░▀▀░██░█░█░██",
		"██░▀▀▀░██░█████░▀▀▀██░██▄░██░▀▀▄██░▀▀░█░██░██▄▀▄▀▄██",
		"▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
		"                  🦞 OPENCLAW 🦞                    ",
		" "
	].join("\n");
	runtime.log(header);
}
function applyWizardMetadata(cfg, params) {
	const commit = process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim() || void 0;
	return {
		...cfg,
		wizard: {
			...cfg.wizard,
			lastRunAt: (/* @__PURE__ */ new Date()).toISOString(),
			lastRunVersion: VERSION,
			lastRunCommit: commit,
			lastRunCommand: params.command,
			lastRunMode: params.mode
		}
	};
}
async function resolveBrowserOpenCommand() {
	const platform = process.platform;
	const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
	if ((Boolean(process.env.SSH_CLIENT) || Boolean(process.env.SSH_TTY) || Boolean(process.env.SSH_CONNECTION)) && !hasDisplay && platform !== "win32") return {
		argv: null,
		reason: "ssh-no-display"
	};
	if (platform === "win32") return {
		argv: [
			"cmd",
			"/c",
			"start",
			""
		],
		command: "cmd",
		quoteUrl: true
	};
	if (platform === "darwin") return await detectBinary("open") ? {
		argv: ["open"],
		command: "open"
	} : {
		argv: null,
		reason: "missing-open"
	};
	if (platform === "linux") {
		const wsl = await isWSL();
		if (!hasDisplay && !wsl) return {
			argv: null,
			reason: "no-display"
		};
		if (wsl) {
			if (await detectBinary("wslview")) return {
				argv: ["wslview"],
				command: "wslview"
			};
			if (!hasDisplay) return {
				argv: null,
				reason: "wsl-no-wslview"
			};
		}
		return await detectBinary("xdg-open") ? {
			argv: ["xdg-open"],
			command: "xdg-open"
		} : {
			argv: null,
			reason: "missing-xdg-open"
		};
	}
	return {
		argv: null,
		reason: "unsupported-platform"
	};
}
async function detectBrowserOpenSupport() {
	const resolved = await resolveBrowserOpenCommand();
	if (!resolved.argv) return {
		ok: false,
		reason: resolved.reason
	};
	return {
		ok: true,
		command: resolved.command
	};
}
function formatControlUiSshHint(params) {
	const basePath = normalizeControlUiBasePath(params.basePath);
	const uiPath = basePath ? `${basePath}/` : "/";
	const localUrl = `http://localhost:${params.port}${uiPath}`;
	const authedUrl = params.token ? `${localUrl}#token=${encodeURIComponent(params.token)}` : void 0;
	const sshTarget = resolveSshTargetHint();
	return [
		"No GUI detected. Open from your computer:",
		`ssh -N -L ${params.port}:127.0.0.1:${params.port} ${sshTarget}`,
		"Then open:",
		localUrl,
		authedUrl,
		"Docs:",
		"https://docs.openclaw.ai/gateway/remote",
		"https://docs.openclaw.ai/web/control-ui"
	].filter(Boolean).join("\n");
}
function resolveSshTargetHint() {
	return `${process.env.USER || process.env.LOGNAME || "user"}@${(process.env.SSH_CONNECTION?.trim().split(/\s+/))?.[2] ?? "<host>"}`;
}
async function openUrl(url) {
	if (shouldSkipBrowserOpenInTests()) return false;
	const resolved = await resolveBrowserOpenCommand();
	if (!resolved.argv) return false;
	const quoteUrl = resolved.quoteUrl === true;
	const command = [...resolved.argv];
	if (quoteUrl) {
		if (command.at(-1) === "") command[command.length - 1] = "\"\"";
		command.push(`"${url}"`);
	} else command.push(url);
	try {
		await runCommandWithTimeout(command, {
			timeoutMs: 5e3,
			windowsVerbatimArguments: quoteUrl
		});
		return true;
	} catch {
		return false;
	}
}
async function ensureWorkspaceAndSessions(workspaceDir, runtime, options) {
	const ws = await ensureAgentWorkspace({
		dir: workspaceDir,
		ensureBootstrapFiles: !options?.skipBootstrap
	});
	runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);
	const sessionsDir = resolveSessionTranscriptsDirForAgent(options?.agentId);
	await fs.mkdir(sessionsDir, { recursive: true });
	runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
}
function resolveNodeManagerOptions() {
	return [
		{
			value: "npm",
			label: "npm"
		},
		{
			value: "pnpm",
			label: "pnpm"
		},
		{
			value: "bun",
			label: "bun"
		}
	];
}
async function moveToTrash(pathname, runtime) {
	if (!pathname) return;
	try {
		await fs.access(pathname);
	} catch {
		return;
	}
	try {
		await runCommandWithTimeout(["trash", pathname], { timeoutMs: 5e3 });
		runtime.log(`Moved to Trash: ${shortenHomePath(pathname)}`);
	} catch {
		runtime.log(`Failed to move to Trash (manual delete): ${shortenHomePath(pathname)}`);
	}
}
async function handleReset(scope, workspaceDir, runtime) {
	await moveToTrash(CONFIG_PATH, runtime);
	if (scope === "config") return;
	await moveToTrash(path.join(CONFIG_DIR, "credentials"), runtime);
	await moveToTrash(resolveSessionTranscriptsDirForAgent(), runtime);
	if (scope === "full") await moveToTrash(workspaceDir, runtime);
}
async function detectBinary(name) {
	if (!name?.trim()) return false;
	if (!isSafeExecutableValue(name)) return false;
	const resolved = name.startsWith("~") ? resolveUserPath(name) : name;
	if (path.isAbsolute(resolved) || resolved.startsWith(".") || resolved.includes("/") || resolved.includes("\\")) try {
		await fs.access(resolved);
		return true;
	} catch {
		return false;
	}
	const command = process.platform === "win32" ? ["where", name] : [
		"/usr/bin/env",
		"which",
		name
	];
	try {
		const result = await runCommandWithTimeout(command, { timeoutMs: 2e3 });
		return result.code === 0 && result.stdout.trim().length > 0;
	} catch {
		return false;
	}
}
function shouldSkipBrowserOpenInTests() {
	if (process.env.VITEST) return true;
	return false;
}
async function probeGatewayReachable(params) {
	const url = params.url.trim();
	const timeoutMs = params.timeoutMs ?? 1500;
	try {
		await callGateway({
			url,
			token: params.token,
			password: params.password,
			method: "health",
			timeoutMs,
			clientName: GATEWAY_CLIENT_NAMES.PROBE,
			mode: GATEWAY_CLIENT_MODES.PROBE
		});
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			detail: summarizeError(err)
		};
	}
}
async function waitForGatewayReachable(params) {
	const deadlineMs = params.deadlineMs ?? 15e3;
	const pollMs = params.pollMs ?? 400;
	const probeTimeoutMs = params.probeTimeoutMs ?? 1500;
	const startedAt = Date.now();
	let lastDetail;
	while (Date.now() - startedAt < deadlineMs) {
		const probe = await probeGatewayReachable({
			url: params.url,
			token: params.token,
			password: params.password,
			timeoutMs: probeTimeoutMs
		});
		if (probe.ok) return probe;
		lastDetail = probe.detail;
		await sleep(pollMs);
	}
	return {
		ok: false,
		detail: lastDetail
	};
}
function summarizeError(err) {
	let raw = "unknown error";
	if (err instanceof Error) raw = err.message || raw;
	else if (typeof err === "string") raw = err || raw;
	else if (err !== void 0) raw = inspect(err, { depth: 2 });
	const line = raw.split("\n").map((s) => s.trim()).find(Boolean) ?? raw;
	return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
const DEFAULT_WORKSPACE = DEFAULT_AGENT_WORKSPACE_DIR;
function resolveControlUiLinks(params) {
	const port = params.port;
	const bind = params.bind ?? "loopback";
	const customBindHost = params.customBindHost?.trim();
	const tailnetIPv4 = pickPrimaryTailnetIPv4();
	const host = (() => {
		if (bind === "custom" && customBindHost && isValidIPv4(customBindHost)) return customBindHost;
		if (bind === "tailnet" && tailnetIPv4) return tailnetIPv4 ?? "127.0.0.1";
		if (bind === "lan") return pickPrimaryLanIPv4() ?? "127.0.0.1";
		return "127.0.0.1";
	})();
	const basePath = normalizeControlUiBasePath(params.basePath);
	const uiPath = basePath ? `${basePath}/` : "/";
	const wsPath = basePath ? basePath : "";
	return {
		httpUrl: `http://${host}:${port}${uiPath}`,
		wsUrl: `ws://${host}:${port}${wsPath}`
	};
}

//#endregion
export { normalizeControlUiBasePath as C, buildControlUiAvatarUrl as S, resolveNodeManagerOptions as _, ensureWorkspaceAndSessions as a, waitForGatewayReachable as b, handleReset as c, onboard_helpers_exports as d, openUrl as f, resolveControlUiLinks as g, randomToken as h, detectBrowserOpenSupport as i, moveToTrash as l, probeGatewayReachable as m, applyWizardMetadata as n, formatControlUiSshHint as o, printWizardHeader as p, detectBinary as r, guardCancel as s, DEFAULT_WORKSPACE as t, normalizeGatewayTokenInput as u, summarizeExistingConfig as v, resolveAssistantAvatarUrl as w, CONTROL_UI_AVATAR_PREFIX as x, validateGatewayPasswordInput as y };