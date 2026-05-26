import "./host-env-security-66KkrZF_.js";
import { a as isSubagentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { n as emitDiagnosticEvent } from "./diagnostic-events-BLgzARSp.js";
import { a as logWarn } from "./logger-0o2znY2U.js";
import { o as normalizeDeliveryContext } from "./delivery-context.shared-CBmB9dF7.js";
import { o as requestHeartbeat } from "./heartbeat-wake-BEc0M8hq.js";
import { a as enqueueSystemEvent } from "./system-events-11EG3LzK.js";
import { d as markExited, n as appendOutput, p as tail, r as createSessionSlug, t as addSession } from "./bash-process-registry-DU_0t2zf.js";
import { c as readEnvInt, i as clampWithDefault, r as chunkString, t as buildDockerExecArgs } from "./bash-tools.shared-DwMDKMvR.js";
import { i as scopedHeartbeatWakeOptionsForPolicy, t as resolveEventSessionKeyForPolicy } from "./event-session-routing-SZ_PlpYU.js";
import { E as resolveExecApprovalAllowedDecisions, r as DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "./exec-approvals-Bef7TPVc.js";
import "./bash-tools.schemas-Rpvm0aIu.js";
import { n as getShellConfig, r as sanitizeBinaryOutput } from "./shell-utils-BDYMhC5E.js";
import { a as removePathPrepend, n as findPathKey, r as mergePathPrepend } from "./path-prepend-6X5fKWgG.js";
import { t as getProcessSupervisor } from "./supervisor-C_r9sMLs.js";
import path from "node:path";
//#region src/agents/bash-tools.exec-output.ts
const EXEC_NO_OUTPUT_PLACEHOLDER = "(no output)";
function renderExecOutputText(value) {
	return value || EXEC_NO_OUTPUT_PLACEHOLDER;
}
function renderExecUpdateText(params) {
	return (params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "") + renderExecOutputText(params.tailText);
}
//#endregion
//#region src/agents/pty-dsr.ts
const DSR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[\\??6n`, "g");
function stripDsrRequests(input) {
	let requests = 0;
	return {
		cleaned: input.replace(DSR_PATTERN, () => {
			requests += 1;
			return "";
		}),
		requests
	};
}
function buildCursorPositionResponse(row = 1, col = 1) {
	return `\x1b[${row};${col}R`;
}
//#endregion
//#region src/agents/bash-tools.exec-runtime.ts
const SMKX = "\x1B[?1h";
const RMKX = "\x1B[?1l";
/**
* Detect cursor key mode from PTY output chunk.
* Uses lastIndexOf to find the *last* toggle in the chunk.
* Returns "application" if smkx is the last toggle, "normal" if rmkx is last,
* or null if no toggle is found.
*/
function detectCursorKeyMode(raw) {
	const lastSmkx = raw.lastIndexOf(SMKX);
	const lastRmkx = raw.lastIndexOf(RMKX);
	if (lastSmkx === -1 && lastRmkx === -1) return null;
	return lastSmkx > lastRmkx ? "application" : "normal";
}
const DEFAULT_MAX_OUTPUT = clampWithDefault(readEnvInt("PI_BASH_MAX_OUTPUT_CHARS"), 2e5, 1e3, 2e5);
const DEFAULT_PENDING_MAX_OUTPUT = clampWithDefault(readEnvInt("OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS"), 3e4, 1e3, 2e5);
const DEFAULT_PATH = process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_NOTIFY_SNIPPET_CHARS = 180;
const DEFAULT_APPROVAL_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = DEFAULT_APPROVAL_TIMEOUT_MS + 1e4;
const DEFAULT_APPROVAL_RUNNING_NOTICE_MS = 1e4;
const APPROVAL_SLUG_LENGTH = 8;
function normalizeExecExitSignal(signal) {
	if (signal === null) return;
	return String(signal);
}
function emitExecProcessCompleted(params) {
	const exitSignal = normalizeExecExitSignal(params.outcome.exitSignal);
	emitDiagnosticEvent({
		type: "exec.process.completed",
		target: params.target,
		mode: params.mode,
		outcome: params.outcome.status,
		durationMs: params.outcome.durationMs,
		commandLength: params.command.length,
		...params.sessionKey?.trim() ? { sessionKey: params.sessionKey.trim() } : {},
		...typeof params.outcome.exitCode === "number" ? { exitCode: params.outcome.exitCode } : {},
		...exitSignal ? { exitSignal } : {},
		...params.outcome.status === "failed" ? {
			timedOut: params.outcome.timedOut,
			failureKind: params.outcome.failureKind
		} : {}
	});
}
function renderExecHostLabel(host) {
	return host === "sandbox" ? "sandbox" : host === "gateway" ? "gateway" : "node";
}
function renderExecTargetLabel(target) {
	return target === "auto" ? "auto" : renderExecHostLabel(target);
}
function isRequestedExecTargetAllowed(params) {
	if (params.requestedTarget === params.configuredTarget) return true;
	if (params.configuredTarget === "auto") {
		if (params.sandboxAvailable && (params.requestedTarget === "gateway" || params.requestedTarget === "node")) return false;
		return true;
	}
	return false;
}
function resolveExecTarget(params) {
	const configuredTarget = params.configuredTarget ?? "auto";
	const requestedTarget = params.requestedTarget ?? null;
	if (requestedTarget && !isRequestedExecTargetAllowed({
		configuredTarget,
		requestedTarget,
		sandboxAvailable: params.sandboxAvailable
	})) {
		const allowedConfig = Array.from(new Set(configuredTarget === "auto" && params.sandboxAvailable && (requestedTarget === "gateway" || requestedTarget === "node") ? [renderExecTargetLabel(requestedTarget)] : requestedTarget === "gateway" && !params.sandboxAvailable ? ["gateway", "auto"] : [renderExecTargetLabel(requestedTarget), "auto"])).join(" or ");
		throw new Error(`exec host not allowed (requested ${renderExecTargetLabel(requestedTarget)}; configured host is ${renderExecTargetLabel(configuredTarget)}; set tools.exec.host=${allowedConfig} to allow this override).`);
	}
	const selectedTarget = requestedTarget ?? configuredTarget;
	const resolvedTarget = params.elevatedRequested ? selectedTarget === "node" ? "node" : "gateway" : selectedTarget;
	return {
		configuredTarget,
		requestedTarget,
		selectedTarget: resolvedTarget,
		effectiveHost: resolvedTarget === "auto" ? params.sandboxAvailable ? "sandbox" : "gateway" : resolvedTarget
	};
}
function normalizeNotifyOutput(value) {
	return value.replace(/\s+/g, " ").trim();
}
function compactNotifyOutput(value, maxChars = DEFAULT_NOTIFY_SNIPPET_CHARS) {
	const normalized = normalizeNotifyOutput(value);
	if (!normalized) return "";
	if (normalized.length <= maxChars) return normalized;
	const safe = Math.max(1, maxChars - 1);
	return `${normalized.slice(0, safe)}…`;
}
function applyShellPath(env, shellPath) {
	if (!shellPath) return;
	const entries = shellPath.split(path.delimiter).map((part) => part.trim()).filter(Boolean);
	if (entries.length === 0) return;
	const pathKey = findPathKey(env);
	const merged = mergePathPrepend(env[pathKey], entries);
	if (merged) env[pathKey] = merged;
}
function maybeNotifyOnExit(session, status) {
	if (!session.backgrounded || !session.notifyOnExit || session.exitNotified) return;
	const sessionKey = session.sessionKey?.trim();
	if (!sessionKey) return;
	session.exitNotified = true;
	const exitLabel = session.exitSignal ? `signal ${session.exitSignal}` : `code ${session.exitCode ?? 0}`;
	const output = compactNotifyOutput(tail(session.tail || session.aggregated || "", 400));
	if (status === "failed" && session.exitReason === "manual-cancel" && !output) return;
	if (status === "completed" && !output && session.notifyOnExitEmptySuccess !== true) return;
	const summary = output ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}` : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;
	const eventRouting = session.eventRouting ?? {
		mainKey: session.mainKey,
		sessionScope: session.sessionScope
	};
	enqueueSystemEvent(summary, {
		sessionKey: resolveEventSessionKeyForPolicy(sessionKey, eventRouting),
		deliveryContext: session.notifyDeliveryContext
	});
	if (!isSubagentSessionKey(sessionKey)) requestHeartbeat(scopedHeartbeatWakeOptionsForPolicy(sessionKey, {
		source: "exec-event",
		intent: "event",
		reason: "exec-event",
		coalesceMs: 0
	}, eventRouting));
}
function createApprovalSlug(id) {
	return id.slice(0, APPROVAL_SLUG_LENGTH);
}
function buildApprovalPendingMessage(params) {
	let fence = "```";
	while (params.command.includes(fence)) fence += "`";
	const commandBlock = `${fence}sh\n${params.command}\n${fence}`;
	const lines = [];
	const allowedDecisions = params.allowedDecisions ?? resolveExecApprovalAllowedDecisions();
	const decisionText = allowedDecisions.join("|");
	const warningText = params.warningText?.trim();
	if (warningText) lines.push(warningText, "");
	lines.push(`Approval required (id ${params.approvalSlug}, full ${params.approvalId}).`);
	lines.push(`Host: ${params.host}`);
	if (params.nodeId) lines.push(`Node: ${params.nodeId}`);
	lines.push(`CWD: ${params.cwd ?? "(node default)"}`);
	lines.push("Command:");
	lines.push(commandBlock);
	lines.push("Mode: foreground (interactive approvals available).");
	lines.push(allowedDecisions.includes("allow-always") ? "Background mode requires pre-approved policy (allow-always or ask=off)." : "Background mode requires an effective policy that allows pre-approval (for example ask=off).");
	lines.push(`Reply with: /approve ${params.approvalSlug} ${decisionText}`);
	if (!allowedDecisions.includes("allow-always")) lines.push("The effective approval policy requires approval every time, so Allow Always is unavailable.");
	lines.push("If the short code is ambiguous, use the full id in /approve.");
	return lines.join("\n");
}
function resolveApprovalRunningNoticeMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_APPROVAL_RUNNING_NOTICE_MS;
	if (value <= 0) return 0;
	return Math.floor(value);
}
function joinExecFailureOutput(aggregated, reason) {
	return aggregated ? `${aggregated}\n\n${reason}` : reason;
}
function classifyExecFailureKind(params) {
	if (params.isShellFailure) return params.exitCode === 127 ? "shell-command-not-found" : "shell-not-executable";
	if (params.exitReason === "overall-timeout") return "overall-timeout";
	if (params.exitReason === "no-output-timeout") return "no-output-timeout";
	if (params.exitSignal != null) return "signal";
	return "aborted";
}
function formatExecFailureReason(params) {
	switch (params.failureKind) {
		case "shell-command-not-found": return "Command not found";
		case "shell-not-executable": return "Command not executable (permission denied)";
		case "overall-timeout": return typeof params.timeoutSec === "number" && params.timeoutSec > 0 ? `Command timed out after ${params.timeoutSec} seconds. If this command is expected to take longer, re-run with a higher timeout (e.g., exec timeout=300). If it should keep running, start it with exec background=true or yieldMs so OpenClaw can register a pollable process session. Do not rely on shell backgrounding with a trailing &.` : "Command timed out. If this command is expected to take longer, re-run with a higher timeout (e.g., exec timeout=300). If it should keep running, start it with exec background=true or yieldMs so OpenClaw can register a pollable process session. Do not rely on shell backgrounding with a trailing &.";
		case "no-output-timeout": return "Command timed out waiting for output";
		case "signal": return `Command aborted by signal ${params.exitSignal}`;
		case "aborted": return "Command aborted before exit code was captured";
	}
	throw new Error("Unsupported exec failure kind");
}
function buildExecExitOutcome(params) {
	const exitCode = params.exit.exitCode ?? 0;
	const isNormalExit = params.exit.reason === "exit";
	const isShellFailure = exitCode === 126 || exitCode === 127;
	if ((isNormalExit && !isShellFailure ? "completed" : "failed") === "completed") {
		const exitMsg = exitCode !== 0 ? `\n\n(Command exited with code ${exitCode})` : "";
		return {
			status: "completed",
			exitCode,
			exitSignal: params.exit.exitSignal,
			durationMs: params.durationMs,
			aggregated: params.aggregated + exitMsg,
			timedOut: false
		};
	}
	const failureKind = classifyExecFailureKind({
		exitReason: params.exit.reason,
		exitCode,
		isShellFailure,
		exitSignal: params.exit.exitSignal
	});
	const reason = formatExecFailureReason({
		failureKind,
		exitSignal: params.exit.exitSignal,
		timeoutSec: params.timeoutSec
	});
	return {
		status: "failed",
		exitCode: params.exit.exitCode,
		exitSignal: params.exit.exitSignal,
		durationMs: params.durationMs,
		aggregated: params.aggregated,
		timedOut: params.exit.timedOut,
		failureKind,
		reason: joinExecFailureOutput(params.aggregated, reason)
	};
}
function buildExecRuntimeErrorOutcome(params) {
	return {
		status: "failed",
		exitCode: null,
		exitSignal: null,
		durationMs: params.durationMs,
		aggregated: params.aggregated,
		timedOut: false,
		failureKind: "runtime-error",
		reason: joinExecFailureOutput(params.aggregated, String(params.error))
	};
}
/**
* Apply PATH prepends inside the shell command.
* This ensures our paths take precedence even if user RC files (e.g. ~/.zshenv)
* prepend their own entries to PATH during shell startup.
*/
function wrapPosixCommandWithPathPrepend(command, env, pathPrepend) {
	if (process.platform === "win32") return command;
	if (!pathPrepend || pathPrepend.length === 0) return command;
	const pathKey = findPathKey(env);
	const currentPath = env[pathKey];
	if (currentPath) {
		const newPath = removePathPrepend(currentPath, pathPrepend);
		if (newPath !== void 0) env[pathKey] = newPath;
	}
	env.OPENCLAW_PREPEND_PATH = pathPrepend.join(path.delimiter);
	return `export PATH="\${OPENCLAW_PREPEND_PATH}\${PATH:+:$PATH}"; unset OPENCLAW_PREPEND_PATH; ${command}`;
}
async function runExecProcess(opts) {
	const startedAt = Date.now();
	const sessionId = createSessionSlug();
	const execCommand = opts.execCommand ?? opts.command;
	const diagnosticTarget = opts.sandbox ? "sandbox" : "host";
	const supervisor = getProcessSupervisor();
	const shellRuntimeEnv = {
		...opts.env,
		OPENCLAW_SHELL: "exec"
	};
	const session = {
		id: sessionId,
		command: opts.command,
		scopeKey: opts.scopeKey,
		sessionKey: opts.sessionKey,
		mainKey: opts.mainKey,
		sessionScope: opts.sessionScope,
		eventRouting: opts.eventRouting,
		notifyDeliveryContext: normalizeDeliveryContext(opts.notifyDeliveryContext),
		notifyOnExit: opts.notifyOnExit,
		notifyOnExitEmptySuccess: opts.notifyOnExitEmptySuccess === true,
		exitNotified: false,
		child: void 0,
		stdin: void 0,
		pid: void 0,
		startedAt,
		cwd: opts.workdir,
		maxOutputChars: opts.maxOutput,
		pendingMaxOutputChars: opts.pendingMaxOutput,
		totalOutputChars: 0,
		pendingStdout: [],
		pendingStderr: [],
		pendingStdoutChars: 0,
		pendingStderrChars: 0,
		aggregated: "",
		tail: "",
		exited: false,
		exitCode: void 0,
		exitSignal: void 0,
		truncated: false,
		backgrounded: false,
		cursorKeyMode: opts.usePty ? "unknown" : "normal"
	};
	addSession(session);
	let updatesDisabled = false;
	const emitUpdate = () => {
		if (!opts.onUpdate) return;
		if (session.backgrounded || session.exited || updatesDisabled) return;
		const tailText = session.tail || session.aggregated;
		opts.onUpdate({
			content: [{
				type: "text",
				text: renderExecUpdateText({
					tailText,
					warnings: opts.warnings
				})
			}],
			details: {
				status: "running",
				sessionId,
				pid: session.pid ?? void 0,
				startedAt,
				cwd: session.cwd,
				tail: session.tail
			}
		});
	};
	const handleStdout = (data) => {
		const raw = data;
		const mode = detectCursorKeyMode(raw);
		if (mode) session.cursorKeyMode = mode;
		const str = sanitizeBinaryOutput(raw);
		for (const chunk of chunkString(str)) {
			appendOutput(session, "stdout", chunk);
			emitUpdate();
		}
	};
	const handleStderr = (data) => {
		const str = sanitizeBinaryOutput(data);
		for (const chunk of chunkString(str)) {
			appendOutput(session, "stderr", chunk);
			emitUpdate();
		}
	};
	const timeoutMs = typeof opts.timeoutSec === "number" && opts.timeoutSec > 0 ? Math.floor(opts.timeoutSec * 1e3) : void 0;
	let sandboxFinalizeToken;
	const spawnSpec = await (async () => {
		if (opts.sandbox) {
			const backendExecSpec = await opts.sandbox.buildExecSpec?.({
				command: execCommand,
				workdir: opts.containerWorkdir ?? opts.sandbox.containerWorkdir,
				env: shellRuntimeEnv,
				usePty: opts.usePty
			});
			sandboxFinalizeToken = backendExecSpec?.finalizeToken;
			return {
				mode: "child",
				argv: backendExecSpec?.argv ?? ["docker", ...buildDockerExecArgs({
					containerName: opts.sandbox.containerName,
					command: execCommand,
					workdir: opts.containerWorkdir ?? opts.sandbox.containerWorkdir,
					env: shellRuntimeEnv,
					tty: opts.usePty
				})],
				env: backendExecSpec?.env ?? process.env,
				stdinMode: backendExecSpec?.stdinMode ?? (opts.usePty ? "pipe-open" : "pipe-closed")
			};
		}
		const { shell, args: shellArgs } = getShellConfig();
		const commandWithPathPrepend = wrapPosixCommandWithPathPrepend(execCommand, shellRuntimeEnv, opts.pathPrepend);
		const childArgv = [
			shell,
			...shellArgs,
			commandWithPathPrepend
		];
		if (opts.usePty) return {
			mode: "pty",
			ptyCommand: commandWithPathPrepend,
			childFallbackArgv: childArgv,
			env: shellRuntimeEnv,
			stdinMode: "pipe-open"
		};
		return {
			mode: "child",
			argv: childArgv,
			env: shellRuntimeEnv,
			stdinMode: "pipe-closed"
		};
	})();
	let managedRun = null;
	let usingPty = spawnSpec.mode === "pty";
	const cursorResponse = buildCursorPositionResponse();
	const onSupervisorStdout = (chunk) => {
		if (usingPty) {
			const { cleaned, requests } = stripDsrRequests(chunk);
			if (requests > 0 && managedRun?.stdin) for (let i = 0; i < requests; i += 1) managedRun.stdin.write(cursorResponse);
			handleStdout(cleaned);
			return;
		}
		handleStdout(chunk);
	};
	try {
		const spawnBase = {
			runId: sessionId,
			sessionId: opts.sessionKey?.trim() || sessionId,
			backendId: opts.sandbox ? "exec-sandbox" : "exec-host",
			scopeKey: opts.scopeKey,
			cwd: opts.workdir,
			env: spawnSpec.env,
			timeoutMs,
			captureOutput: false,
			onStdout: onSupervisorStdout,
			onStderr: handleStderr
		};
		managedRun = spawnSpec.mode === "pty" ? await supervisor.spawn({
			...spawnBase,
			mode: "pty",
			ptyCommand: spawnSpec.ptyCommand
		}) : await supervisor.spawn({
			...spawnBase,
			mode: "child",
			argv: spawnSpec.argv,
			stdinMode: spawnSpec.stdinMode
		});
	} catch (err) {
		if (spawnSpec.mode === "pty") {
			const warning = `Warning: PTY spawn failed (${String(err)}); retrying without PTY for \`${opts.command}\`.`;
			logWarn(`exec: PTY spawn failed (${String(err)}); retrying without PTY for "${opts.command}".`);
			opts.warnings.push(warning);
			usingPty = false;
			try {
				managedRun = await supervisor.spawn({
					runId: sessionId,
					sessionId: opts.sessionKey?.trim() || sessionId,
					backendId: "exec-host",
					scopeKey: opts.scopeKey,
					mode: "child",
					argv: spawnSpec.childFallbackArgv,
					cwd: opts.workdir,
					env: spawnSpec.env,
					stdinMode: "pipe-open",
					timeoutMs,
					captureOutput: false,
					onStdout: handleStdout,
					onStderr: handleStderr
				});
			} catch (retryErr) {
				markExited(session, null, null, "failed");
				maybeNotifyOnExit(session, "failed");
				emitExecProcessCompleted({
					command: opts.command,
					mode: "child",
					outcome: buildExecRuntimeErrorOutcome({
						error: retryErr,
						aggregated: session.aggregated.trim(),
						durationMs: Date.now() - startedAt
					}),
					sessionKey: opts.sessionKey,
					target: diagnosticTarget
				});
				throw retryErr;
			}
		} else {
			markExited(session, null, null, "failed");
			maybeNotifyOnExit(session, "failed");
			emitExecProcessCompleted({
				command: opts.command,
				mode: spawnSpec.mode,
				outcome: buildExecRuntimeErrorOutcome({
					error: err,
					aggregated: session.aggregated.trim(),
					durationMs: Date.now() - startedAt
				}),
				sessionKey: opts.sessionKey,
				target: diagnosticTarget
			});
			throw err;
		}
	}
	session.stdin = managedRun.stdin;
	session.pid = managedRun.pid;
	const promise = managedRun.wait().then(async (exit) => {
		updatesDisabled = true;
		const durationMs = Date.now() - startedAt;
		const outcome = buildExecExitOutcome({
			exit,
			aggregated: session.aggregated.trim(),
			durationMs,
			timeoutSec: opts.timeoutSec
		});
		markExited(session, exit.exitCode, exit.exitSignal, outcome.status, exit.reason);
		maybeNotifyOnExit(session, outcome.status);
		if (!session.child && session.stdin) session.stdin.destroyed = true;
		if (opts.sandbox?.finalizeExec) await opts.sandbox.finalizeExec({
			status: outcome.status,
			exitCode: exit.exitCode ?? null,
			timedOut: exit.timedOut,
			token: sandboxFinalizeToken
		});
		emitExecProcessCompleted({
			command: opts.command,
			mode: usingPty ? "pty" : "child",
			outcome,
			sessionKey: opts.sessionKey,
			target: diagnosticTarget
		});
		return outcome;
	}).catch((err) => {
		updatesDisabled = true;
		markExited(session, null, null, "failed");
		maybeNotifyOnExit(session, "failed");
		const outcome = buildExecRuntimeErrorOutcome({
			error: err,
			aggregated: session.aggregated.trim(),
			durationMs: Date.now() - startedAt
		});
		emitExecProcessCompleted({
			command: opts.command,
			mode: usingPty ? "pty" : "child",
			outcome,
			sessionKey: opts.sessionKey,
			target: diagnosticTarget
		});
		return outcome;
	});
	return {
		session,
		startedAt,
		pid: session.pid ?? void 0,
		promise,
		kill: () => {
			managedRun?.cancel("manual-cancel");
		},
		disableUpdates: () => {
			updatesDisabled = true;
		}
	};
}
//#endregion
export { DEFAULT_PENDING_MAX_OUTPUT as a, createApprovalSlug as c, renderExecTargetLabel as d, resolveApprovalRunningNoticeMs as f, renderExecOutputText as h, DEFAULT_PATH as i, isRequestedExecTargetAllowed as l, runExecProcess as m, DEFAULT_APPROVAL_TIMEOUT_MS as n, applyShellPath as o, resolveExecTarget as p, DEFAULT_MAX_OUTPUT as r, buildApprovalPendingMessage as s, DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS as t, normalizeNotifyOutput as u };
