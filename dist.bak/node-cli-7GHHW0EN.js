import { $t as resolveStateDir, Et as colorize, Jt as resolveIsNixMode, Ot as theme, v as defaultRuntime } from "./entry.js";
import { Ot as analyzeArgvCommand, j as loadConfig } from "./auth-profiles-D6H-HVV8.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { i as resolveAgentConfig } from "./agent-scope-C2k6BQnt.js";
import { s as sameFileIdentity } from "./openclaw-root-C9tYgTzw.js";
import "./exec-BhaMholX.js";
import "./github-copilot-token-DKRiM6oj.js";
import { a as sanitizeSystemRunEnvOverrides, i as sanitizeHostExecEnv } from "./host-env-security-BM8ktVlo.js";
import { r as VERSION } from "./env-vars-DPtuUD7z.js";
import "./manifest-registry-HLdbjiS7.js";
import "./path-alias-guards-BpvAiXds.js";
import { h as GATEWAY_CLIENT_NAMES, m as GATEWAY_CLIENT_MODES } from "./message-channel-CJUwnCYd.js";
import "./logging-Cr3Gsq0-.js";
import { $t as loadOrCreateDeviceIdentity, t as GatewayClient } from "./client-C2kv9X_7.js";
import "./pairing-token-DzfCmsrM.js";
import "./net-DBrsyv8q.js";
import "./ip-BDxIP8rd.js";
import "./tailnet-Ca1WnFBq.js";
import { a as getMachineDisplayName, i as startBrowserControlServiceFromConfig, n as createBrowserRouteDispatcher, r as createBrowserControlContext, t as withTimeout } from "./with-timeout-WSkvNWXx.js";
import { c as detectMime } from "./image-ops-Z3_QkQPj.js";
import "./chrome-SNeFUnD_.js";
import "./tailscale-Cz0j5H8x.js";
import "./auth-ML-4Xoce.js";
import { i as resolveBrowserConfig } from "./server-context-BLhOGtRw.js";
import "./paths-DFiWeVzT.js";
import "./redact-Dcypez3H.js";
import "./errors-Cu3BYw29.js";
import "./fs-safe-BDinrAxW.js";
import "./ssrf-Bte-xH9B.js";
import "./store-BnsBHp0V.js";
import "./ports-B9YOEPbT.js";
import "./trash-C8oZT55U.js";
import { n as evaluateShellAllowlist, r as resolveAllowAlwaysPatterns, t as evaluateExecAllowlist } from "./exec-approvals-allowlist-DKADXpfV.js";
import { n as resolveExecSafeBinRuntimePolicy } from "./exec-safe-bin-runtime-policy-Cr6WvdlO.js";
import { a as mergeExecApprovalsSocketDefaults, c as readExecApprovalsSnapshot, d as resolveExecApprovals, l as recordAllowlistUse, m as requestJsonlSocket, n as addAllowlistEntry, p as saveExecApprovals, r as ensureExecApprovals, s as normalizeExecApprovals, u as requiresExecApproval } from "./exec-approvals-UjbIDJw1.js";
import { _ as resolveNodeWindowsTaskName, c as formatNodeServiceDescription, g as resolveNodeSystemdServiceName, h as resolveNodeLaunchAgentLabel } from "./constants-ChJK8ZR-.js";
import "./server-lifecycle-0IkOBKdo.js";
import { n as resolveSystemRunCommand } from "./system-run-command-BqLmA4zq.js";
import { t as formatDocsLink } from "./links-yQMT2QcX.js";
import { t as formatHelpExamples } from "./help-format-Du-bXlH0.js";
import { t as ensureOpenClawCliOnPath } from "./path-env-B8mwPGBj.js";
import { a as buildNodeServiceEnvironment, i as emitNodeRuntimeWarning, p as resolveNodeProgramArguments, r as resolveGatewayDevMode, u as resolvePreferredNodePath } from "./daemon-install-helpers-BmM-3-iQ.js";
import "./runtime-guard-jjhyM3bE.js";
import { r as isGatewayDaemonRuntime, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-CeI4hRxg.js";
import "./systemd-BGQw1gQz.js";
import { s as resolveGatewayLogPaths } from "./service-BYZQINUW.js";
import { a as createCliStatusTextStyles, f as resolveRuntimeStatusColor, g as installDaemonServiceAndEmit, h as createDaemonActionContext, i as runServiceUninstall, m as buildDaemonServiceSnapshot, r as runServiceStop, t as runServiceRestart } from "./lifecycle-core-UkD0yGKe.js";
import { s as formatRuntimeStatus } from "./systemd-hints-KijFM7Yo.js";
import { t as parsePort } from "./parse-port-DSCrRotM.js";
import { i as NODE_SYSTEM_RUN_COMMANDS, n as NODE_EXEC_APPROVALS_COMMANDS, t as NODE_BROWSER_PROXY_COMMAND } from "./node-commands-2OSlA4bi.js";
import { t as resolveNodeService } from "./node-service-YkAoOUN_.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import fs$1 from "node:fs/promises";
import crypto from "node:crypto";

//#region src/node-host/config.ts
const NODE_HOST_FILE = "node.json";
function resolveNodeHostConfigPath() {
	return path.join(resolveStateDir(), NODE_HOST_FILE);
}
function normalizeConfig(config) {
	const base = {
		version: 1,
		nodeId: "",
		token: config?.token,
		displayName: config?.displayName,
		gateway: config?.gateway
	};
	if (config?.version === 1 && typeof config.nodeId === "string") base.nodeId = config.nodeId.trim();
	if (!base.nodeId) base.nodeId = crypto.randomUUID();
	return base;
}
async function loadNodeHostConfig() {
	const filePath = resolveNodeHostConfigPath();
	try {
		const raw = await fs$1.readFile(filePath, "utf8");
		return normalizeConfig(JSON.parse(raw));
	} catch {
		return null;
	}
}
async function saveNodeHostConfig(config) {
	const filePath = resolveNodeHostConfigPath();
	await fs$1.mkdir(path.dirname(filePath), { recursive: true });
	const payload = JSON.stringify(config, null, 2);
	await fs$1.writeFile(filePath, `${payload}\n`, { mode: 384 });
	try {
		await fs$1.chmod(filePath, 384);
	} catch {}
}
async function ensureNodeHostConfig() {
	const normalized = normalizeConfig(await loadNodeHostConfig());
	await saveNodeHostConfig(normalized);
	return normalized;
}

//#endregion
//#region src/infra/exec-host.ts
async function requestExecHostViaSocket(params) {
	const { socketPath, token, request } = params;
	if (!socketPath || !token) return null;
	const timeoutMs = params.timeoutMs ?? 2e4;
	const requestJson = JSON.stringify(request);
	const nonce = crypto.randomBytes(16).toString("hex");
	const ts = Date.now();
	const hmac = crypto.createHmac("sha256", token).update(`${nonce}:${ts}:${requestJson}`).digest("hex");
	return await requestJsonlSocket({
		socketPath,
		payload: JSON.stringify({
			type: "exec",
			id: crypto.randomUUID(),
			nonce,
			ts,
			hmac,
			requestJson
		}),
		timeoutMs,
		accept: (value) => {
			const msg = value;
			if (msg?.type !== "exec-res") return;
			if (msg.ok === true && msg.payload) return {
				ok: true,
				payload: msg.payload
			};
			if (msg.ok === false && msg.error) return {
				ok: false,
				error: msg.error
			};
			return null;
		}
	});
}

//#endregion
//#region src/node-host/invoke-browser.ts
const BROWSER_PROXY_MAX_FILE_BYTES = 10 * 1024 * 1024;
function normalizeProfileAllowlist(raw) {
	return Array.isArray(raw) ? raw.map((entry) => entry.trim()).filter(Boolean) : [];
}
function resolveBrowserProxyConfig() {
	const proxy = loadConfig().nodeHost?.browserProxy;
	const allowProfiles = normalizeProfileAllowlist(proxy?.allowProfiles);
	return {
		enabled: proxy?.enabled !== false,
		allowProfiles
	};
}
let browserControlReady = null;
async function ensureBrowserControlService() {
	if (browserControlReady) return browserControlReady;
	browserControlReady = (async () => {
		const cfg = loadConfig();
		if (!resolveBrowserConfig(cfg.browser, cfg).enabled) throw new Error("browser control disabled");
		if (!await startBrowserControlServiceFromConfig()) throw new Error("browser control disabled");
	})();
	return browserControlReady;
}
function isProfileAllowed(params) {
	const { allowProfiles, profile } = params;
	if (!allowProfiles.length) return true;
	if (!profile) return false;
	return allowProfiles.includes(profile.trim());
}
function collectBrowserProxyPaths(payload) {
	const paths = /* @__PURE__ */ new Set();
	const obj = typeof payload === "object" && payload !== null ? payload : null;
	if (!obj) return [];
	if (typeof obj.path === "string" && obj.path.trim()) paths.add(obj.path.trim());
	if (typeof obj.imagePath === "string" && obj.imagePath.trim()) paths.add(obj.imagePath.trim());
	const download = obj.download;
	if (download && typeof download === "object") {
		const dlPath = download.path;
		if (typeof dlPath === "string" && dlPath.trim()) paths.add(dlPath.trim());
	}
	return [...paths];
}
async function readBrowserProxyFile(filePath) {
	const stat = await fs$1.stat(filePath).catch(() => null);
	if (!stat || !stat.isFile()) return null;
	if (stat.size > BROWSER_PROXY_MAX_FILE_BYTES) throw new Error(`browser proxy file exceeds ${Math.round(BROWSER_PROXY_MAX_FILE_BYTES / (1024 * 1024))}MB`);
	const buffer = await fs$1.readFile(filePath);
	const mimeType = await detectMime({
		buffer,
		filePath
	});
	return {
		path: filePath,
		base64: buffer.toString("base64"),
		mimeType
	};
}
function decodeParams$1(raw) {
	if (!raw) throw new Error("INVALID_REQUEST: paramsJSON required");
	return JSON.parse(raw);
}
async function runBrowserProxyCommand(paramsJSON) {
	const params = decodeParams$1(paramsJSON);
	const pathValue = typeof params.path === "string" ? params.path.trim() : "";
	if (!pathValue) throw new Error("INVALID_REQUEST: path required");
	const proxyConfig = resolveBrowserProxyConfig();
	if (!proxyConfig.enabled) throw new Error("UNAVAILABLE: node browser proxy disabled");
	await ensureBrowserControlService();
	const cfg = loadConfig();
	const resolved = resolveBrowserConfig(cfg.browser, cfg);
	const requestedProfile = typeof params.profile === "string" ? params.profile.trim() : "";
	const allowedProfiles = proxyConfig.allowProfiles;
	if (allowedProfiles.length > 0) {
		if (pathValue !== "/profiles") {
			if (!isProfileAllowed({
				allowProfiles: allowedProfiles,
				profile: requestedProfile || resolved.defaultProfile
			})) throw new Error("INVALID_REQUEST: browser profile not allowed");
		} else if (requestedProfile) {
			if (!isProfileAllowed({
				allowProfiles: allowedProfiles,
				profile: requestedProfile
			})) throw new Error("INVALID_REQUEST: browser profile not allowed");
		}
	}
	const method = typeof params.method === "string" ? params.method.toUpperCase() : "GET";
	const path = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
	const body = params.body;
	const query = {};
	if (requestedProfile) query.profile = requestedProfile;
	const rawQuery = params.query ?? {};
	for (const [key, value] of Object.entries(rawQuery)) {
		if (value === void 0 || value === null) continue;
		query[key] = typeof value === "string" ? value : String(value);
	}
	const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
	const response = await withTimeout((signal) => dispatcher.dispatch({
		method: method === "DELETE" ? "DELETE" : method === "POST" ? "POST" : "GET",
		path,
		query,
		body,
		signal
	}), params.timeoutMs, "browser proxy request");
	if (response.status >= 400) {
		const message = response.body && typeof response.body === "object" && "error" in response.body ? String(response.body.error) : `HTTP ${response.status}`;
		throw new Error(message);
	}
	const result = response.body;
	if (allowedProfiles.length > 0 && path === "/profiles") {
		const obj = typeof result === "object" && result !== null ? result : {};
		obj.profiles = (Array.isArray(obj.profiles) ? obj.profiles : []).filter((entry) => {
			if (!entry || typeof entry !== "object") return false;
			const name = entry.name;
			return typeof name === "string" && allowedProfiles.includes(name);
		});
	}
	let files;
	const paths = collectBrowserProxyPaths(result);
	if (paths.length > 0) {
		const loaded = await Promise.all(paths.map(async (p) => {
			try {
				const file = await readBrowserProxyFile(p);
				if (!file) throw new Error("file not found");
				return file;
			} catch (err) {
				throw new Error(`browser proxy file read failed for ${p}: ${String(err)}`, { cause: err });
			}
		}));
		if (loaded.length > 0) files = loaded;
	}
	const payload = files ? {
		result,
		files
	} : { result };
	return JSON.stringify(payload);
}

//#endregion
//#region src/node-host/exec-policy.ts
function resolveExecApprovalDecision(value) {
	if (value === "allow-once" || value === "allow-always") return value;
	return null;
}
function formatSystemRunAllowlistMissMessage(params) {
	if (params?.windowsShellWrapperBlocked) return "SYSTEM_RUN_DENIED: allowlist miss (Windows shell wrappers like cmd.exe /c require approval; approve once/always or run with --ask on-miss|always)";
	if (params?.shellWrapperBlocked) return "SYSTEM_RUN_DENIED: allowlist miss (shell wrappers like sh/bash/zsh -c require approval; approve once/always or run with --ask on-miss|always)";
	return "SYSTEM_RUN_DENIED: allowlist miss";
}
function evaluateSystemRunPolicy(params) {
	const shellWrapperBlocked = params.security === "allowlist" && params.shellWrapperInvocation;
	const windowsShellWrapperBlocked = shellWrapperBlocked && params.isWindows && params.cmdInvocation;
	const analysisOk = shellWrapperBlocked ? false : params.analysisOk;
	const allowlistSatisfied = shellWrapperBlocked ? false : params.allowlistSatisfied;
	const approvedByAsk = params.approvalDecision !== null || params.approved === true;
	if (params.security === "deny") return {
		allowed: false,
		eventReason: "security=deny",
		errorMessage: "SYSTEM_RUN_DISABLED: security=deny",
		analysisOk,
		allowlistSatisfied,
		shellWrapperBlocked,
		windowsShellWrapperBlocked,
		requiresAsk: false,
		approvalDecision: params.approvalDecision,
		approvedByAsk
	};
	const requiresAsk = requiresExecApproval({
		ask: params.ask,
		security: params.security,
		analysisOk,
		allowlistSatisfied
	});
	if (requiresAsk && !approvedByAsk) return {
		allowed: false,
		eventReason: "approval-required",
		errorMessage: "SYSTEM_RUN_DENIED: approval required",
		analysisOk,
		allowlistSatisfied,
		shellWrapperBlocked,
		windowsShellWrapperBlocked,
		requiresAsk,
		approvalDecision: params.approvalDecision,
		approvedByAsk
	};
	if (params.security === "allowlist" && (!analysisOk || !allowlistSatisfied) && !approvedByAsk) return {
		allowed: false,
		eventReason: "allowlist-miss",
		errorMessage: formatSystemRunAllowlistMissMessage({
			shellWrapperBlocked,
			windowsShellWrapperBlocked
		}),
		analysisOk,
		allowlistSatisfied,
		shellWrapperBlocked,
		windowsShellWrapperBlocked,
		requiresAsk,
		approvalDecision: params.approvalDecision,
		approvedByAsk
	};
	return {
		allowed: true,
		analysisOk,
		allowlistSatisfied,
		shellWrapperBlocked,
		windowsShellWrapperBlocked,
		requiresAsk,
		approvalDecision: params.approvalDecision,
		approvedByAsk
	};
}

//#endregion
//#region src/node-host/invoke-system-run-allowlist.ts
function evaluateSystemRunAllowlist(params) {
	if (params.shellCommand) {
		const allowlistEval = evaluateShellAllowlist({
			command: params.shellCommand,
			allowlist: params.approvals.allowlist,
			safeBins: params.safeBins,
			safeBinProfiles: params.safeBinProfiles,
			cwd: params.cwd,
			env: params.env,
			trustedSafeBinDirs: params.trustedSafeBinDirs,
			skillBins: params.skillBins,
			autoAllowSkills: params.autoAllowSkills,
			platform: process.platform
		});
		return {
			analysisOk: allowlistEval.analysisOk,
			allowlistMatches: allowlistEval.allowlistMatches,
			allowlistSatisfied: params.security === "allowlist" && allowlistEval.analysisOk ? allowlistEval.allowlistSatisfied : false,
			segments: allowlistEval.segments
		};
	}
	const analysis = analyzeArgvCommand({
		argv: params.argv,
		cwd: params.cwd,
		env: params.env
	});
	const allowlistEval = evaluateExecAllowlist({
		analysis,
		allowlist: params.approvals.allowlist,
		safeBins: params.safeBins,
		safeBinProfiles: params.safeBinProfiles,
		cwd: params.cwd,
		trustedSafeBinDirs: params.trustedSafeBinDirs,
		skillBins: params.skillBins,
		autoAllowSkills: params.autoAllowSkills
	});
	return {
		analysisOk: analysis.ok,
		allowlistMatches: allowlistEval.allowlistMatches,
		allowlistSatisfied: params.security === "allowlist" && analysis.ok ? allowlistEval.allowlistSatisfied : false,
		segments: analysis.segments
	};
}
function resolvePlannedAllowlistArgv(params) {
	if (params.security !== "allowlist" || params.policy.approvedByAsk || params.shellCommand || !params.policy.analysisOk || !params.policy.allowlistSatisfied || params.segments.length !== 1) return;
	const plannedAllowlistArgv = params.segments[0]?.resolution?.effectiveArgv;
	return plannedAllowlistArgv && plannedAllowlistArgv.length > 0 ? plannedAllowlistArgv : null;
}
function resolveSystemRunExecArgv(params) {
	let execArgv = params.plannedAllowlistArgv ?? params.argv;
	if (params.security === "allowlist" && params.isWindows && !params.policy.approvedByAsk && params.shellCommand && params.policy.analysisOk && params.policy.allowlistSatisfied && params.segments.length === 1 && params.segments[0]?.argv.length > 0) execArgv = params.segments[0].argv;
	return execArgv;
}
function applyOutputTruncation(result) {
	if (!result.truncated) return;
	const suffix = "... (truncated)";
	if (result.stderr.trim().length > 0) result.stderr = `${result.stderr}\n${suffix}`;
	else result.stdout = `${result.stdout}\n${suffix}`;
}

//#endregion
//#region src/node-host/invoke-system-run-plan.ts
function normalizeString(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}
function isPathLikeExecutableToken(value) {
	if (!value) return false;
	if (value.startsWith(".") || value.startsWith("/") || value.startsWith("\\")) return true;
	if (value.includes("/") || value.includes("\\")) return true;
	if (process.platform === "win32" && /^[a-zA-Z]:[\\/]/.test(value)) return true;
	return false;
}
function pathComponentsFromRootSync(targetPath) {
	const absolute = path.resolve(targetPath);
	const parts = [];
	let cursor = absolute;
	while (true) {
		parts.unshift(cursor);
		const parent = path.dirname(cursor);
		if (parent === cursor) return parts;
		cursor = parent;
	}
}
function isWritableByCurrentProcessSync(candidate) {
	try {
		fs.accessSync(candidate, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}
function hasMutableSymlinkPathComponentSync(targetPath) {
	for (const component of pathComponentsFromRootSync(targetPath)) try {
		if (!fs.lstatSync(component).isSymbolicLink()) continue;
		if (isWritableByCurrentProcessSync(path.dirname(component))) return true;
	} catch {
		return true;
	}
	return false;
}
function hardenApprovedExecutionPaths(params) {
	if (!params.approvedByAsk) return {
		ok: true,
		argv: params.argv,
		cwd: params.cwd
	};
	let hardenedCwd = params.cwd;
	if (hardenedCwd) {
		const requestedCwd = path.resolve(hardenedCwd);
		let cwdLstat;
		let cwdStat;
		let cwdReal;
		let cwdRealStat;
		try {
			cwdLstat = fs.lstatSync(requestedCwd);
			cwdStat = fs.statSync(requestedCwd);
			cwdReal = fs.realpathSync(requestedCwd);
			cwdRealStat = fs.statSync(cwdReal);
		} catch {
			return {
				ok: false,
				message: "SYSTEM_RUN_DENIED: approval requires an existing canonical cwd"
			};
		}
		if (!cwdStat.isDirectory()) return {
			ok: false,
			message: "SYSTEM_RUN_DENIED: approval requires cwd to be a directory"
		};
		if (hasMutableSymlinkPathComponentSync(requestedCwd)) return {
			ok: false,
			message: "SYSTEM_RUN_DENIED: approval requires canonical cwd (no symlink path components)"
		};
		if (cwdLstat.isSymbolicLink()) return {
			ok: false,
			message: "SYSTEM_RUN_DENIED: approval requires canonical cwd (no symlink cwd)"
		};
		if (!sameFileIdentity(cwdStat, cwdLstat) || !sameFileIdentity(cwdStat, cwdRealStat) || !sameFileIdentity(cwdLstat, cwdRealStat)) return {
			ok: false,
			message: "SYSTEM_RUN_DENIED: approval cwd identity mismatch"
		};
		hardenedCwd = cwdReal;
	}
	if (params.shellCommand !== null || params.argv.length === 0) return {
		ok: true,
		argv: params.argv,
		cwd: hardenedCwd
	};
	const argv = [...params.argv];
	const rawExecutable = argv[0] ?? "";
	if (!isPathLikeExecutableToken(rawExecutable)) return {
		ok: true,
		argv,
		cwd: hardenedCwd
	};
	const base = hardenedCwd ?? process.cwd();
	const candidate = path.isAbsolute(rawExecutable) ? rawExecutable : path.resolve(base, rawExecutable);
	try {
		argv[0] = fs.realpathSync(candidate);
	} catch {
		return {
			ok: false,
			message: "SYSTEM_RUN_DENIED: approval requires a stable executable path"
		};
	}
	return {
		ok: true,
		argv,
		cwd: hardenedCwd
	};
}
function buildSystemRunApprovalPlanV2(params) {
	const command = resolveSystemRunCommand({
		command: params.command,
		rawCommand: params.rawCommand
	});
	if (!command.ok) return {
		ok: false,
		message: command.message
	};
	if (command.argv.length === 0) return {
		ok: false,
		message: "command required"
	};
	const hardening = hardenApprovedExecutionPaths({
		approvedByAsk: true,
		argv: command.argv,
		shellCommand: command.shellCommand,
		cwd: normalizeString(params.cwd) ?? void 0
	});
	if (!hardening.ok) return {
		ok: false,
		message: hardening.message
	};
	return {
		ok: true,
		plan: {
			version: 2,
			argv: hardening.argv,
			cwd: hardening.cwd ?? null,
			rawCommand: command.cmdText.trim() || null,
			agentId: normalizeString(params.agentId),
			sessionKey: normalizeString(params.sessionKey)
		},
		cmdText: command.cmdText
	};
}

//#endregion
//#region src/node-host/invoke-system-run.ts
const safeBinTrustedDirWarningCache = /* @__PURE__ */ new Set();
function warnWritableTrustedDirOnce(message) {
	if (safeBinTrustedDirWarningCache.has(message)) return;
	safeBinTrustedDirWarningCache.add(message);
	console.warn(message);
}
function normalizeDeniedReason(reason) {
	switch (reason) {
		case "security=deny":
		case "approval-required":
		case "allowlist-miss":
		case "execution-plan-miss":
		case "companion-unavailable":
		case "permission:screenRecording": return reason;
		default: return "approval-required";
	}
}
async function sendSystemRunDenied(opts, execution, params) {
	await opts.sendNodeEvent(opts.client, "exec.denied", opts.buildExecEventPayload({
		sessionKey: execution.sessionKey,
		runId: execution.runId,
		host: "node",
		command: execution.cmdText,
		reason: params.reason
	}));
	await opts.sendInvokeResult({
		ok: false,
		error: {
			code: "UNAVAILABLE",
			message: params.message
		}
	});
}
async function parseSystemRunPhase(opts) {
	const command = resolveSystemRunCommand({
		command: opts.params.command,
		rawCommand: opts.params.rawCommand
	});
	if (!command.ok) {
		await opts.sendInvokeResult({
			ok: false,
			error: {
				code: "INVALID_REQUEST",
				message: command.message
			}
		});
		return null;
	}
	if (command.argv.length === 0) {
		await opts.sendInvokeResult({
			ok: false,
			error: {
				code: "INVALID_REQUEST",
				message: "command required"
			}
		});
		return null;
	}
	const shellCommand = command.shellCommand;
	const cmdText = command.cmdText;
	const agentId = opts.params.agentId?.trim() || void 0;
	const sessionKey = opts.params.sessionKey?.trim() || "node";
	const runId = opts.params.runId?.trim() || crypto.randomUUID();
	const envOverrides = sanitizeSystemRunEnvOverrides({
		overrides: opts.params.env ?? void 0,
		shellWrapper: shellCommand !== null
	});
	return {
		argv: command.argv,
		shellCommand,
		cmdText,
		agentId,
		sessionKey,
		runId,
		execution: {
			sessionKey,
			runId,
			cmdText
		},
		approvalDecision: resolveExecApprovalDecision(opts.params.approvalDecision),
		envOverrides,
		env: opts.sanitizeEnv(envOverrides),
		cwd: opts.params.cwd?.trim() || void 0,
		timeoutMs: opts.params.timeoutMs ?? void 0,
		needsScreenRecording: opts.params.needsScreenRecording === true,
		approved: opts.params.approved === true
	};
}
async function evaluateSystemRunPolicyPhase(opts, parsed) {
	const cfg = loadConfig();
	const agentExec = parsed.agentId ? resolveAgentConfig(cfg, parsed.agentId)?.tools?.exec : void 0;
	const configuredSecurity = opts.resolveExecSecurity(agentExec?.security ?? cfg.tools?.exec?.security);
	const configuredAsk = opts.resolveExecAsk(agentExec?.ask ?? cfg.tools?.exec?.ask);
	const approvals = resolveExecApprovals(parsed.agentId, {
		security: configuredSecurity,
		ask: configuredAsk
	});
	const security = approvals.agent.security;
	const ask = approvals.agent.ask;
	const autoAllowSkills = approvals.agent.autoAllowSkills;
	const { safeBins, safeBinProfiles, trustedSafeBinDirs } = resolveExecSafeBinRuntimePolicy({
		global: cfg.tools?.exec,
		local: agentExec,
		onWarning: warnWritableTrustedDirOnce
	});
	const bins = autoAllowSkills ? await opts.skillBins.current() : [];
	let { analysisOk, allowlistMatches, allowlistSatisfied, segments } = evaluateSystemRunAllowlist({
		shellCommand: parsed.shellCommand,
		argv: parsed.argv,
		approvals,
		security,
		safeBins,
		safeBinProfiles,
		trustedSafeBinDirs,
		cwd: parsed.cwd,
		env: parsed.env,
		skillBins: bins,
		autoAllowSkills
	});
	const isWindows = process.platform === "win32";
	const cmdInvocation = parsed.shellCommand ? opts.isCmdExeInvocation(segments[0]?.argv ?? []) : opts.isCmdExeInvocation(parsed.argv);
	const policy = evaluateSystemRunPolicy({
		security,
		ask,
		analysisOk,
		allowlistSatisfied,
		approvalDecision: parsed.approvalDecision,
		approved: parsed.approved,
		isWindows,
		cmdInvocation,
		shellWrapperInvocation: parsed.shellCommand !== null
	});
	analysisOk = policy.analysisOk;
	allowlistSatisfied = policy.allowlistSatisfied;
	if (!policy.allowed) {
		await sendSystemRunDenied(opts, parsed.execution, {
			reason: policy.eventReason,
			message: policy.errorMessage
		});
		return null;
	}
	if (security === "allowlist" && parsed.shellCommand && !policy.approvedByAsk) {
		await sendSystemRunDenied(opts, parsed.execution, {
			reason: "approval-required",
			message: "SYSTEM_RUN_DENIED: approval required"
		});
		return null;
	}
	const hardenedPaths = hardenApprovedExecutionPaths({
		approvedByAsk: policy.approvedByAsk,
		argv: parsed.argv,
		shellCommand: parsed.shellCommand,
		cwd: parsed.cwd
	});
	if (!hardenedPaths.ok) {
		await sendSystemRunDenied(opts, parsed.execution, {
			reason: "approval-required",
			message: hardenedPaths.message
		});
		return null;
	}
	const plannedAllowlistArgv = resolvePlannedAllowlistArgv({
		security,
		shellCommand: parsed.shellCommand,
		policy,
		segments
	});
	if (plannedAllowlistArgv === null) {
		await sendSystemRunDenied(opts, parsed.execution, {
			reason: "execution-plan-miss",
			message: "SYSTEM_RUN_DENIED: execution plan mismatch"
		});
		return null;
	}
	return {
		...parsed,
		argv: hardenedPaths.argv,
		cwd: hardenedPaths.cwd,
		approvals,
		security,
		policy,
		allowlistMatches,
		analysisOk,
		allowlistSatisfied,
		segments,
		plannedAllowlistArgv: plannedAllowlistArgv ?? void 0,
		isWindows
	};
}
async function executeSystemRunPhase(opts, phase) {
	if (opts.preferMacAppExecHost) {
		const execRequest = {
			command: phase.plannedAllowlistArgv ?? phase.argv,
			rawCommand: phase.cmdText || null,
			cwd: phase.cwd ?? null,
			env: phase.envOverrides ?? null,
			timeoutMs: phase.timeoutMs ?? null,
			needsScreenRecording: phase.needsScreenRecording,
			agentId: phase.agentId ?? null,
			sessionKey: phase.sessionKey ?? null,
			approvalDecision: phase.approvalDecision
		};
		const response = await opts.runViaMacAppExecHost({
			approvals: phase.approvals,
			request: execRequest
		});
		if (!response) {
			if (opts.execHostEnforced || !opts.execHostFallbackAllowed) {
				await sendSystemRunDenied(opts, phase.execution, {
					reason: "companion-unavailable",
					message: "COMPANION_APP_UNAVAILABLE: macOS app exec host unreachable"
				});
				return;
			}
		} else if (!response.ok) {
			await sendSystemRunDenied(opts, phase.execution, {
				reason: normalizeDeniedReason(response.error.reason),
				message: response.error.message
			});
			return;
		} else {
			const result = response.payload;
			await opts.sendExecFinishedEvent({
				sessionKey: phase.sessionKey,
				runId: phase.runId,
				cmdText: phase.cmdText,
				result
			});
			await opts.sendInvokeResult({
				ok: true,
				payloadJSON: JSON.stringify(result)
			});
			return;
		}
	}
	if (phase.policy.approvalDecision === "allow-always" && phase.security === "allowlist") {
		if (phase.policy.analysisOk) {
			const patterns = resolveAllowAlwaysPatterns({
				segments: phase.segments,
				cwd: phase.cwd,
				env: phase.env,
				platform: process.platform
			});
			for (const pattern of patterns) if (pattern) addAllowlistEntry(phase.approvals.file, phase.agentId, pattern);
		}
	}
	if (phase.allowlistMatches.length > 0) {
		const seen = /* @__PURE__ */ new Set();
		for (const match of phase.allowlistMatches) {
			if (!match?.pattern || seen.has(match.pattern)) continue;
			seen.add(match.pattern);
			recordAllowlistUse(phase.approvals.file, phase.agentId, match, phase.cmdText, phase.segments[0]?.resolution?.resolvedPath);
		}
	}
	if (phase.needsScreenRecording) {
		await sendSystemRunDenied(opts, phase.execution, {
			reason: "permission:screenRecording",
			message: "PERMISSION_MISSING: screenRecording"
		});
		return;
	}
	const execArgv = resolveSystemRunExecArgv({
		plannedAllowlistArgv: phase.plannedAllowlistArgv,
		argv: phase.argv,
		security: phase.security,
		isWindows: phase.isWindows,
		policy: phase.policy,
		shellCommand: phase.shellCommand,
		segments: phase.segments
	});
	const result = await opts.runCommand(execArgv, phase.cwd, phase.env, phase.timeoutMs);
	applyOutputTruncation(result);
	await opts.sendExecFinishedEvent({
		sessionKey: phase.sessionKey,
		runId: phase.runId,
		cmdText: phase.cmdText,
		result
	});
	await opts.sendInvokeResult({
		ok: true,
		payloadJSON: JSON.stringify({
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			success: result.success,
			stdout: result.stdout,
			stderr: result.stderr,
			error: result.error ?? null
		})
	});
}
async function handleSystemRunInvoke(opts) {
	const parsed = await parseSystemRunPhase(opts);
	if (!parsed) return;
	const policyPhase = await evaluateSystemRunPolicyPhase(opts, parsed);
	if (!policyPhase) return;
	await executeSystemRunPhase(opts, policyPhase);
}

//#endregion
//#region src/node-host/invoke.ts
const OUTPUT_CAP = 2e5;
const OUTPUT_EVENT_TAIL = 2e4;
const DEFAULT_NODE_PATH$1 = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const execHostEnforced = process.env.OPENCLAW_NODE_EXEC_HOST?.trim().toLowerCase() === "app";
const execHostFallbackAllowed = process.env.OPENCLAW_NODE_EXEC_FALLBACK?.trim().toLowerCase() !== "0";
const preferMacAppExecHost = process.platform === "darwin" && execHostEnforced;
function resolveExecSecurity(value) {
	return value === "deny" || value === "allowlist" || value === "full" ? value : "allowlist";
}
function isCmdExeInvocation(argv) {
	const token = argv[0]?.trim();
	if (!token) return false;
	const base = path.win32.basename(token).toLowerCase();
	return base === "cmd.exe" || base === "cmd";
}
function resolveExecAsk(value) {
	return value === "off" || value === "on-miss" || value === "always" ? value : "on-miss";
}
function sanitizeEnv(overrides) {
	return sanitizeHostExecEnv({
		overrides,
		blockPathOverrides: true
	});
}
function truncateOutput(raw, maxChars) {
	if (raw.length <= maxChars) return {
		text: raw,
		truncated: false
	};
	return {
		text: `... (truncated) ${raw.slice(raw.length - maxChars)}`,
		truncated: true
	};
}
function redactExecApprovals(file) {
	const socketPath = file.socket?.path?.trim();
	return {
		...file,
		socket: socketPath ? { path: socketPath } : void 0
	};
}
function requireExecApprovalsBaseHash(params, snapshot) {
	if (!snapshot.exists) return;
	if (!snapshot.hash) throw new Error("INVALID_REQUEST: exec approvals base hash unavailable; reload and retry");
	const baseHash = typeof params.baseHash === "string" ? params.baseHash.trim() : "";
	if (!baseHash) throw new Error("INVALID_REQUEST: exec approvals base hash required; reload and retry");
	if (baseHash !== snapshot.hash) throw new Error("INVALID_REQUEST: exec approvals changed; reload and retry");
}
async function runCommand(argv, cwd, env, timeoutMs) {
	return await new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let outputLen = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;
		const child = spawn(argv[0], argv.slice(1), {
			cwd,
			env,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		const onChunk = (chunk, target) => {
			if (outputLen >= OUTPUT_CAP) {
				truncated = true;
				return;
			}
			const remaining = OUTPUT_CAP - outputLen;
			const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
			const str = slice.toString("utf8");
			outputLen += slice.length;
			if (target === "stdout") stdout += str;
			else stderr += str;
			if (chunk.length > remaining) truncated = true;
		};
		child.stdout?.on("data", (chunk) => onChunk(chunk, "stdout"));
		child.stderr?.on("data", (chunk) => onChunk(chunk, "stderr"));
		let timer;
		if (timeoutMs && timeoutMs > 0) timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {}
		}, timeoutMs);
		const finalize = (exitCode, error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({
				exitCode,
				timedOut,
				success: exitCode === 0 && !timedOut && !error,
				stdout,
				stderr,
				error: error ?? null,
				truncated
			});
		};
		child.on("error", (err) => {
			finalize(void 0, err.message);
		});
		child.on("exit", (code) => {
			finalize(code === null ? void 0 : code, null);
		});
	});
}
function resolveEnvPath(env) {
	return (env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? DEFAULT_NODE_PATH$1).split(path.delimiter).filter(Boolean);
}
function resolveExecutable(bin, env) {
	if (bin.includes("/") || bin.includes("\\")) return null;
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? process.env.PathExt ?? ".EXE;.CMD;.BAT;.COM").split(";").map((ext) => ext.toLowerCase()) : [""];
	for (const dir of resolveEnvPath(env)) for (const ext of extensions) {
		const candidate = path.join(dir, bin + ext);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}
async function handleSystemWhich(params, env) {
	const bins = params.bins.map((bin) => bin.trim()).filter(Boolean);
	const found = {};
	for (const bin of bins) {
		const path = resolveExecutable(bin, env);
		if (path) found[bin] = path;
	}
	return { bins: found };
}
function buildExecEventPayload(payload) {
	if (!payload.output) return payload;
	const trimmed = payload.output.trim();
	if (!trimmed) return payload;
	const { text } = truncateOutput(trimmed, OUTPUT_EVENT_TAIL);
	return {
		...payload,
		output: text
	};
}
async function sendExecFinishedEvent(params) {
	const combined = [
		params.result.stdout,
		params.result.stderr,
		params.result.error
	].filter(Boolean).join("\n");
	await sendNodeEvent(params.client, "exec.finished", buildExecEventPayload({
		sessionKey: params.sessionKey,
		runId: params.runId,
		host: "node",
		command: params.cmdText,
		exitCode: params.result.exitCode ?? void 0,
		timedOut: params.result.timedOut,
		success: params.result.success,
		output: combined
	}));
}
async function runViaMacAppExecHost(params) {
	const { approvals, request } = params;
	return await requestExecHostViaSocket({
		socketPath: approvals.socketPath,
		token: approvals.token,
		request
	});
}
async function sendJsonPayloadResult(client, frame, payload) {
	await sendInvokeResult(client, frame, {
		ok: true,
		payloadJSON: JSON.stringify(payload)
	});
}
async function sendRawPayloadResult(client, frame, payloadJSON) {
	await sendInvokeResult(client, frame, {
		ok: true,
		payloadJSON
	});
}
async function sendErrorResult(client, frame, code, message) {
	await sendInvokeResult(client, frame, {
		ok: false,
		error: {
			code,
			message
		}
	});
}
async function sendInvalidRequestResult(client, frame, err) {
	await sendErrorResult(client, frame, "INVALID_REQUEST", String(err));
}
async function handleInvoke(frame, client, skillBins) {
	const command = String(frame.command ?? "");
	if (command === "system.execApprovals.get") {
		try {
			ensureExecApprovals();
			const snapshot = readExecApprovalsSnapshot();
			await sendJsonPayloadResult(client, frame, {
				path: snapshot.path,
				exists: snapshot.exists,
				hash: snapshot.hash,
				file: redactExecApprovals(snapshot.file)
			});
		} catch (err) {
			const message = String(err);
			await sendErrorResult(client, frame, message.toLowerCase().includes("timed out") ? "TIMEOUT" : "INVALID_REQUEST", message);
		}
		return;
	}
	if (command === "system.execApprovals.set") {
		try {
			const params = decodeParams(frame.paramsJSON);
			if (!params.file || typeof params.file !== "object") throw new Error("INVALID_REQUEST: exec approvals file required");
			ensureExecApprovals();
			const snapshot = readExecApprovalsSnapshot();
			requireExecApprovalsBaseHash(params, snapshot);
			saveExecApprovals(mergeExecApprovalsSocketDefaults({
				normalized: normalizeExecApprovals(params.file),
				current: snapshot.file
			}));
			const nextSnapshot = readExecApprovalsSnapshot();
			await sendJsonPayloadResult(client, frame, {
				path: nextSnapshot.path,
				exists: nextSnapshot.exists,
				hash: nextSnapshot.hash,
				file: redactExecApprovals(nextSnapshot.file)
			});
		} catch (err) {
			await sendInvalidRequestResult(client, frame, err);
		}
		return;
	}
	if (command === "system.which") {
		try {
			const params = decodeParams(frame.paramsJSON);
			if (!Array.isArray(params.bins)) throw new Error("INVALID_REQUEST: bins required");
			await sendJsonPayloadResult(client, frame, await handleSystemWhich(params, sanitizeEnv(void 0)));
		} catch (err) {
			await sendInvalidRequestResult(client, frame, err);
		}
		return;
	}
	if (command === "browser.proxy") {
		try {
			await sendRawPayloadResult(client, frame, await runBrowserProxyCommand(frame.paramsJSON));
		} catch (err) {
			await sendInvalidRequestResult(client, frame, err);
		}
		return;
	}
	if (command === "system.run.prepare") {
		try {
			const prepared = buildSystemRunApprovalPlanV2(decodeParams(frame.paramsJSON));
			if (!prepared.ok) {
				await sendErrorResult(client, frame, "INVALID_REQUEST", prepared.message);
				return;
			}
			await sendJsonPayloadResult(client, frame, {
				cmdText: prepared.cmdText,
				plan: prepared.plan
			});
		} catch (err) {
			await sendInvalidRequestResult(client, frame, err);
		}
		return;
	}
	if (command !== "system.run") {
		await sendErrorResult(client, frame, "UNAVAILABLE", "command not supported");
		return;
	}
	let params;
	try {
		params = decodeParams(frame.paramsJSON);
	} catch (err) {
		await sendInvalidRequestResult(client, frame, err);
		return;
	}
	if (!Array.isArray(params.command) || params.command.length === 0) {
		await sendErrorResult(client, frame, "INVALID_REQUEST", "command required");
		return;
	}
	await handleSystemRunInvoke({
		client,
		params,
		skillBins,
		execHostEnforced,
		execHostFallbackAllowed,
		resolveExecSecurity,
		resolveExecAsk,
		isCmdExeInvocation,
		sanitizeEnv,
		runCommand,
		runViaMacAppExecHost,
		sendNodeEvent,
		buildExecEventPayload,
		sendInvokeResult: async (result) => {
			await sendInvokeResult(client, frame, result);
		},
		sendExecFinishedEvent: async ({ sessionKey, runId, cmdText, result }) => {
			await sendExecFinishedEvent({
				client,
				sessionKey,
				runId,
				cmdText,
				result
			});
		},
		preferMacAppExecHost
	});
}
function decodeParams(raw) {
	if (!raw) throw new Error("INVALID_REQUEST: paramsJSON required");
	return JSON.parse(raw);
}
function coerceNodeInvokePayload(payload) {
	if (!payload || typeof payload !== "object") return null;
	const obj = payload;
	const id = typeof obj.id === "string" ? obj.id.trim() : "";
	const nodeId = typeof obj.nodeId === "string" ? obj.nodeId.trim() : "";
	const command = typeof obj.command === "string" ? obj.command.trim() : "";
	if (!id || !nodeId || !command) return null;
	return {
		id,
		nodeId,
		command,
		paramsJSON: typeof obj.paramsJSON === "string" ? obj.paramsJSON : obj.params !== void 0 ? JSON.stringify(obj.params) : null,
		timeoutMs: typeof obj.timeoutMs === "number" ? obj.timeoutMs : null,
		idempotencyKey: typeof obj.idempotencyKey === "string" ? obj.idempotencyKey : null
	};
}
async function sendInvokeResult(client, frame, result) {
	try {
		await client.request("node.invoke.result", buildNodeInvokeResultParams(frame, result));
	} catch {}
}
function buildNodeInvokeResultParams(frame, result) {
	const params = {
		id: frame.id,
		nodeId: frame.nodeId,
		ok: result.ok
	};
	if (result.payload !== void 0) params.payload = result.payload;
	if (typeof result.payloadJSON === "string") params.payloadJSON = result.payloadJSON;
	if (result.error) params.error = result.error;
	return params;
}
async function sendNodeEvent(client, event, payload) {
	try {
		await client.request("node.event", {
			event,
			payloadJSON: payload ? JSON.stringify(payload) : null
		});
	} catch {}
}

//#endregion
//#region src/node-host/runner.ts
const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
function isExecutableFile(filePath) {
	try {
		if (!fs.statSync(filePath).isFile()) return false;
		if (process.platform !== "win32") fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function resolveExecutablePathFromEnv(bin, pathEnv) {
	if (bin.includes("/") || bin.includes("\\")) return null;
	const hasExtension = process.platform === "win32" && path.extname(bin).length > 0;
	const extensions = process.platform === "win32" ? hasExtension ? [""] : (process.env.PATHEXT ?? process.env.PathExt ?? ".EXE;.CMD;.BAT;.COM").split(";").map((ext) => ext.toLowerCase()) : [""];
	for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) for (const ext of extensions) {
		const candidate = path.join(dir, bin + ext);
		if (isExecutableFile(candidate)) return candidate;
	}
	return null;
}
function resolveSkillBinTrustEntries(bins, pathEnv) {
	const trustEntries = [];
	const seen = /* @__PURE__ */ new Set();
	for (const bin of bins) {
		const name = bin.trim();
		if (!name) continue;
		const resolvedPath = resolveExecutablePathFromEnv(name, pathEnv);
		if (!resolvedPath) continue;
		const key = `${name}\u0000${resolvedPath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		trustEntries.push({
			name,
			resolvedPath
		});
	}
	return trustEntries.toSorted((left, right) => left.name.localeCompare(right.name) || left.resolvedPath.localeCompare(right.resolvedPath));
}
var SkillBinsCache = class {
	constructor(fetch, pathEnv) {
		this.bins = [];
		this.lastRefresh = 0;
		this.ttlMs = 9e4;
		this.fetch = fetch;
		this.pathEnv = pathEnv;
	}
	async current(force = false) {
		if (force || Date.now() - this.lastRefresh > this.ttlMs) await this.refresh();
		return this.bins;
	}
	async refresh() {
		try {
			this.bins = resolveSkillBinTrustEntries(await this.fetch(), this.pathEnv);
			this.lastRefresh = Date.now();
		} catch {
			if (!this.lastRefresh) this.bins = [];
		}
	}
};
function ensureNodePathEnv() {
	ensureOpenClawCliOnPath({ pathEnv: process.env.PATH ?? "" });
	const current = process.env.PATH ?? "";
	if (current.trim()) return current;
	process.env.PATH = DEFAULT_NODE_PATH;
	return DEFAULT_NODE_PATH;
}
async function runNodeHost(opts) {
	const config = await ensureNodeHostConfig();
	const nodeId = opts.nodeId?.trim() || config.nodeId;
	if (nodeId !== config.nodeId) config.nodeId = nodeId;
	const displayName = opts.displayName?.trim() || config.displayName || await getMachineDisplayName();
	config.displayName = displayName;
	const gateway = {
		host: opts.gatewayHost,
		port: opts.gatewayPort,
		tls: opts.gatewayTls ?? loadConfig().gateway?.tls?.enabled ?? false,
		tlsFingerprint: opts.gatewayTlsFingerprint
	};
	config.gateway = gateway;
	await saveNodeHostConfig(config);
	const cfg = loadConfig();
	const resolvedBrowser = resolveBrowserConfig(cfg.browser, cfg);
	const browserProxyEnabled = cfg.nodeHost?.browserProxy?.enabled !== false && resolvedBrowser.enabled;
	const isRemoteMode = cfg.gateway?.mode === "remote";
	const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || (isRemoteMode ? cfg.gateway?.remote?.token : cfg.gateway?.auth?.token);
	const password = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || (isRemoteMode ? cfg.gateway?.remote?.password : cfg.gateway?.auth?.password);
	const host = gateway.host ?? "127.0.0.1";
	const port = gateway.port ?? 18789;
	const url = `${gateway.tls ? "wss" : "ws"}://${host}:${port}`;
	const pathEnv = ensureNodePathEnv();
	console.log(`node host PATH: ${pathEnv}`);
	const client = new GatewayClient({
		url,
		token: token?.trim() || void 0,
		password: password?.trim() || void 0,
		instanceId: nodeId,
		clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
		clientDisplayName: displayName,
		clientVersion: VERSION,
		platform: process.platform,
		mode: GATEWAY_CLIENT_MODES.NODE,
		role: "node",
		scopes: [],
		caps: ["system", ...browserProxyEnabled ? ["browser"] : []],
		commands: [
			...NODE_SYSTEM_RUN_COMMANDS,
			...NODE_EXEC_APPROVALS_COMMANDS,
			...browserProxyEnabled ? [NODE_BROWSER_PROXY_COMMAND] : []
		],
		pathEnv,
		permissions: void 0,
		deviceIdentity: loadOrCreateDeviceIdentity(),
		tlsFingerprint: gateway.tlsFingerprint,
		onEvent: (evt) => {
			if (evt.event !== "node.invoke.request") return;
			const payload = coerceNodeInvokePayload(evt.payload);
			if (!payload) return;
			handleInvoke(payload, client, skillBins);
		},
		onConnectError: (err) => {
			console.error(`node host gateway connect failed: ${err.message}`);
		},
		onClose: (code, reason) => {
			console.error(`node host gateway closed (${code}): ${reason}`);
		}
	});
	const skillBins = new SkillBinsCache(async () => {
		const res = await client.request("skills.bins", {});
		return Array.isArray(res?.bins) ? res.bins.map((bin) => String(bin)) : [];
	}, pathEnv);
	client.start();
	await new Promise(() => {});
}

//#endregion
//#region src/commands/node-daemon-install-helpers.ts
async function buildNodeInstallPlan(params) {
	const devMode = params.devMode ?? resolveGatewayDevMode();
	const nodePath = params.nodePath ?? await resolvePreferredNodePath({
		env: params.env,
		runtime: params.runtime
	});
	const { programArguments, workingDirectory } = await resolveNodeProgramArguments({
		host: params.host,
		port: params.port,
		tls: params.tls,
		tlsFingerprint: params.tlsFingerprint,
		nodeId: params.nodeId,
		displayName: params.displayName,
		dev: devMode,
		runtime: params.runtime,
		nodePath
	});
	await emitNodeRuntimeWarning({
		env: params.env,
		runtime: params.runtime,
		nodeProgram: programArguments[0],
		warn: params.warn,
		title: "Node daemon runtime"
	});
	const environment = buildNodeServiceEnvironment({ env: params.env });
	return {
		programArguments,
		workingDirectory,
		environment,
		description: formatNodeServiceDescription({ version: environment.OPENCLAW_SERVICE_VERSION })
	};
}

//#endregion
//#region src/commands/node-daemon-runtime.ts
const DEFAULT_NODE_DAEMON_RUNTIME = DEFAULT_GATEWAY_DAEMON_RUNTIME;
function isNodeDaemonRuntime(value) {
	return isGatewayDaemonRuntime(value);
}

//#endregion
//#region src/cli/node-cli/daemon.ts
function renderNodeServiceStartHints() {
	const base = [formatCliCommand("openclaw node install"), formatCliCommand("openclaw node start")];
	switch (process.platform) {
		case "darwin": return [...base, `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/${resolveNodeLaunchAgentLabel()}.plist`];
		case "linux": return [...base, `systemctl --user start ${resolveNodeSystemdServiceName()}.service`];
		case "win32": return [...base, `schtasks /Run /TN "${resolveNodeWindowsTaskName()}"`];
		default: return base;
	}
}
function buildNodeRuntimeHints(env = process.env) {
	if (process.platform === "darwin") {
		const logs = resolveGatewayLogPaths(env);
		return [`Launchd stdout (if installed): ${logs.stdoutPath}`, `Launchd stderr (if installed): ${logs.stderrPath}`];
	}
	if (process.platform === "linux") return [`Logs: journalctl --user -u ${resolveNodeSystemdServiceName()}.service -n 200 --no-pager`];
	if (process.platform === "win32") return [`Logs: schtasks /Query /TN "${resolveNodeWindowsTaskName()}" /V /FO LIST`];
	return [];
}
function resolveNodeDefaults(opts, config) {
	const host = opts.host?.trim() || config?.gateway?.host || "127.0.0.1";
	const portOverride = parsePort(opts.port);
	if (opts.port !== void 0 && portOverride === null) return {
		host,
		port: null
	};
	return {
		host,
		port: portOverride ?? config?.gateway?.port ?? 18789
	};
}
async function runNodeDaemonInstall(opts) {
	const json = Boolean(opts.json);
	const { stdout, warnings, emit, fail } = createDaemonActionContext({
		action: "install",
		json
	});
	if (resolveIsNixMode(process.env)) {
		fail("Nix mode detected; service install is disabled.");
		return;
	}
	const config = await loadNodeHostConfig();
	const { host, port } = resolveNodeDefaults(opts, config);
	if (!Number.isFinite(port ?? NaN) || (port ?? 0) <= 0) {
		fail("Invalid port");
		return;
	}
	const runtimeRaw = opts.runtime ? String(opts.runtime) : DEFAULT_NODE_DAEMON_RUNTIME;
	if (!isNodeDaemonRuntime(runtimeRaw)) {
		fail("Invalid --runtime (use \"node\" or \"bun\")");
		return;
	}
	const service = resolveNodeService();
	let loaded = false;
	try {
		loaded = await service.isLoaded({ env: process.env });
	} catch (err) {
		fail(`Node service check failed: ${String(err)}`);
		return;
	}
	if (loaded && !opts.force) {
		emit({
			ok: true,
			result: "already-installed",
			message: `Node service already ${service.loadedText}.`,
			service: buildDaemonServiceSnapshot(service, loaded),
			warnings: warnings.length ? warnings : void 0
		});
		if (!json) {
			defaultRuntime.log(`Node service already ${service.loadedText}.`);
			defaultRuntime.log(`Reinstall with: ${formatCliCommand("openclaw node install --force")}`);
		}
		return;
	}
	const tlsFingerprint = opts.tlsFingerprint?.trim() || config?.gateway?.tlsFingerprint;
	const tls = Boolean(opts.tls) || Boolean(tlsFingerprint) || Boolean(config?.gateway?.tls);
	const { programArguments, workingDirectory, environment, description } = await buildNodeInstallPlan({
		env: process.env,
		host,
		port: port ?? 18789,
		tls,
		tlsFingerprint: tlsFingerprint || void 0,
		nodeId: opts.nodeId,
		displayName: opts.displayName,
		runtime: runtimeRaw,
		warn: (message) => {
			if (json) warnings.push(message);
			else defaultRuntime.log(message);
		}
	});
	await installDaemonServiceAndEmit({
		serviceNoun: "Node",
		service,
		warnings,
		emit,
		fail,
		install: async () => {
			await service.install({
				env: process.env,
				stdout,
				programArguments,
				workingDirectory,
				environment,
				description
			});
		}
	});
}
async function runNodeDaemonUninstall(opts = {}) {
	return await runServiceUninstall({
		serviceNoun: "Node",
		service: resolveNodeService(),
		opts,
		stopBeforeUninstall: false,
		assertNotLoadedAfterUninstall: false
	});
}
async function runNodeDaemonRestart(opts = {}) {
	await runServiceRestart({
		serviceNoun: "Node",
		service: resolveNodeService(),
		renderStartHints: renderNodeServiceStartHints,
		opts
	});
}
async function runNodeDaemonStop(opts = {}) {
	return await runServiceStop({
		serviceNoun: "Node",
		service: resolveNodeService(),
		opts
	});
}
async function runNodeDaemonStatus(opts = {}) {
	const json = Boolean(opts.json);
	const service = resolveNodeService();
	const [loaded, command, runtime] = await Promise.all([
		service.isLoaded({ env: process.env }).catch(() => false),
		service.readCommand(process.env).catch(() => null),
		service.readRuntime(process.env).catch((err) => ({
			status: "unknown",
			detail: String(err)
		}))
	]);
	const payload = { service: {
		...buildDaemonServiceSnapshot(service, loaded),
		command,
		runtime
	} };
	if (json) {
		defaultRuntime.log(JSON.stringify(payload, null, 2));
		return;
	}
	const { rich, label, accent, infoText, okText, warnText, errorText } = createCliStatusTextStyles();
	const serviceStatus = loaded ? okText(service.loadedText) : warnText(service.notLoadedText);
	defaultRuntime.log(`${label("Service:")} ${accent(service.label)} (${serviceStatus})`);
	if (command?.programArguments?.length) defaultRuntime.log(`${label("Command:")} ${infoText(command.programArguments.join(" "))}`);
	if (command?.sourcePath) defaultRuntime.log(`${label("Service file:")} ${infoText(command.sourcePath)}`);
	if (command?.workingDirectory) defaultRuntime.log(`${label("Working dir:")} ${infoText(command.workingDirectory)}`);
	const runtimeLine = formatRuntimeStatus(runtime);
	if (runtimeLine) {
		const runtimeColor = resolveRuntimeStatusColor(runtime?.status);
		defaultRuntime.log(`${label("Runtime:")} ${colorize(rich, runtimeColor, runtimeLine)}`);
	}
	if (!loaded) {
		defaultRuntime.log("");
		for (const hint of renderNodeServiceStartHints()) defaultRuntime.log(`${warnText("Start with:")} ${infoText(hint)}`);
		return;
	}
	const baseEnv = {
		...process.env,
		...command?.environment ?? void 0
	};
	const hintEnv = {
		...baseEnv,
		OPENCLAW_LOG_PREFIX: baseEnv.OPENCLAW_LOG_PREFIX ?? "node"
	};
	if (runtime?.missingUnit) {
		defaultRuntime.error(errorText("Service unit not found."));
		for (const hint of buildNodeRuntimeHints(hintEnv)) defaultRuntime.error(errorText(hint));
		return;
	}
	if (runtime?.status === "stopped") {
		defaultRuntime.error(errorText("Service is loaded but not running."));
		for (const hint of buildNodeRuntimeHints(hintEnv)) defaultRuntime.error(errorText(hint));
	}
}

//#endregion
//#region src/cli/node-cli/register.ts
function parsePortWithFallback(value, fallback) {
	return parsePort(value) ?? fallback;
}
function registerNodeCli(program) {
	const node = program.command("node").description("Run and manage the headless node host service").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw node run --host 127.0.0.1 --port 18789", "Run the node host in the foreground."],
		["openclaw node status", "Check node host service status."],
		["openclaw node install", "Install the node host service."],
		["openclaw node restart", "Restart the installed node host service."]
	])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/node", "docs.openclaw.ai/cli/node")}\n`);
	node.command("run").description("Run the headless node host (foreground)").option("--host <host>", "Gateway host").option("--port <port>", "Gateway port").option("--tls", "Use TLS for the gateway connection", false).option("--tls-fingerprint <sha256>", "Expected TLS certificate fingerprint (sha256)").option("--node-id <id>", "Override node id (clears pairing token)").option("--display-name <name>", "Override node display name").action(async (opts) => {
		const existing = await loadNodeHostConfig();
		await runNodeHost({
			gatewayHost: opts.host?.trim() || existing?.gateway?.host || "127.0.0.1",
			gatewayPort: parsePortWithFallback(opts.port, existing?.gateway?.port ?? 18789),
			gatewayTls: Boolean(opts.tls) || Boolean(opts.tlsFingerprint),
			gatewayTlsFingerprint: opts.tlsFingerprint,
			nodeId: opts.nodeId,
			displayName: opts.displayName
		});
	});
	node.command("status").description("Show node host status").option("--json", "Output JSON", false).action(async (opts) => {
		await runNodeDaemonStatus(opts);
	});
	node.command("install").description("Install the node host service (launchd/systemd/schtasks)").option("--host <host>", "Gateway host").option("--port <port>", "Gateway port").option("--tls", "Use TLS for the gateway connection", false).option("--tls-fingerprint <sha256>", "Expected TLS certificate fingerprint (sha256)").option("--node-id <id>", "Override node id (clears pairing token)").option("--display-name <name>", "Override node display name").option("--runtime <runtime>", "Service runtime (node|bun). Default: node").option("--force", "Reinstall/overwrite if already installed", false).option("--json", "Output JSON", false).action(async (opts) => {
		await runNodeDaemonInstall(opts);
	});
	node.command("uninstall").description("Uninstall the node host service (launchd/systemd/schtasks)").option("--json", "Output JSON", false).action(async (opts) => {
		await runNodeDaemonUninstall(opts);
	});
	node.command("stop").description("Stop the node host service (launchd/systemd/schtasks)").option("--json", "Output JSON", false).action(async (opts) => {
		await runNodeDaemonStop(opts);
	});
	node.command("restart").description("Restart the node host service (launchd/systemd/schtasks)").option("--json", "Output JSON", false).action(async (opts) => {
		await runNodeDaemonRestart(opts);
	});
}

//#endregion
export { registerNodeCli };