import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as visibleWidth } from "./ansi-4r6vVvJt.js";
import { s as resolveConfigPath } from "./paths-Cw7f9XhU.js";
import { d as movePathToTrash } from "./fs-safe-CV86zY9G.js";
import { _ as sleep, d as resolveConfigDir, g as shortenHomePath, h as shortenHomeInString } from "./utils-sBTEdeml.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { i as resolveAgentModelPrimaryValue } from "./model-input-ChW9XXsQ.js";
import { t as DEFAULT_AGENT_WORKSPACE_DIR } from "./workspace-default--mMaLHGD.js";
import { a as probeGateway } from "./probe-VG0gCJ-9.js";
import { r as normalizeControlUiBasePath } from "./control-ui-shared-C2-bVRg-.js";
import "./control-ui-links-BSo6xNaU.js";
import { l as resolveSessionTranscriptsDirForAgent } from "./paths-Bg3PO6Gj.js";
import { l as ensureAgentWorkspace } from "./workspace-DTx8zuCN.js";
import { r as stylePromptTitle } from "./prompt-style-DH7LpiPN.js";
import "./detect-binary-C4HxcF68.js";
import { i as supportsDecorativeEmoji, t as decorativeEmoji } from "./decorative-emoji-C7cb8Cby.js";
import "./browser-open-BTGCmG6r.js";
import path from "node:path";
import fs from "node:fs/promises";
import { inspect } from "node:util";
import { cancel, isCancel } from "@clack/prompts";
//#region src/commands/onboard-helpers.ts
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
	if (defaults?.workspace) rows.push(shortenHomeInString(`Workspace: ${defaults.workspace}`));
	if (defaults?.model) {
		const model = resolveAgentModelPrimaryValue(defaults.model);
		if (model) rows.push(shortenHomeInString(`Model: ${model}`));
	}
	const gatewaySummary = summarizeGatewayConfig(config);
	if (gatewaySummary) rows.push(shortenHomeInString(gatewaySummary));
	if (config.skills?.install?.nodeManager) rows.push(shortenHomeInString(`Node manager: ${config.skills.install.nodeManager}`));
	return rows.length ? rows.join("\n") : "No key settings detected.";
}
function summarizeGatewayConfig(config) {
	const gateway = config.gateway;
	if (!gateway?.mode && typeof gateway?.port !== "number" && !gateway?.bind && !gateway?.remote?.url) return null;
	const mode = normalizeOptionalString(gateway.mode);
	const bind = formatGatewayBind(gateway.bind);
	const remoteUrl = normalizeOptionalString(gateway.remote?.url);
	const useRemoteUrl = remoteUrl !== void 0 && mode !== "local";
	const endpoint = useRemoteUrl && remoteUrl ? remoteUrl : typeof gateway.port === "number" ? `:${gateway.port}` : void 0;
	const words = [];
	if (mode) words.push(mode);
	if (bind) words.push(mode ? `via ${bind}` : bind);
	if (mode === "remote" && !remoteUrl) {
		words.push("(missing remote URL)");
		return `Gateway: ${words.join(" ")}`;
	}
	if (endpoint) words.push(`${useRemoteUrl ? "at" : "on"} ${endpoint}`);
	return `Gateway: ${words.length > 0 ? words.join(" ") : "configured"}`;
}
function formatGatewayBind(value) {
	switch (value) {
		case "lan": return "LAN";
		case "loopback": return "loopback";
		case "tailnet": return "tailnet";
		case "auto": return "auto";
		case "custom": return "custom";
		default: return normalizeOptionalString(value);
	}
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
	const bannerWidth = 54;
	const icon = decorativeEmoji("🦞");
	const title = supportsDecorativeEmoji() && icon ? `${icon} OPENCLAW ${icon}` : "OPENCLAW";
	const pad = Math.max(0, bannerWidth - visibleWidth(title));
	const header = [
		"▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
		"██░▄▄▄░██░▄▄░██░▄▄▄██░▀██░██░▄▄▀██░████░▄▄▀██░███░██",
		"██░███░██░▀▀░██░▄▄▄██░█░█░██░█████░████░▀▀░██░█░█░██",
		"██░▀▀▀░██░█████░▀▀▀██░██▄░██░▀▀▄██░▀▀░█░██░██▄▀▄▀▄██",
		"▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
		`${" ".repeat(Math.floor(pad / 2))}${title}${" ".repeat(Math.ceil(pad / 2))}`,
		" "
	].join("\n");
	runtime.log(header);
}
function applyWizardMetadata(cfg, params) {
	const commit = normalizeOptionalString(process.env.GIT_COMMIT) ?? normalizeOptionalString(process.env.GIT_SHA);
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
		"BYOH note: lan, tailnet, and custom bind are currently IPv4-only.",
		"If your host is IPv6-only, use an IPv4 sidecar or proxy in front of the Gateway.",
		"Docs:",
		"https://docs.openclaw.ai/gateway/remote",
		"https://docs.openclaw.ai/web/control-ui"
	].filter(Boolean).join("\n");
}
function resolveSshTargetHint() {
	return `${process.env.USER || process.env.LOGNAME || "user"}@${(process.env.SSH_CONNECTION?.trim().split(/\s+/))?.[2] ?? "<host>"}`;
}
async function ensureWorkspaceAndSessions(workspaceDir, runtime, options) {
	const ws = await ensureAgentWorkspace({
		dir: workspaceDir,
		ensureBootstrapFiles: !options?.skipBootstrap,
		skipOptionalBootstrapFiles: options?.skipOptionalBootstrapFiles
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
		const sourcePath = await resolveMoveToTrashSourcePath(path.resolve(pathname));
		await movePathToTrash(sourcePath, { allowedRoots: await resolveMoveToTrashAllowedRoots(sourcePath) });
		runtime.log(`Moved to Trash: ${shortenHomePath(pathname)}`);
	} catch {
		runtime.log(`Failed to move to Trash (manual delete): ${shortenHomePath(pathname)}`);
	}
}
async function resolveMoveToTrashSourcePath(targetPath) {
	return path.join(await fs.realpath(path.dirname(targetPath)), path.basename(targetPath));
}
async function resolveMoveToTrashAllowedRoots(targetPath) {
	const allowedRoots = [path.dirname(targetPath)];
	if ((await fs.lstat(targetPath)).isSymbolicLink()) try {
		allowedRoots.push(path.dirname(await fs.realpath(targetPath)));
	} catch {}
	return [...new Set(allowedRoots)];
}
async function handleReset(scope, workspaceDir, runtime) {
	await moveToTrash(resolveConfigPath(), runtime);
	if (scope === "config") return;
	await moveToTrash(path.join(resolveConfigDir(), "credentials"), runtime);
	await moveToTrash(resolveSessionTranscriptsDirForAgent(), runtime);
	if (scope === "full") await moveToTrash(workspaceDir, runtime);
}
async function probeGatewayReachable(params) {
	const url = params.url.trim();
	const timeoutMs = params.timeoutMs ?? 1500;
	try {
		const probe = await probeGateway({
			url,
			timeoutMs,
			auth: {
				token: params.token,
				password: params.password
			},
			detailLevel: "none"
		});
		return probe.ok ? { ok: true } : {
			ok: false,
			detail: probe.error ?? void 0
		};
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
//#endregion
export { guardCancel as a, normalizeGatewayTokenInput as c, resolveNodeManagerOptions as d, summarizeExistingConfig as f, formatControlUiSshHint as i, printWizardHeader as l, waitForGatewayReachable as m, applyWizardMetadata as n, handleReset as o, validateGatewayPasswordInput as p, ensureWorkspaceAndSessions as r, moveToTrash as s, DEFAULT_WORKSPACE as t, probeGatewayReachable as u };
