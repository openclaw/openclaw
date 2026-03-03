import { createSessionSlug as createSessionSlugId } from "./session-slug.js";
const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_JOB_TTL_MS = 60 * 1000; // 1 minute
const MAX_JOB_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
const DEFAULT_PENDING_OUTPUT_CHARS = 30000;
function clampTtl(value) {
    if (!value || Number.isNaN(value)) {
        return DEFAULT_JOB_TTL_MS;
    }
    return Math.min(Math.max(value, MIN_JOB_TTL_MS), MAX_JOB_TTL_MS);
}
let jobTtlMs = clampTtl(Number.parseInt(process.env.PI_BASH_JOB_TTL_MS ?? "", 10));
const runningSessions = new Map();
const finishedSessions = new Map();
let sweeper = null;
function isSessionIdTaken(id) {
    return runningSessions.has(id) || finishedSessions.has(id);
}
export function createSessionSlug() {
    return createSessionSlugId(isSessionIdTaken);
}
export function addSession(session) {
    runningSessions.set(session.id, session);
    startSweeper();
}
export function getSession(id) {
    return runningSessions.get(id);
}
export function getFinishedSession(id) {
    return finishedSessions.get(id);
}
export function deleteSession(id) {
    runningSessions.delete(id);
    finishedSessions.delete(id);
}
export function appendOutput(session, stream, chunk) {
    session.pendingStdout ??= [];
    session.pendingStderr ??= [];
    session.pendingStdoutChars ??= sumPendingChars(session.pendingStdout);
    session.pendingStderrChars ??= sumPendingChars(session.pendingStderr);
    const buffer = stream === "stdout" ? session.pendingStdout : session.pendingStderr;
    const bufferChars = stream === "stdout" ? session.pendingStdoutChars : session.pendingStderrChars;
    const pendingCap = Math.min(session.pendingMaxOutputChars ?? DEFAULT_PENDING_OUTPUT_CHARS, session.maxOutputChars);
    buffer.push(chunk);
    let pendingChars = bufferChars + chunk.length;
    if (pendingChars > pendingCap) {
        session.truncated = true;
        pendingChars = capPendingBuffer(buffer, pendingChars, pendingCap);
    }
    if (stream === "stdout") {
        session.pendingStdoutChars = pendingChars;
    }
    else {
        session.pendingStderrChars = pendingChars;
    }
    session.totalOutputChars += chunk.length;
    const aggregated = trimWithCap(session.aggregated + chunk, session.maxOutputChars);
    session.truncated =
        session.truncated || aggregated.length < session.aggregated.length + chunk.length;
    session.aggregated = aggregated;
    session.tail = tail(session.aggregated, 2000);
}
export function drainSession(session) {
    const stdout = session.pendingStdout.join("");
    const stderr = session.pendingStderr.join("");
    session.pendingStdout = [];
    session.pendingStderr = [];
    session.pendingStdoutChars = 0;
    session.pendingStderrChars = 0;
    return { stdout, stderr };
}
export function markExited(session, exitCode, exitSignal, status) {
    session.exited = true;
    session.exitCode = exitCode;
    session.exitSignal = exitSignal;
    session.tail = tail(session.aggregated, 2000);
    moveToFinished(session, status);
}
export function markBackgrounded(session) {
    session.backgrounded = true;
}
function moveToFinished(session, status) {
    runningSessions.delete(session.id);
    // Clean up child process stdio streams to prevent FD leaks
    if (session.child) {
        // Destroy stdio streams to release file descriptors
        session.child.stdin?.destroy?.();
        session.child.stdout?.destroy?.();
        session.child.stderr?.destroy?.();
        // Remove all event listeners to prevent memory leaks
        session.child.removeAllListeners();
        // Clear the reference
        delete session.child;
    }
    // Clean up stdin wrapper - call destroy if available, otherwise just remove reference
    if (session.stdin) {
        // Try to call destroy/end method if exists
        if (typeof session.stdin.destroy === "function") {
            session.stdin.destroy();
        }
        else if (typeof session.stdin.end === "function") {
            session.stdin.end();
        }
        // Only set flag if writable
        try {
            session.stdin.destroyed = true;
        }
        catch {
            // Ignore if read-only
        }
        delete session.stdin;
    }
    if (!session.backgrounded) {
        return;
    }
    finishedSessions.set(session.id, {
        id: session.id,
        command: session.command,
        scopeKey: session.scopeKey,
        startedAt: session.startedAt,
        endedAt: Date.now(),
        cwd: session.cwd,
        status,
        exitCode: session.exitCode,
        exitSignal: session.exitSignal,
        aggregated: session.aggregated,
        tail: session.tail,
        truncated: session.truncated,
        totalOutputChars: session.totalOutputChars,
    });
}
export function tail(text, max = 2000) {
    if (text.length <= max) {
        return text;
    }
    return text.slice(text.length - max);
}
function sumPendingChars(buffer) {
    let total = 0;
    for (const chunk of buffer) {
        total += chunk.length;
    }
    return total;
}
function capPendingBuffer(buffer, pendingChars, cap) {
    if (pendingChars <= cap) {
        return pendingChars;
    }
    const last = buffer.at(-1);
    if (last && last.length >= cap) {
        buffer.length = 0;
        buffer.push(last.slice(last.length - cap));
        return cap;
    }
    while (buffer.length && pendingChars - buffer[0].length >= cap) {
        pendingChars -= buffer[0].length;
        buffer.shift();
    }
    if (buffer.length && pendingChars > cap) {
        const overflow = pendingChars - cap;
        buffer[0] = buffer[0].slice(overflow);
        pendingChars = cap;
    }
    return pendingChars;
}
export function trimWithCap(text, max) {
    if (text.length <= max) {
        return text;
    }
    return text.slice(text.length - max);
}
export function listRunningSessions() {
    return Array.from(runningSessions.values()).filter((s) => s.backgrounded);
}
export function listFinishedSessions() {
    return Array.from(finishedSessions.values());
}
export function clearFinished() {
    finishedSessions.clear();
}
export function resetProcessRegistryForTests() {
    runningSessions.clear();
    finishedSessions.clear();
    stopSweeper();
}
export function setJobTtlMs(value) {
    if (value === undefined || Number.isNaN(value)) {
        return;
    }
    jobTtlMs = clampTtl(value);
    stopSweeper();
    startSweeper();
}
function pruneFinishedSessions() {
    const cutoff = Date.now() - jobTtlMs;
    for (const [id, session] of finishedSessions.entries()) {
        if (session.endedAt < cutoff) {
            finishedSessions.delete(id);
        }
    }
}
function startSweeper() {
    if (sweeper) {
        return;
    }
    sweeper = setInterval(pruneFinishedSessions, Math.max(30000, jobTtlMs / 6));
    sweeper.unref?.();
}
function stopSweeper() {
    if (!sweeper) {
        return;
    }
    clearInterval(sweeper);
    sweeper = null;
}
