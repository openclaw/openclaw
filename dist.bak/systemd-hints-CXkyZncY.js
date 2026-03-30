import { t as formatCliCommand } from "./command-format-ChfKqObn.js";
import { n as isNodeRuntime, t as isBunRuntime } from "./runtime-binary-xByxn2JX.js";
import { c as isVersionManagedNodePath, f as resolveSystemNodePath, o as getMinimalServicePathPartsFromEnv, s as isSystemNodePath } from "./daemon-install-helpers-BbXZcxdV.js";
import { o as resolveSystemdUserUnitPath } from "./systemd-C5rdv1uf.js";
import { c as resolveLaunchAgentPlistPath } from "./service-gv1-6Hix.js";
import { t as formatRuntimeStatusWithDetails } from "./runtime-status-C0OBRxlq.js";
import path from "node:path";
import fs from "node:fs/promises";

//#region src/daemon/runtime-format.ts
function formatRuntimeStatus(runtime) {
	if (!runtime) return null;
	const details = [];
	if (runtime.subState) details.push(`sub ${runtime.subState}`);
	if (runtime.lastExitStatus !== void 0) details.push(`last exit ${runtime.lastExitStatus}`);
	if (runtime.lastExitReason) details.push(`reason ${runtime.lastExitReason}`);
	if (runtime.lastRunResult) details.push(`last run ${runtime.lastRunResult}`);
	if (runtime.lastRunTime) details.push(`last run time ${runtime.lastRunTime}`);
	if (runtime.detail) details.push(runtime.detail);
	return formatRuntimeStatusWithDetails({
		status: runtime.status,
		pid: runtime.pid,
		state: runtime.state,
		details
	});
}

