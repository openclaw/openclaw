import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as markOpenClawExecEnv } from "./openclaw-exec-env-CjxcymgO.js";
import { t as getWindowsInstallRoots } from "./windows-install-roots-C-V7Ai9d.js";
import { a as shouldLogVerbose, t as danger } from "./globals-YU5FjfZK.js";
import { a as decodeWindowsOutputBuffer, n as resolveCommandStdio, o as resolveWindowsConsoleEncoding, t as resolveWindowsCommandShim } from "./windows-command-hxNVp7Ds.js";
import { n as logError, t as logDebug } from "./logger-0o2znY2U.js";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
//#region src/process/exec.ts
const execFileAsync = promisify(execFile);
const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>^%\r\n]/;
function isWindowsBatchCommand(resolvedCommand) {
	if (process.platform !== "win32") return false;
	const ext = normalizeLowercaseStringOrEmpty(path.extname(resolvedCommand));
	return ext === ".cmd" || ext === ".bat";
}
function escapeForCmdExe(arg) {
	if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) throw new Error(`Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}. Pass an explicit shell-wrapper argv at the call site instead.`);
	if (!arg.includes(" ") && !arg.includes("\"")) return arg;
	return `"${arg.replace(/"/g, "\"\"")}"`;
}
function buildCmdExeCommandLine(resolvedCommand, args) {
	return [escapeForCmdExe(resolvedCommand), ...args.map(escapeForCmdExe)].join(" ");
}
function resolveTrustedWindowsCmdExe() {
	if (process.platform !== "win32") return "cmd.exe";
	return path.win32.join(getWindowsInstallRoots().systemRoot, "System32", "cmd.exe");
}
function assignChildEnvValue(params) {
	if (params.value === void 0) return;
	if (params.platform === "win32") {
		const normalizedKey = params.key.toLowerCase();
		for (const existingKey of Object.keys(params.env)) if (existingKey.toLowerCase() === normalizedKey && existingKey !== params.key) delete params.env[existingKey];
	}
	params.env[params.key] = params.value;
}
function mergeChildEnv(params) {
	const resolvedEnv = {};
	for (const [key, value] of Object.entries(params.baseEnv)) assignChildEnvValue({
		env: resolvedEnv,
		key,
		platform: params.platform,
		value
	});
	for (const [key, value] of Object.entries(params.env ?? {})) assignChildEnvValue({
		env: resolvedEnv,
		key,
		platform: params.platform,
		value
	});
	return resolvedEnv;
}
/**
* On Windows, Node 18.20.2+ (CVE-2024-27980) rejects spawning .cmd/.bat directly
* without shell, causing EINVAL. Resolve npm/npx to node + cli script so we
* spawn node.exe instead of npm.cmd.
*/
function resolveNpmArgvForWindows(argv) {
	if (process.platform !== "win32" || argv.length === 0) return null;
	const basename = normalizeLowercaseStringOrEmpty(path.basename(argv[0])).replace(/\.(cmd|exe|bat)$/, "");
	const cliName = basename === "npx" ? "npx-cli.js" : basename === "npm" ? "npm-cli.js" : null;
	if (!cliName) return null;
	const nodeDir = path.dirname(process.execPath);
	const cliPath = path.join(nodeDir, "node_modules", "npm", "bin", cliName);
	if (!fs.existsSync(cliPath)) {
		const command = argv[0] ?? "";
		return [normalizeLowercaseStringOrEmpty(path.extname(command)) ? command : `${command}.cmd`, ...argv.slice(1)];
	}
	return [
		process.execPath,
		cliPath,
		...argv.slice(1)
	];
}
/**
* Resolves a command for Windows compatibility.
* On Windows, non-.exe commands (like pnpm, yarn) are resolved to .cmd; npm/npx
* are handled by resolveNpmArgvForWindows to avoid spawn EINVAL (no direct .cmd).
*/
function resolveCommand(command) {
	return resolveWindowsCommandShim({
		command,
		cmdCommands: [
			"corepack",
			"pnpm",
			"yarn"
		]
	});
}
function resolveChildProcessInvocation(params) {
	const finalArgv = process.platform === "win32" ? resolveNpmArgvForWindows(params.argv) ?? params.argv : params.argv;
	const resolvedCommand = finalArgv !== params.argv ? finalArgv[0] ?? "" : resolveCommand(params.argv[0] ?? "");
	const useCmdWrapper = isWindowsBatchCommand(resolvedCommand);
	return {
		command: useCmdWrapper ? resolveTrustedWindowsCmdExe() : resolvedCommand,
		args: useCmdWrapper ? [
			"/d",
			"/s",
			"/c",
			buildCmdExeCommandLine(resolvedCommand, finalArgv.slice(1))
		] : finalArgv.slice(1),
		usesWindowsExitCodeShim: process.platform === "win32" && (useCmdWrapper || finalArgv !== params.argv),
		windowsHide: true,
		windowsVerbatimArguments: useCmdWrapper ? true : params.windowsVerbatimArguments
	};
}
function shouldSpawnWithShell(params) {
	return false;
}
async function runExec(command, args, opts = 1e4) {
	const options = typeof opts === "number" ? {
		timeout: opts,
		encoding: "buffer"
	} : {
		timeout: opts.timeoutMs,
		maxBuffer: opts.maxBuffer,
		cwd: opts.cwd,
		encoding: "buffer"
	};
	try {
		const invocation = resolveChildProcessInvocation({ argv: [command, ...args] });
		const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
			...options,
			windowsHide: invocation.windowsHide,
			windowsVerbatimArguments: invocation.windowsVerbatimArguments
		});
		const windowsEncoding = resolveWindowsConsoleEncoding();
		const decodedStdout = decodeWindowsOutputBuffer({
			buffer: stdout,
			windowsEncoding
		});
		const decodedStderr = decodeWindowsOutputBuffer({
			buffer: stderr,
			windowsEncoding
		});
		if (shouldLogVerbose()) {
			if (decodedStdout.trim()) logDebug(decodedStdout.trim());
			if (decodedStderr.trim()) logError(decodedStderr.trim());
		}
		return {
			stdout: decodedStdout,
			stderr: decodedStderr
		};
	} catch (err) {
		const windowsEncoding = resolveWindowsConsoleEncoding();
		if (err && typeof err === "object") {
			const errorWithOutput = err;
			if (Buffer.isBuffer(errorWithOutput.stdout)) errorWithOutput.stdout = decodeWindowsOutputBuffer({
				buffer: errorWithOutput.stdout,
				windowsEncoding
			});
			if (Buffer.isBuffer(errorWithOutput.stderr)) errorWithOutput.stderr = decodeWindowsOutputBuffer({
				buffer: errorWithOutput.stderr,
				windowsEncoding
			});
		}
		if (shouldLogVerbose()) logError(danger(`Command failed: ${command} ${args.join(" ")}`));
		throw err;
	}
}
const WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS = 250;
const WINDOWS_CLOSE_STATE_POLL_MS = 10;
function resolveProcessExitCode(params) {
	return params.explicitCode ?? params.childExitCode ?? (params.usesWindowsExitCodeShim && params.resolvedSignal == null && !params.timedOut && !params.noOutputTimedOut && !params.killIssuedByTimeout && !params.killIssuedByAbort ? 0 : null);
}
function resolveCommandEnv(params) {
	const baseEnv = params.baseEnv ?? process.env;
	const platform = params.platform ?? process.platform;
	const argv = params.argv;
	const shouldSuppressNpmFund = (() => {
		const cmd = path.basename(argv[0] ?? "");
		if (cmd === "npm" || cmd === "npm.cmd" || cmd === "npm.exe") return true;
		if (cmd === "node" || cmd === "node.exe") return (argv[1] ?? "").includes("npm-cli.js");
		return false;
	})();
	const resolvedEnv = mergeChildEnv({
		baseEnv,
		env: params.env,
		platform
	});
	if (shouldSuppressNpmFund) {
		if (resolvedEnv.NPM_CONFIG_FUND == null) resolvedEnv.NPM_CONFIG_FUND = "false";
		if (resolvedEnv.npm_config_fund == null) resolvedEnv.npm_config_fund = "false";
	}
	return markOpenClawExecEnv(resolvedEnv);
}
async function runCommandWithTimeout(argv, optionsOrTimeout) {
	const options = typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
	const { timeoutMs, cwd, input, baseEnv, env, noOutputTimeoutMs, signal } = options;
	const hasInput = input !== void 0;
	const resolvedEnv = resolveCommandEnv({
		argv,
		baseEnv,
		env
	});
	const stdio = resolveCommandStdio({
		hasInput,
		preferInherit: true
	});
	const invocation = resolveChildProcessInvocation({
		argv,
		windowsVerbatimArguments: options.windowsVerbatimArguments
	});
	if (signal?.aborted) return {
		stdout: "",
		stderr: "",
		code: null,
		signal: null,
		killed: false,
		termination: "signal",
		noOutputTimedOut: false
	};
	const child = spawn(invocation.command, invocation.args, {
		stdio,
		cwd,
		env: resolvedEnv,
		windowsHide: invocation.windowsHide,
		windowsVerbatimArguments: invocation.windowsVerbatimArguments,
		...shouldSpawnWithShell({
			resolvedCommand: invocation.command,
			platform: process.platform
		}) ? { shell: true } : {}
	});
	return await new Promise((resolve, reject) => {
		const stdoutChunks = [];
		const stderrChunks = [];
		const windowsEncoding = resolveWindowsConsoleEncoding();
		let settled = false;
		let timedOut = false;
		let noOutputTimedOut = false;
		let killIssuedByTimeout = false;
		let killIssuedByAbort = false;
		let childExitState = null;
		let closeFallbackTimer = null;
		let noOutputTimer = null;
		const shouldTrackOutputTimeout = typeof noOutputTimeoutMs === "number" && Number.isFinite(noOutputTimeoutMs) && noOutputTimeoutMs > 0;
		let removeAbortListener = null;
		const clearNoOutputTimer = () => {
			if (!noOutputTimer) return;
			clearTimeout(noOutputTimer);
			noOutputTimer = null;
		};
		const clearCloseFallbackTimer = () => {
			if (!closeFallbackTimer) return;
			clearTimeout(closeFallbackTimer);
			closeFallbackTimer = null;
		};
		const killChild = (byTimeout = true) => {
			if (settled || typeof child?.kill !== "function") return;
			if (byTimeout) killIssuedByTimeout = true;
			else killIssuedByAbort = true;
			if (process.platform === "win32" && typeof child.pid === "number" && child.pid > 0) try {
				spawn("taskkill", [
					"/PID",
					String(child.pid),
					"/T",
					"/F"
				], {
					stdio: "ignore",
					windowsHide: true
				});
				return;
			} catch {}
			child.kill("SIGKILL");
		};
		const armNoOutputTimer = () => {
			if (!shouldTrackOutputTimeout || settled) return;
			clearNoOutputTimer();
			noOutputTimer = setTimeout(() => {
				if (settled) return;
				noOutputTimedOut = true;
				killChild();
			}, Math.floor(noOutputTimeoutMs));
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killChild();
		}, timeoutMs);
		armNoOutputTimer();
		if (signal) {
			const onAbort = () => killChild(false);
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
		if (hasInput && child.stdin) {
			child.stdin.on("error", () => {});
			child.stdin.write(input ?? "");
			child.stdin.end();
		}
		child.stdout?.on("data", (d) => {
			stdoutChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
			armNoOutputTimer();
		});
		child.stderr?.on("data", (d) => {
			stderrChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
			armNoOutputTimer();
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearNoOutputTimer();
			clearCloseFallbackTimer();
			removeAbortListener?.();
			removeAbortListener = null;
			reject(err);
		});
		child.on("exit", (code, signal) => {
			childExitState = {
				code,
				signal
			};
			if (settled || closeFallbackTimer) return;
			closeFallbackTimer = setTimeout(() => {
				if (settled) return;
				child.stdout?.destroy();
				child.stderr?.destroy();
			}, 250);
		});
		const resolveFromClose = (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearNoOutputTimer();
			clearCloseFallbackTimer();
			removeAbortListener?.();
			removeAbortListener = null;
			const resolvedSignal = childExitState?.signal ?? signal ?? child.signalCode ?? null;
			const resolvedCode = resolveProcessExitCode({
				explicitCode: childExitState?.code ?? code,
				childExitCode: child.exitCode,
				resolvedSignal,
				usesWindowsExitCodeShim: invocation.usesWindowsExitCodeShim,
				timedOut,
				noOutputTimedOut,
				killIssuedByTimeout,
				killIssuedByAbort
			});
			const termination = noOutputTimedOut ? "no-output-timeout" : timedOut ? "timeout" : resolvedSignal != null || killIssuedByAbort ? "signal" : "exit";
			const normalizedCode = termination === "timeout" || termination === "no-output-timeout" ? resolvedCode === 0 ? 124 : resolvedCode : resolvedCode;
			resolve({
				pid: child.pid ?? void 0,
				stdout: decodeWindowsOutputBuffer({
					buffer: Buffer.concat(stdoutChunks),
					windowsEncoding
				}),
				stderr: decodeWindowsOutputBuffer({
					buffer: Buffer.concat(stderrChunks),
					windowsEncoding
				}),
				code: normalizedCode,
				signal: resolvedSignal,
				killed: child.killed,
				termination,
				noOutputTimedOut
			});
		};
		child.on("close", (code, signal) => {
			if (process.platform !== "win32" || childExitState != null || code != null || signal != null || child.exitCode != null || child.signalCode != null) {
				resolveFromClose(code, signal);
				return;
			}
			const startedAt = Date.now();
			const waitForExitState = () => {
				if (settled) return;
				if (childExitState != null || child.exitCode != null || child.signalCode != null) {
					resolveFromClose(code, signal);
					return;
				}
				if (Date.now() - startedAt >= WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS) {
					resolveFromClose(code, signal);
					return;
				}
				setTimeout(waitForExitState, WINDOWS_CLOSE_STATE_POLL_MS);
			};
			waitForExitState();
		});
	});
}
//#endregion
export { shouldSpawnWithShell as a, runExec as i, resolveProcessExitCode as n, runCommandWithTimeout as r, resolveCommandEnv as t };
