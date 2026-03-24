#!/usr/bin/env node
import { $ as isRootHelpInvocation, Z as hasHelpOrVersion, et as isRootVersionInvocation, t as createSubsystemLogger } from "./subsystem-DVwhOlEq.js";
import { y as resolveRequiredHomeDir } from "./paths-BfR2LXbA.js";
import { t as isValidProfileName } from "./profile-utils-BLR70_pd.js";
import { t as parseBooleanValue } from "./boolean-BHdNsbzF.js";
import { enableCompileCache } from "node:module";
import { spawn } from "node:child_process";
import process$1 from "node:process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
//#region src/cli/profile.ts
function takeValue(raw, next) {
	if (raw.includes("=")) {
		const [, value] = raw.split("=", 2);
		return {
			value: (value ?? "").trim() || null,
			consumedNext: false
		};
	}
	return {
		value: (next ?? "").trim() || null,
		consumedNext: Boolean(next)
	};
}
function parseCliProfileArgs(argv) {
	if (argv.length < 2) return {
		ok: true,
		profile: null,
		argv
	};
	const out = argv.slice(0, 2);
	let profile = null;
	let sawDev = false;
	let sawCommand = false;
	const args = argv.slice(2);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === void 0) continue;
		if (sawCommand) {
			out.push(arg);
			continue;
		}
		if (arg === "--dev") {
			if (profile && profile !== "dev") return {
				ok: false,
				error: "Cannot combine --dev with --profile"
			};
			sawDev = true;
			profile = "dev";
			continue;
		}
		if (arg === "--profile" || arg.startsWith("--profile=")) {
			if (sawDev) return {
				ok: false,
				error: "Cannot combine --dev with --profile"
			};
			const next = args[i + 1];
			const { value, consumedNext } = takeValue(arg, next);
			if (consumedNext) i += 1;
			if (!value) return {
				ok: false,
				error: "--profile requires a value"
			};
			if (!isValidProfileName(value)) return {
				ok: false,
				error: "Invalid --profile (use letters, numbers, \"_\", \"-\" only)"
			};
			profile = value;
			continue;
		}
		if (!arg.startsWith("-")) {
			sawCommand = true;
			out.push(arg);
			continue;
		}
		out.push(arg);
	}
	return {
		ok: true,
		profile,
		argv: out
	};
}
function resolveProfileStateDir(profile, env, homedir) {
	const suffix = profile.toLowerCase() === "default" ? "" : `-${profile}`;
	return path.join(resolveRequiredHomeDir(env, homedir), `.openclaw${suffix}`);
}
function applyCliProfileEnv(params) {
	const env = params.env ?? process.env;
	const homedir = params.homedir ?? os.homedir;
	const profile = params.profile.trim();
	if (!profile) return;
	env.OPENCLAW_PROFILE = profile;
	const stateDir = env.OPENCLAW_STATE_DIR?.trim() || resolveProfileStateDir(profile, env, homedir);
	if (!env.OPENCLAW_STATE_DIR?.trim()) env.OPENCLAW_STATE_DIR = stateDir;
	if (!env.OPENCLAW_CONFIG_PATH?.trim()) env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
	if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) env.OPENCLAW_GATEWAY_PORT = "19001";
}
//#endregion
//#region src/cli/respawn-policy.ts
function shouldSkipRespawnForArgv(argv) {
	return hasHelpOrVersion(argv);
}
//#endregion
//#region src/cli/windows-argv.ts
function normalizeWindowsArgv(argv) {
	if (process.platform !== "win32") return argv;
	if (argv.length < 2) return argv;
	const stripControlChars = (value) => {
		let out = "";
		for (let i = 0; i < value.length; i += 1) {
			const code = value.charCodeAt(i);
			if (code >= 32 && code !== 127) out += value[i];
		}
		return out;
	};
	const normalizeArg = (value) => stripControlChars(value).replace(/^['"]+|['"]+$/g, "").trim();
	const normalizeCandidate = (value) => normalizeArg(value).replace(/^\\\\\\?\\/, "");
	const execPath = normalizeCandidate(process.execPath);
	const execPathLower = execPath.toLowerCase();
	const execBase = path.basename(execPath).toLowerCase();
	const isExecPath = (value) => {
		if (!value) return false;
		const normalized = normalizeCandidate(value);
		if (!normalized) return false;
		const lower = normalized.toLowerCase();
		return lower === execPathLower || path.basename(lower) === execBase || lower.endsWith("\\node.exe") || lower.endsWith("/node.exe") || lower.includes("node.exe") || path.basename(lower) === "node.exe" && fs.existsSync(normalized);
	};
	const next = [...argv];
	for (let i = 1; i <= 3 && i < next.length;) {
		if (isExecPath(next[i])) {
			next.splice(i, 1);
			continue;
		}
		i += 1;
	}
	const filtered = next.filter((arg, index) => index === 0 || !isExecPath(arg));
	if (filtered.length < 3) return filtered;
	const cleaned = [...filtered];
	for (let i = 2; i < cleaned.length;) {
		const arg = cleaned[i];
		if (!arg || arg.startsWith("-")) {
			i += 1;
			continue;
		}
		if (isExecPath(arg)) {
			cleaned.splice(i, 1);
			continue;
		}
		break;
	}
	return cleaned;
}
//#endregion
//#region src/infra/env.ts
const log = createSubsystemLogger("env");
const loggedEnv = /* @__PURE__ */ new Set();
function formatEnvValue(value, redact) {
	if (redact) return "<redacted>";
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= 160) return singleLine;
	return `${singleLine.slice(0, 160)}…`;
}
function logAcceptedEnvOption(option) {
	if (process.env.VITEST || false) return;
	if (loggedEnv.has(option.key)) return;
	const rawValue = option.value ?? process.env[option.key];
	if (!rawValue || !rawValue.trim()) return;
	loggedEnv.add(option.key);
	log.info(`env: ${option.key}=${formatEnvValue(rawValue, option.redact)} (${option.description})`);
}
function normalizeZaiEnv() {
	if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
}
function isTruthyEnvValue(value) {
	return parseBooleanValue(value) === true;
}
function normalizeEnv() {
	normalizeZaiEnv();
}
//#endregion
//#region src/infra/is-main.ts
function normalizePathCandidate(candidate, cwd) {
	if (!candidate) return;
	const resolved = path.resolve(cwd, candidate);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}
function isMainModule({ currentFile, argv = process.argv, env = process.env, cwd = process.cwd(), wrapperEntryPairs = [] }) {
	const normalizedCurrent = normalizePathCandidate(currentFile, cwd);
	const normalizedArgv1 = normalizePathCandidate(argv[1], cwd);
	if (normalizedCurrent && normalizedArgv1 && normalizedCurrent === normalizedArgv1) return true;
	const normalizedPmExecPath = normalizePathCandidate(env.pm_exec_path, cwd);
	if (normalizedCurrent && normalizedPmExecPath && normalizedCurrent === normalizedPmExecPath) return true;
	if (normalizedCurrent && normalizedArgv1 && wrapperEntryPairs.length > 0) {
		const currentBase = path.basename(normalizedCurrent);
		const argvBase = path.basename(normalizedArgv1);
		if (wrapperEntryPairs.some(({ wrapperBasename, entryBasename }) => currentBase === entryBasename && argvBase === wrapperBasename)) return true;
	}
	if (normalizedCurrent && normalizedArgv1 && path.basename(normalizedCurrent) === path.basename(normalizedArgv1)) return true;
	return false;
}
//#endregion
//#region src/infra/openclaw-exec-env.ts
const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";
function markOpenClawExecEnv(env) {
	return {
		...env,
		[OPENCLAW_CLI_ENV_VAR]: "1"
	};
}
function ensureOpenClawExecMarkerOnProcess(env = process.env) {
	env[OPENCLAW_CLI_ENV_VAR] = "1";
	return env;
}
//#endregion
//#region src/infra/warning-filter.ts
const warningFilterKey = Symbol.for("openclaw.warning-filter");
function shouldIgnoreWarning(warning) {
	if (warning.code === "DEP0040" && warning.message?.includes("punycode")) return true;
	if (warning.code === "DEP0060" && warning.message?.includes("util._extend")) return true;
	if (warning.name === "ExperimentalWarning" && warning.message?.includes("SQLite is an experimental feature")) return true;
	return false;
}
function normalizeWarningArgs(args) {
	const warningArg = args[0];
	const secondArg = args[1];
	const thirdArg = args[2];
	let name;
	let code;
	let message;
	if (warningArg instanceof Error) {
		name = warningArg.name;
		message = warningArg.message;
		code = warningArg.code;
	} else if (typeof warningArg === "string") message = warningArg;
	if (secondArg && typeof secondArg === "object" && !Array.isArray(secondArg)) {
		const options = secondArg;
		if (typeof options.type === "string") name = options.type;
		if (typeof options.code === "string") code = options.code;
	} else {
		if (typeof secondArg === "string") name = secondArg;
		if (typeof thirdArg === "string") code = thirdArg;
	}
	return {
		name,
		code,
		message
	};
}
function installProcessWarningFilter() {
	const globalState = globalThis;
	if (globalState[warningFilterKey]?.installed) return;
	const originalEmitWarning = process.emitWarning.bind(process);
	const wrappedEmitWarning = ((...args) => {
		if (shouldIgnoreWarning(normalizeWarningArgs(args))) return;
		return Reflect.apply(originalEmitWarning, process, args);
	});
	process.emitWarning = wrappedEmitWarning;
	globalState[warningFilterKey] = { installed: true };
}
//#endregion
//#region src/process/child-process-bridge.ts
const defaultSignals = process$1.platform === "win32" ? [
	"SIGTERM",
	"SIGINT",
	"SIGBREAK"
] : [
	"SIGTERM",
	"SIGINT",
	"SIGHUP",
	"SIGQUIT"
];
function attachChildProcessBridge(child, { signals = defaultSignals, onSignal } = {}) {
	const listeners = /* @__PURE__ */ new Map();
	for (const signal of signals) {
		const listener = () => {
			onSignal?.(signal);
			try {
				child.kill(signal);
			} catch {}
		};
		try {
			process$1.on(signal, listener);
			listeners.set(signal, listener);
		} catch {}
	}
	const detach = () => {
		for (const [signal, listener] of listeners) process$1.off(signal, listener);
		listeners.clear();
	};
	child.once("exit", detach);
	child.once("error", detach);
	return { detach };
}
//#endregion
//#region src/entry.ts
const ENTRY_WRAPPER_PAIRS = [{
	wrapperBasename: "openclaw.mjs",
	entryBasename: "entry.js"
}, {
	wrapperBasename: "openclaw.js",
	entryBasename: "entry.js"
}];
function shouldForceReadOnlyAuthStore(argv) {
	const tokens = argv.slice(2).filter((token) => token.length > 0 && !token.startsWith("-"));
	for (let index = 0; index < tokens.length - 1; index += 1) if (tokens[index] === "secrets" && tokens[index + 1] === "audit") return true;
	return false;
}
if (!isMainModule({
	currentFile: fileURLToPath(import.meta.url),
	wrapperEntryPairs: [...ENTRY_WRAPPER_PAIRS]
})) {} else {
	process$1.title = "openclaw";
	ensureOpenClawExecMarkerOnProcess();
	installProcessWarningFilter();
	normalizeEnv();
	if (!isTruthyEnvValue(process$1.env.NODE_DISABLE_COMPILE_CACHE)) try {
		enableCompileCache();
	} catch {}
	if (shouldForceReadOnlyAuthStore(process$1.argv)) process$1.env.OPENCLAW_AUTH_STORE_READONLY = "1";
	if (process$1.argv.includes("--no-color")) {
		process$1.env.NO_COLOR = "1";
		process$1.env.FORCE_COLOR = "0";
	}
	const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";
	function hasExperimentalWarningSuppressed() {
		const nodeOptions = process$1.env.NODE_OPTIONS ?? "";
		if (nodeOptions.includes(EXPERIMENTAL_WARNING_FLAG) || nodeOptions.includes("--no-warnings")) return true;
		for (const arg of process$1.execArgv) if (arg === EXPERIMENTAL_WARNING_FLAG || arg === "--no-warnings") return true;
		return false;
	}
	function ensureExperimentalWarningSuppressed() {
		if (shouldSkipRespawnForArgv(process$1.argv)) return false;
		if (isTruthyEnvValue(process$1.env.OPENCLAW_NO_RESPAWN)) return false;
		if (isTruthyEnvValue(process$1.env.OPENCLAW_NODE_OPTIONS_READY)) return false;
		if (hasExperimentalWarningSuppressed()) return false;
		process$1.env.OPENCLAW_NODE_OPTIONS_READY = "1";
		const child = spawn(process$1.execPath, [
			EXPERIMENTAL_WARNING_FLAG,
			...process$1.execArgv,
			...process$1.argv.slice(1)
		], {
			stdio: "inherit",
			env: process$1.env
		});
		attachChildProcessBridge(child);
		child.once("exit", (code, signal) => {
			if (signal) {
				process$1.exitCode = 1;
				return;
			}
			process$1.exit(code ?? 1);
		});
		child.once("error", (error) => {
			console.error("[openclaw] Failed to respawn CLI:", error instanceof Error ? error.stack ?? error.message : error);
			process$1.exit(1);
		});
		return true;
	}
	function tryHandleRootVersionFastPath(argv) {
		if (!isRootVersionInvocation(argv)) return false;
		Promise.all([import("./version-N--ZkDj4.js").then((n) => n.r), import("./git-commit-Csygiqtq.js").then((n) => n.t)]).then(([{ VERSION }, { resolveCommitHash }]) => {
			const commit = resolveCommitHash({ moduleUrl: import.meta.url });
			console.log(commit ? `OpenClaw ${VERSION} (${commit})` : `OpenClaw ${VERSION}`);
			process$1.exit(0);
		}).catch((error) => {
			console.error("[openclaw] Failed to resolve version:", error instanceof Error ? error.stack ?? error.message : error);
			process$1.exitCode = 1;
		});
		return true;
	}
	function tryHandleRootHelpFastPath(argv) {
		if (!isRootHelpInvocation(argv)) return false;
		import("./program-Dmzxvcav.js").then(({ buildProgram }) => {
			buildProgram().outputHelp();
		}).catch((error) => {
			console.error("[openclaw] Failed to display help:", error instanceof Error ? error.stack ?? error.message : error);
			process$1.exitCode = 1;
		});
		return true;
	}
	process$1.argv = normalizeWindowsArgv(process$1.argv);
	if (!ensureExperimentalWarningSuppressed()) {
		const parsed = parseCliProfileArgs(process$1.argv);
		if (!parsed.ok) {
			console.error(`[openclaw] ${parsed.error}`);
			process$1.exit(2);
		}
		if (parsed.profile) {
			applyCliProfileEnv({ profile: parsed.profile });
			process$1.argv = parsed.argv;
		}
		if (!tryHandleRootVersionFastPath(process$1.argv) && !tryHandleRootHelpFastPath(process$1.argv)) import("./run-main-CYHHcjMk.js").then(({ runCli }) => runCli(process$1.argv)).catch((error) => {
			console.error("[openclaw] Failed to start CLI:", error instanceof Error ? error.stack ?? error.message : error);
			process$1.exitCode = 1;
		});
	}
}
//#endregion
export { logAcceptedEnvOption as a, applyCliProfileEnv as c, isTruthyEnvValue as i, parseCliProfileArgs as l, markOpenClawExecEnv as n, normalizeEnv as o, isMainModule as r, normalizeWindowsArgv as s, installProcessWarningFilter as t };