//#endregion
//#region src/daemon/service-audit.ts
const SERVICE_AUDIT_CODES = {
	gatewayCommandMissing: "gateway-command-missing",
	gatewayEntrypointMismatch: "gateway-entrypoint-mismatch",
	gatewayPathMissing: "gateway-path-missing",
	gatewayPathMissingDirs: "gateway-path-missing-dirs",
	gatewayPathNonMinimal: "gateway-path-nonminimal",
	gatewayTokenMismatch: "gateway-token-mismatch",
	gatewayRuntimeBun: "gateway-runtime-bun",
	gatewayRuntimeNodeVersionManager: "gateway-runtime-node-version-manager",
	gatewayRuntimeNodeSystemMissing: "gateway-runtime-node-system-missing",
	gatewayTokenDrift: "gateway-token-drift",
	launchdKeepAlive: "launchd-keep-alive",
	launchdRunAtLoad: "launchd-run-at-load",
	systemdAfterNetworkOnline: "systemd-after-network-online",
	systemdRestartSec: "systemd-restart-sec",
	systemdWantsNetworkOnline: "systemd-wants-network-online"
};
function needsNodeRuntimeMigration(issues) {
	return issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeBun || issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeNodeVersionManager);
}
function hasGatewaySubcommand(programArguments) {
	return Boolean(programArguments?.some((arg) => arg === "gateway"));
}
function parseSystemdUnit(content) {
	const after = /* @__PURE__ */ new Set();
	const wants = /* @__PURE__ */ new Set();
	let restartSec;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[")) continue;
		const idx = line.indexOf("=");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (!value) continue;
		if (key === "After") {
			for (const entry of value.split(/\s+/)) if (entry) after.add(entry);
		} else if (key === "Wants") {
			for (const entry of value.split(/\s+/)) if (entry) wants.add(entry);
		} else if (key === "RestartSec") restartSec = value;
	}
	return {
		after,
		wants,
		restartSec
	};
}
function isRestartSecPreferred(value) {
	if (!value) return false;
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed)) return false;
	return Math.abs(parsed - 5) < .01;
}
async function auditSystemdUnit(env, issues) {
	const unitPath = resolveSystemdUserUnitPath(env);
	let content = "";
	try {
		content = await fs.readFile(unitPath, "utf8");
	} catch {
		return;
	}
	const parsed = parseSystemdUnit(content);
	if (!parsed.after.has("network-online.target")) issues.push({
		code: SERVICE_AUDIT_CODES.systemdAfterNetworkOnline,
		message: "Missing systemd After=network-online.target",
		detail: unitPath,
		level: "recommended"
	});
	if (!parsed.wants.has("network-online.target")) issues.push({
		code: SERVICE_AUDIT_CODES.systemdWantsNetworkOnline,
		message: "Missing systemd Wants=network-online.target",
		detail: unitPath,
		level: "recommended"
	});
	if (!isRestartSecPreferred(parsed.restartSec)) issues.push({
		code: SERVICE_AUDIT_CODES.systemdRestartSec,
		message: "RestartSec does not match the recommended 5s",
		detail: unitPath,
		level: "recommended"
	});
}
async function auditLaunchdPlist(env, issues) {
	const plistPath = resolveLaunchAgentPlistPath(env);
	let content = "";
	try {
		content = await fs.readFile(plistPath, "utf8");
	} catch {
		return;
	}
	const hasRunAtLoad = /<key>RunAtLoad<\/key>\s*<true\s*\/>/i.test(content);
	const hasKeepAlive = /<key>KeepAlive<\/key>\s*<true\s*\/>/i.test(content);
	if (!hasRunAtLoad) issues.push({
		code: SERVICE_AUDIT_CODES.launchdRunAtLoad,
		message: "LaunchAgent is missing RunAtLoad=true",
		detail: plistPath,
		level: "recommended"
	});
	if (!hasKeepAlive) issues.push({
		code: SERVICE_AUDIT_CODES.launchdKeepAlive,
		message: "LaunchAgent is missing KeepAlive=true",
		detail: plistPath,
		level: "recommended"
	});
}
function auditGatewayCommand(programArguments, issues) {
	if (!programArguments || programArguments.length === 0) return;
	if (!hasGatewaySubcommand(programArguments)) issues.push({
		code: SERVICE_AUDIT_CODES.gatewayCommandMissing,
		message: "Service command does not include the gateway subcommand",
		level: "aggressive"
	});
}
function auditGatewayToken(command, issues, expectedGatewayToken) {
	const expectedToken = expectedGatewayToken?.trim();
	if (!expectedToken) return;
	const serviceToken = command?.environment?.OPENCLAW_GATEWAY_TOKEN?.trim();
	if (serviceToken === expectedToken) return;
	issues.push({
		code: SERVICE_AUDIT_CODES.gatewayTokenMismatch,
		message: "Gateway service OPENCLAW_GATEWAY_TOKEN does not match gateway.auth.token in openclaw.json",
		detail: serviceToken ? "service token is stale" : "service token is missing",
		level: "recommended"
	});
}
function getPathModule(platform) {
	return platform === "win32" ? path.win32 : path.posix;
}
function normalizePathEntry(entry, platform) {
	const normalized = getPathModule(platform).normalize(entry).replaceAll("\\", "/");
	if (platform === "win32") return normalized.toLowerCase();
	return normalized;
}
function auditGatewayServicePath(command, issues, env, platform) {
	if (platform === "win32") return;
	const servicePath = command?.environment?.PATH;
	if (!servicePath) {
		issues.push({
			code: SERVICE_AUDIT_CODES.gatewayPathMissing,
			message: "Gateway service PATH is not set; the daemon should use a minimal PATH.",
			level: "recommended"
		});
		return;
	}
	const expected = getMinimalServicePathPartsFromEnv({
		platform,
		env
	});
	const parts = servicePath.split(getPathModule(platform).delimiter).map((entry) => entry.trim()).filter(Boolean);
	const normalizedParts = new Set(parts.map((entry) => normalizePathEntry(entry, platform)));
	const normalizedExpected = new Set(expected.map((entry) => normalizePathEntry(entry, platform)));
	const missing = expected.filter((entry) => {
		const normalized = normalizePathEntry(entry, platform);
		return !normalizedParts.has(normalized);
	});
	if (missing.length > 0) issues.push({
		code: SERVICE_AUDIT_CODES.gatewayPathMissingDirs,
		message: `Gateway service PATH missing required dirs: ${missing.join(", ")}`,
		level: "recommended"
	});
	const nonMinimal = parts.filter((entry) => {
		const normalized = normalizePathEntry(entry, platform);
		if (normalizedExpected.has(normalized)) return false;
		return normalized.includes("/.nvm/") || normalized.includes("/.fnm/") || normalized.includes("/.volta/") || normalized.includes("/.asdf/") || normalized.includes("/.n/") || normalized.includes("/.nodenv/") || normalized.includes("/.nodebrew/") || normalized.includes("/nvs/") || normalized.includes("/.local/share/pnpm/") || normalized.includes("/pnpm/") || normalized.endsWith("/pnpm");
	});
	if (nonMinimal.length > 0) issues.push({
		code: SERVICE_AUDIT_CODES.gatewayPathNonMinimal,
		message: "Gateway service PATH includes version managers or package managers; recommend a minimal PATH.",
		detail: nonMinimal.join(", "),
		level: "recommended"
	});
}
async function auditGatewayRuntime(env, command, issues, platform) {
	const execPath = command?.programArguments?.[0];
	if (!execPath) return;
	if (isBunRuntime(execPath)) {
		issues.push({
			code: SERVICE_AUDIT_CODES.gatewayRuntimeBun,
			message: "Gateway service uses Bun; Bun is incompatible with WhatsApp + Telegram channels.",
			detail: execPath,
			level: "recommended"
		});
		return;
	}
	if (!isNodeRuntime(execPath)) return;
	if (isVersionManagedNodePath(execPath, platform)) {
		issues.push({
			code: SERVICE_AUDIT_CODES.gatewayRuntimeNodeVersionManager,
			message: "Gateway service uses Node from a version manager; it can break after upgrades.",
			detail: execPath,
			level: "recommended"
		});
		if (!isSystemNodePath(execPath, env, platform)) {
			if (!await resolveSystemNodePath(env, platform)) issues.push({
				code: SERVICE_AUDIT_CODES.gatewayRuntimeNodeSystemMissing,
				message: "System Node 22+ not found; install it before migrating away from version managers.",
				level: "recommended"
			});
		}
	}
}
/**
* Check if the service's embedded token differs from the config file token.
* Returns an issue if drift is detected (service will use old token after restart).
*/
function checkTokenDrift(params) {
	const { serviceToken, configToken } = params;
	if (!serviceToken && !configToken) return null;
	if (configToken && serviceToken !== configToken) return {
		code: SERVICE_AUDIT_CODES.gatewayTokenDrift,
		message: "Config token differs from service token. The daemon will use the old token after restart.",
		detail: "Run `openclaw gateway install --force` to sync the token.",
		level: "recommended"
	};
	return null;
}
async function auditGatewayServiceConfig(params) {
	const issues = [];
	const platform = params.platform ?? process.platform;
	auditGatewayCommand(params.command?.programArguments, issues);
	auditGatewayToken(params.command, issues, params.expectedGatewayToken);
	auditGatewayServicePath(params.command, issues, params.env, platform);
	await auditGatewayRuntime(params.env, params.command, issues, platform);
	if (platform === "linux") await auditSystemdUnit(params.env, issues);
	else if (platform === "darwin") await auditLaunchdPlist(params.env, issues);
	return {
		ok: issues.length === 0,
		issues
	};
}

//#endregion
//#region src/daemon/systemd-hints.ts
function isSystemdUnavailableDetail(detail) {
	if (!detail) return false;
	const normalized = detail.toLowerCase();
	return normalized.includes("systemctl --user unavailable") || normalized.includes("systemctl not available") || normalized.includes("not been booted with systemd") || normalized.includes("failed to connect to bus") || normalized.includes("systemd user services are required");
}
function renderSystemdUnavailableHints(options = {}) {
	if (options.wsl) return [
		"WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
		"Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
		"Verify: systemctl --user status"
	];
	return ["systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.", `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway")}\`.`];
}

//#endregion
export { checkTokenDrift as a, auditGatewayServiceConfig as i, renderSystemdUnavailableHints as n, needsNodeRuntimeMigration as o, SERVICE_AUDIT_CODES as r, formatRuntimeStatus as s, isSystemdUnavailableDetail as t };