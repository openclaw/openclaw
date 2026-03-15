#!/usr/bin/env node
import { t as isMainModule } from "./is-main-DRn0Pf7d.js";
import { I as isRootHelpInvocation, L as isRootVersionInvocation, P as hasHelpOrVersion } from "./globals-I5DlBD2D.js";
import "./paths-1qR_mW4i.js";
import { n as applyCliProfileEnv, r as parseCliProfileArgs, t as normalizeWindowsArgv } from "./windows-argv-Ty7cMo2B.js";
import "./theme-UkqnBJaj.js";
import "./subsystem-EnljYYs1.js";
import "./ansi-YpD2Ho3J.js";
import "./boolean-B938tROv.js";
import { r as normalizeEnv, t as isTruthyEnvValue } from "./env-Bdj-riuG.js";
import { t as ensureOpenClawExecMarkerOnProcess } from "./openclaw-exec-env-YQjF2qEk.js";
import { t as installProcessWarningFilter } from "./warning-filter-xAwZkSAQ.js";
import { enableCompileCache } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
//#region src/cli/respawn-policy.ts
function shouldSkipRespawnForArgv(argv) {
	return hasHelpOrVersion(argv);
}
//#endregion
//#region src/process/child-process-bridge.ts
const defaultSignals = process.platform === "win32" ? [
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
			process.on(signal, listener);
			listeners.set(signal, listener);
		} catch {}
	}
	const detach = () => {
		for (const [signal, listener] of listeners) {process.off(signal, listener);}
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
	for (let index = 0; index < tokens.length - 1; index += 1) {if (tokens[index] === "secrets" && tokens[index + 1] === "audit") return true;}
	return false;
}
if (!isMainModule({
	currentFile: fileURLToPath(import.meta.url),
	wrapperEntryPairs: [...ENTRY_WRAPPER_PAIRS]
})) {} else {
	const { installGaxiosFetchCompat } = await import("./gaxios-fetch-compat-DKeBlJsc.js");
	await installGaxiosFetchCompat();
	process.title = "openclaw";
	ensureOpenClawExecMarkerOnProcess();
	installProcessWarningFilter();
	normalizeEnv();
	if (!isTruthyEnvValue(process.env.NODE_DISABLE_COMPILE_CACHE)) {try {
		enableCompileCache();
	} catch {}}
	if (shouldForceReadOnlyAuthStore(process.argv)) {process.env.OPENCLAW_AUTH_STORE_READONLY = "1";}
	if (process.argv.includes("--no-color")) {
		process.env.NO_COLOR = "1";
		process.env.FORCE_COLOR = "0";
	}
	const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";
	function hasExperimentalWarningSuppressed() {
		const nodeOptions = process.env.NODE_OPTIONS ?? "";
		if (nodeOptions.includes(EXPERIMENTAL_WARNING_FLAG) || nodeOptions.includes("--no-warnings")) {return true;}
		for (const arg of process.execArgv) {if (arg === EXPERIMENTAL_WARNING_FLAG || arg === "--no-warnings") return true;}
		return false;
	}
	function ensureExperimentalWarningSuppressed() {
		if (shouldSkipRespawnForArgv(process.argv)) {return false;}
		if (isTruthyEnvValue(process.env.OPENCLAW_NO_RESPAWN)) {return false;}
		if (isTruthyEnvValue(process.env.OPENCLAW_NODE_OPTIONS_READY)) {return false;}
		if (hasExperimentalWarningSuppressed()) {return false;}
		process.env.OPENCLAW_NODE_OPTIONS_READY = "1";
		const child = spawn(process.execPath, [
			EXPERIMENTAL_WARNING_FLAG,
			...process.execArgv,
			...process.argv.slice(1)
		], {
			stdio: "inherit",
			env: process.env
		});
		attachChildProcessBridge(child);
		child.once("exit", (code, signal) => {
			if (signal) {
				process.exitCode = 1;
				return;
			}
			process.exit(code ?? 1);
		});
		child.once("error", (error) => {
			console.error("[openclaw] Failed to respawn CLI:", error instanceof Error ? error.stack ?? error.message : error);
			process.exit(1);
		});
		return true;
	}
	function tryHandleRootVersionFastPath(argv) {
		if (!isRootVersionInvocation(argv)) {return false;}
		Promise.all([import("./version-CpQBZqLQ.js"), import("./git-commit-2xFtu5DO.js")]).then(([{ VERSION }, { resolveCommitHash }]) => {
			const commit = resolveCommitHash({ moduleUrl: import.meta.url });
			console.log(commit ? `OpenClaw ${VERSION} (${commit})` : `OpenClaw ${VERSION}`);
			process.exit(0);
		}).catch((error) => {
			console.error("[openclaw] Failed to resolve version:", error instanceof Error ? error.stack ?? error.message : error);
			process.exitCode = 1;
		});
		return true;
	}
	process.argv = normalizeWindowsArgv(process.argv);
	if (!ensureExperimentalWarningSuppressed()) {
		const parsed = parseCliProfileArgs(process.argv);
		if (!parsed.ok) {
			console.error(`[openclaw] ${parsed.error}`);
			process.exit(2);
		}
		if (parsed.profile) {
			applyCliProfileEnv({ profile: parsed.profile });
			process.argv = parsed.argv;
		}
		if (!tryHandleRootVersionFastPath(process.argv)) {runMainOrRootHelp(process.argv);}
	}
}
function tryHandleRootHelpFastPath(argv, deps = {}) {
	if (!isRootHelpInvocation(argv)) {return false;}
	const handleError = deps.onError ?? ((error) => {
		console.error("[openclaw] Failed to display help:", error instanceof Error ? error.stack ?? error.message : error);
		process.exitCode = 1;
	});
	if (deps.outputRootHelp) {
		try {
			deps.outputRootHelp();
		} catch (error) {
			handleError(error);
		}
		return true;
	}
	import("./root-help-CqfgDcU5.js").then(({ outputRootHelp }) => {
		outputRootHelp();
	}).catch(handleError);
	return true;
}
function runMainOrRootHelp(argv) {
	if (tryHandleRootHelpFastPath(argv)) {return;}
	import("./run-main-Bk1JfN3z.js").then(({ runCli }) => runCli(argv)).catch((error) => {
		console.error("[openclaw] Failed to start CLI:", error instanceof Error ? error.stack ?? error.message : error);
		process.exitCode = 1;
	});
}
//#endregion
export { tryHandleRootHelpFastPath };
