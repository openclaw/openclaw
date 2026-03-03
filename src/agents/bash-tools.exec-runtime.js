import path from "node:path";
import { Type } from "@sinclair/typebox";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { isDangerousHostEnvVarName } from "../infra/host-env-security.js";
import { findPathKey, mergePathPrepend } from "../infra/path-prepend.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
export { applyPathPrepend, findPathKey, normalizePathPrepend } from "../infra/path-prepend.js";
import { logWarn } from "../logger.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { addSession, appendOutput, createSessionSlug, markExited, tail, } from "./bash-process-registry.js";
import { buildDockerExecArgs, chunkString, clampWithDefault, readEnvInt, } from "./bash-tools.shared.js";
import { buildCursorPositionResponse, stripDsrRequests } from "./pty-dsr.js";
import { getShellConfig, sanitizeBinaryOutput } from "./shell-utils.js";
// Sanitize inherited host env before merge so dangerous variables from process.env
// are not propagated into non-sandboxed executions.
export function sanitizeHostBaseEnv(env) {
    const sanitized = {};
    for (const [key, value] of Object.entries(env)) {
        const upperKey = key.toUpperCase();
        if (upperKey === "PATH") {
            sanitized[key] = value;
            continue;
        }
        if (isDangerousHostEnvVarName(upperKey)) {
            continue;
        }
        sanitized[key] = value;
    }
    return sanitized;
}
// Centralized sanitization helper.
// Throws an error if dangerous variables or PATH modifications are detected on the host.
export function validateHostEnv(env) {
    for (const key of Object.keys(env)) {
        const upperKey = key.toUpperCase();
        // 1. Block known dangerous variables (Fail Closed)
        if (isDangerousHostEnvVarName(upperKey)) {
            throw new Error(`Security Violation: Environment variable '${key}' is forbidden during host execution.`);
        }
        // 2. Strictly block PATH modification on host
        // Allowing custom PATH on the gateway/node can lead to binary hijacking.
        if (upperKey === "PATH") {
            throw new Error("Security Violation: Custom 'PATH' variable is forbidden during host execution.");
        }
    }
}
export const DEFAULT_MAX_OUTPUT = clampWithDefault(readEnvInt("PI_BASH_MAX_OUTPUT_CHARS"), 200000, 1000, 200000);
export const DEFAULT_PENDING_MAX_OUTPUT = clampWithDefault(readEnvInt("OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS"), 30000, 1000, 200000);
export const DEFAULT_PATH = process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const DEFAULT_NOTIFY_TAIL_CHARS = 400;
const DEFAULT_NOTIFY_SNIPPET_CHARS = 180;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120000;
export const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = 130000;
const DEFAULT_APPROVAL_RUNNING_NOTICE_MS = 10000;
const APPROVAL_SLUG_LENGTH = 8;
export const execSchema = Type.Object({
    command: Type.String({ description: "Shell command to execute" }),
    workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    yieldMs: Type.Optional(Type.Number({
        description: "Milliseconds to wait before backgrounding (default 10000)",
    })),
    background: Type.Optional(Type.Boolean({ description: "Run in background immediately" })),
    timeout: Type.Optional(Type.Number({
        description: "Timeout in seconds (optional, kills process on expiry)",
    })),
    pty: Type.Optional(Type.Boolean({
        description: "Run in a pseudo-terminal (PTY) when available (TTY-required CLIs, coding agents)",
    })),
    elevated: Type.Optional(Type.Boolean({
        description: "Run on the host with elevated permissions (if allowed)",
    })),
    host: Type.Optional(Type.String({
        description: "Exec host (sandbox|gateway|node).",
    })),
    security: Type.Optional(Type.String({
        description: "Exec security mode (deny|allowlist|full).",
    })),
    ask: Type.Optional(Type.String({
        description: "Exec ask mode (off|on-miss|always).",
    })),
    node: Type.Optional(Type.String({
        description: "Node id/name for host=node.",
    })),
});
export function normalizeExecHost(value) {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") {
        return normalized;
    }
    return null;
}
export function normalizeExecSecurity(value) {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
        return normalized;
    }
    return null;
}
export function normalizeExecAsk(value) {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
        return normalized;
    }
    return null;
}
export function renderExecHostLabel(host) {
    return host === "sandbox" ? "sandbox" : host === "gateway" ? "gateway" : "node";
}
export function normalizeNotifyOutput(value) {
    return value.replace(/\s+/g, " ").trim();
}
function compactNotifyOutput(value, maxChars = DEFAULT_NOTIFY_SNIPPET_CHARS) {
    const normalized = normalizeNotifyOutput(value);
    if (!normalized) {
        return "";
    }
    if (normalized.length <= maxChars) {
        return normalized;
    }
    const safe = Math.max(1, maxChars - 1);
    return `${normalized.slice(0, safe)}…`;
}
export function applyShellPath(env, shellPath) {
    if (!shellPath) {
        return;
    }
    const entries = shellPath
        .split(path.delimiter)
        .map((part) => part.trim())
        .filter(Boolean);
    if (entries.length === 0) {
        return;
    }
    const pathKey = findPathKey(env);
    const merged = mergePathPrepend(env[pathKey], entries);
    if (merged) {
        env[pathKey] = merged;
    }
}
function maybeNotifyOnExit(session, status) {
    if (!session.backgrounded || !session.notifyOnExit || session.exitNotified) {
        return;
    }
    const sessionKey = session.sessionKey?.trim();
    if (!sessionKey) {
        return;
    }
    session.exitNotified = true;
    const exitLabel = session.exitSignal
        ? `signal ${session.exitSignal}`
        : `code ${session.exitCode ?? 0}`;
    const output = compactNotifyOutput(tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS));
    if (status === "completed" && !output && session.notifyOnExitEmptySuccess !== true) {
        return;
    }
    const summary = output
        ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
        : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;
    enqueueSystemEvent(summary, { sessionKey });
    requestHeartbeatNow({ reason: `exec:${session.id}:exit` });
}
export function createApprovalSlug(id) {
    return id.slice(0, APPROVAL_SLUG_LENGTH);
}
export function resolveApprovalRunningNoticeMs(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_APPROVAL_RUNNING_NOTICE_MS;
    }
    if (value <= 0) {
        return 0;
    }
    return Math.floor(value);
}
export function emitExecSystemEvent(text, opts) {
    const sessionKey = opts.sessionKey?.trim();
    if (!sessionKey) {
        return;
    }
    enqueueSystemEvent(text, { sessionKey, contextKey: opts.contextKey });
    requestHeartbeatNow({ reason: "exec-event" });
}
export async function runExecProcess(opts) {
    const startedAt = Date.now();
    const sessionId = createSessionSlug();
    const execCommand = opts.execCommand ?? opts.command;
    const supervisor = getProcessSupervisor();
    const shellRuntimeEnv = {
        ...opts.env,
        OPENCLAW_SHELL: "exec",
    };
    const session = {
        id: sessionId,
        command: opts.command,
        scopeKey: opts.scopeKey,
        sessionKey: opts.sessionKey,
        notifyOnExit: opts.notifyOnExit,
        notifyOnExitEmptySuccess: opts.notifyOnExitEmptySuccess === true,
        exitNotified: false,
        child: undefined,
        stdin: undefined,
        pid: undefined,
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
        exitCode: undefined,
        exitSignal: undefined,
        truncated: false,
        backgrounded: false,
    };
    addSession(session);
    const emitUpdate = () => {
        if (!opts.onUpdate) {
            return;
        }
        const tailText = session.tail || session.aggregated;
        const warningText = opts.warnings.length ? `${opts.warnings.join("\n")}\n\n` : "";
        opts.onUpdate({
            content: [{ type: "text", text: warningText + (tailText || "") }],
            details: {
                status: "running",
                sessionId,
                pid: session.pid ?? undefined,
                startedAt,
                cwd: session.cwd,
                tail: session.tail,
            },
        });
    };
    const handleStdout = (data) => {
        const str = sanitizeBinaryOutput(data.toString());
        for (const chunk of chunkString(str)) {
            appendOutput(session, "stdout", chunk);
            emitUpdate();
        }
    };
    const handleStderr = (data) => {
        const str = sanitizeBinaryOutput(data.toString());
        for (const chunk of chunkString(str)) {
            appendOutput(session, "stderr", chunk);
            emitUpdate();
        }
    };
    const timeoutMs = typeof opts.timeoutSec === "number" && opts.timeoutSec > 0
        ? Math.floor(opts.timeoutSec * 1000)
        : undefined;
    const spawnSpec = (() => {
        if (opts.sandbox) {
            return {
                mode: "child",
                argv: [
                    "docker",
                    ...buildDockerExecArgs({
                        containerName: opts.sandbox.containerName,
                        command: execCommand,
                        workdir: opts.containerWorkdir ?? opts.sandbox.containerWorkdir,
                        env: shellRuntimeEnv,
                        tty: opts.usePty,
                    }),
                ],
                env: process.env,
                stdinMode: opts.usePty ? "pipe-open" : "pipe-closed",
            };
        }
        const { shell, args: shellArgs } = getShellConfig();
        const childArgv = [shell, ...shellArgs, execCommand];
        if (opts.usePty) {
            return {
                mode: "pty",
                ptyCommand: execCommand,
                childFallbackArgv: childArgv,
                env: shellRuntimeEnv,
                stdinMode: "pipe-open",
            };
        }
        return {
            mode: "child",
            argv: childArgv,
            env: shellRuntimeEnv,
            stdinMode: "pipe-closed",
        };
    })();
    let managedRun = null;
    let usingPty = spawnSpec.mode === "pty";
    const cursorResponse = buildCursorPositionResponse();
    const onSupervisorStdout = (chunk) => {
        if (usingPty) {
            const { cleaned, requests } = stripDsrRequests(chunk);
            if (requests > 0 && managedRun?.stdin) {
                for (let i = 0; i < requests; i += 1) {
                    managedRun.stdin.write(cursorResponse);
                }
            }
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
            onStderr: handleStderr,
        };
        managedRun =
            spawnSpec.mode === "pty"
                ? await supervisor.spawn({
                    ...spawnBase,
                    mode: "pty",
                    ptyCommand: spawnSpec.ptyCommand,
                })
                : await supervisor.spawn({
                    ...spawnBase,
                    mode: "child",
                    argv: spawnSpec.argv,
                    stdinMode: spawnSpec.stdinMode,
                });
    }
    catch (err) {
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
                    onStderr: handleStderr,
                });
            }
            catch (retryErr) {
                markExited(session, null, null, "failed");
                maybeNotifyOnExit(session, "failed");
                throw retryErr;
            }
        }
        else {
            markExited(session, null, null, "failed");
            maybeNotifyOnExit(session, "failed");
            throw err;
        }
    }
    session.stdin = managedRun.stdin;
    session.pid = managedRun.pid;
    const promise = managedRun
        .wait()
        .then((exit) => {
        const durationMs = Date.now() - startedAt;
        const isNormalExit = exit.reason === "exit";
        const exitCode = exit.exitCode ?? 0;
        // Shell exit codes 126 (not executable) and 127 (command not found) are
        // unrecoverable infrastructure failures that should surface as real errors
        // rather than silently completing — e.g. `python: command not found`.
        const isShellFailure = exitCode === 126 || exitCode === 127;
        const status = isNormalExit && !isShellFailure ? "completed" : "failed";
        markExited(session, exit.exitCode, exit.exitSignal, status);
        maybeNotifyOnExit(session, status);
        if (!session.child && session.stdin) {
            session.stdin.destroyed = true;
        }
        const aggregated = session.aggregated.trim();
        if (status === "completed") {
            const exitMsg = exitCode !== 0 ? `\n\n(Command exited with code ${exitCode})` : "";
            return {
                status: "completed",
                exitCode,
                exitSignal: exit.exitSignal,
                durationMs,
                aggregated: aggregated + exitMsg,
                timedOut: false,
            };
        }
        const reason = isShellFailure
            ? exitCode === 127
                ? "Command not found"
                : "Command not executable (permission denied)"
            : exit.reason === "overall-timeout"
                ? typeof opts.timeoutSec === "number" && opts.timeoutSec > 0
                    ? `Command timed out after ${opts.timeoutSec} seconds`
                    : "Command timed out"
                : exit.reason === "no-output-timeout"
                    ? "Command timed out waiting for output"
                    : exit.exitSignal != null
                        ? `Command aborted by signal ${exit.exitSignal}`
                        : "Command aborted before exit code was captured";
        return {
            status: "failed",
            exitCode: exit.exitCode,
            exitSignal: exit.exitSignal,
            durationMs,
            aggregated,
            timedOut: exit.timedOut,
            reason: aggregated ? `${aggregated}\n\n${reason}` : reason,
        };
    })
        .catch((err) => {
        markExited(session, null, null, "failed");
        maybeNotifyOnExit(session, "failed");
        const aggregated = session.aggregated.trim();
        const message = aggregated ? `${aggregated}\n\n${String(err)}` : String(err);
        return {
            status: "failed",
            exitCode: null,
            exitSignal: null,
            durationMs: Date.now() - startedAt,
            aggregated,
            timedOut: false,
            reason: message,
        };
    });
    return {
        session,
        startedAt,
        pid: session.pid ?? undefined,
        promise,
        kill: () => {
            managedRun?.cancel("manual-cancel");
        },
    };
}
