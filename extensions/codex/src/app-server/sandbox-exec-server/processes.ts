/**
 * Manages subprocess lifecycle, streaming output buffers, stdin writes, and
 * termination for Codex sandbox exec-server process RPCs.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildRemoteCommand,
  prepareSandboxProcessCleanup,
  sanitizeEnvVars,
} from "openclaw/plugin-sdk/sandbox";
import type { CodexNativeProcessClient } from "../native-process-authority.js";
import type { JsonObject, JsonValue } from "../protocol.js";
import { resolveFsSandboxPolicy } from "./fs-policy.js";
import { requireObject, requireString, requireStringArray } from "./json-rpc.js";
import { resolveExecServerPath } from "./path-uri.js";
import { spawnSandboxChild } from "./sandbox-child.js";
import type { ManagedProcess, OpenClawExecServer, ProcessChunk } from "./types.js";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RETAINED_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const CLOSED_PROCESS_EVICTION_MS = 60_000;

/** Starts a sandbox-backed process and registers it in the connection-local process table. */
export async function startProcess(
  execServer: OpenClawExecServer,
  processes: Map<string, ManagedProcess>,
  notify: ManagedProcess["emitNotification"],
  params: JsonValue | undefined,
  processAuthority?: CodexNativeProcessClient,
): Promise<JsonObject> {
  const record = requireObject(params, "process/start params");
  const processId = requireString(record.processId, "processId");
  if (processes.has(processId)) {
    throw new Error(`process already exists: ${processId}`);
  }
  const argv = requireStringArray(record.argv, "argv");
  const cwd = resolveExecServerPath(requireString(record.cwd, "cwd"), "process cwd");
  rejectUnsupportedArg0(record.arg0);
  assertSupportedProcessSandbox(execServer, record);
  const env = readProcessEnv(record);
  const tty = record.tty === true;
  const pipeStdin = record.pipeStdin === true;
  const managed: ManagedProcess = {
    processId,
    chunks: [],
    retainedOutputBytes: 0,
    nextSeq: 1,
    exited: false,
    exitCode: null,
    closed: false,
    failure: null,
    tty,
    pipeStdin,
    terminationRequested: false,
    child: null,
    waiters: [],
    emitNotification: notify,
    evictProcess: () => {
      if (managed.evictionTimer) {
        return;
      }
      managed.evictionTimer = setTimeout(() => {
        if (processes.get(processId) === managed && managed.closed) {
          processes.delete(processId);
        }
      }, CLOSED_PROCESS_EVICTION_MS);
      managed.evictionTimer.unref?.();
    },
  };
  const source = processAuthority?.claim(record.metadata, async () => {
    await terminateManagedProcess(managed);
  });
  processes.set(processId, managed);
  const startPromise = runProcess(execServer, managed, { argv, cwd, env, source });
  managed.startPromise = startPromise;
  // Keep original-source custody through backend settlement, independently of
  // native item receipts or reuse of the transport's string process handle.
  void startPromise
    .catch(() => undefined)
    .then(async () => {
      await managed.child?.settled;
      if (managed.terminationRequested) {
        // Transport close can precede a failed remote termination receipt.
        // Join the exact cleanup operation before releasing its custody.
        await managed.child?.terminate();
      }
      source?.settle();
    })
    .catch((error: unknown) => {
      source?.fail(error);
      embeddedAgentLog.warn("codex sandbox process settlement failed", {
        processId,
        error: coerceErrorMessage(error),
      });
    });
  try {
    await startPromise;
  } catch (error) {
    managed.failure = coerceErrorMessage(error);
    await managed.child?.terminate().catch((cleanupError: unknown) => {
      embeddedAgentLog.warn("codex sandbox failed-start cleanup failed", {
        processId,
        error: coerceErrorMessage(cleanupError),
      });
    });
    processes.delete(processId);
    managed.exitCode = null;
    managed.exited = true;
    managed.closed = true;
    notifyProcessWaiters(managed);
    throw error;
  } finally {
    if (managed.startPromise === startPromise) {
      managed.startPromise = undefined;
    }
  }
  return { processId, sandboxType: "none" };
}

function assertSupportedProcessSandbox(execServer: OpenClawExecServer, record: JsonObject): void {
  if (record.networkProxy !== undefined && record.networkProxy !== null) {
    throw new Error("Codex sandbox exec-server network proxy launch is not supported.");
  }
  if (
    record.enforceManagedNetwork === true ||
    (record.managedNetwork !== undefined && record.managedNetwork !== null)
  ) {
    throw new Error(
      "Codex managed network restrictions cannot be enforced by the sandbox backend.",
    );
  }
  // Docker/SSH owns the outer sandbox; it cannot impose narrower Codex process-local policy.
  if (resolveFsSandboxPolicy(execServer, record)?.unrestricted === false) {
    throw new Error(
      "Codex process filesystem sandbox restrictions cannot be enforced by the backend.",
    );
  }
  if (record.sandbox === undefined || record.sandbox === null) {
    return;
  }
  const sandbox = requireObject(record.sandbox, "process sandbox context");
  const permissions = requireObject(sandbox.permissions, "process sandbox permissions");
  if (permissions.network !== "restricted") {
    return;
  }
  if (!execServer.networkIsolated) {
    throw new Error("Codex network restrictions cannot be enforced by the sandbox backend.");
  }
}

async function runProcess(
  execServer: OpenClawExecServer,
  managed: ManagedProcess,
  params: {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    source?: ReturnType<CodexNativeProcessClient["claim"]>;
  },
): Promise<void> {
  const backend = execServer.backend;
  params.source?.assertAdmission();
  throwIfProcessStartCancelled(managed);
  const remoteExec = prepareSandboxProcessCleanup(backend, params.env);
  const execSpec = await backend.buildExecSpec({
    // Preserve the process identity and signal status of the requested argv.
    command: `exec ${buildRemoteCommand(params.argv)}`,
    workdir: params.cwd,
    env: remoteExec.env,
    usePty: managed.tty,
  });
  if (managed.terminationRequested) {
    await backend.finalizeExec?.({
      status: "failed",
      exitCode: null,
      timedOut: false,
      token: execSpec.finalizeToken,
    });
    throw new Error("process start cancelled");
  }
  let spawned = false;
  const owner = await spawnSandboxChild({
    argv: execSpec.argv,
    env: execSpec.env,
    cwd: execSpec.cwd,
    usePty: managed.tty,
    assertCurrent: () => {
      if (spawned) {
        params.source?.assertCurrent();
      } else {
        params.source?.assertAdmission();
      }
      execSpec.assertCurrent?.();
      throwIfProcessStartCancelled(managed);
    },
    finalizeExec: backend.finalizeExec,
    finalizeToken: execSpec.finalizeToken,
    finalizeStatus: () => (managed.failure ? "failed" : "completed"),
    onFinalizeError: (error) => {
      const message = coerceErrorMessage(error);
      managed.failure ??= message;
      embeddedAgentLog.warn("codex sandbox exec-server finalize failed", {
        processId: managed.processId,
        error: message,
      });
    },
    owners: execServer.children,
    terminateRemote: remoteExec.terminate,
    interruptRemote: remoteExec.interrupt,
  });
  spawned = true;
  managed.child = owner;
  void owner.exited.then(({ exitCode }) => emitProcessExited(managed, exitCode));
  void owner.closed.then(({ exitCode }) => emitProcessClosed(managed, exitCode));
  if ("pty" in owner) {
    owner.pty.onData((chunk) => appendProcessChunk(managed, "pty", Buffer.from(chunk)));
    return;
  }
  const child = owner.process;
  child.stdout.on("data", (chunk: Buffer) => appendProcessChunk(managed, "stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => appendProcessChunk(managed, "stderr", chunk));
  child.once("error", (error) => {
    // Node can report an abort or transport error before the child exits. The
    // backend lease and Codex terminal notifications stay owned until close.
    managed.failure ??= error.message;
    notifyProcessWaiters(managed);
  });
  child.stdin.on("error", (error: Error) => {
    managed.failure ??= error.message;
    notifyProcessWaiters(managed);
  });
  owner.assertCurrent();
  if (!managed.tty && !managed.pipeStdin) {
    child.stdin.end();
  }
}

function throwIfProcessStartCancelled(managed: ManagedProcess): void {
  if (managed.terminationRequested) {
    throw new Error("process start cancelled");
  }
}

function appendProcessChunk(
  managed: ManagedProcess,
  stream: ProcessChunk["stream"],
  data: Buffer,
): void {
  if (data.length === 0) {
    return;
  }
  const chunk = {
    seq: managed.nextSeq,
    stream,
    chunk: data.toString("base64"),
  };
  managed.chunks.push(chunk);
  managed.retainedOutputBytes += data.length;
  // Keep enough recent output for polling clients without letting long-running
  // processes grow the app-server bridge memory without bound.
  while (managed.retainedOutputBytes > RETAINED_PROCESS_OUTPUT_BYTES && managed.chunks.length > 1) {
    const removed = managed.chunks.shift();
    if (!removed) {
      break;
    }
    managed.retainedOutputBytes -= Buffer.from(removed.chunk, "base64").byteLength;
  }
  managed.nextSeq += 1;
  managed.emitNotification("process/output", {
    processId: managed.processId,
    seq: chunk.seq,
    stream: chunk.stream,
    chunk: chunk.chunk,
  });
  notifyProcessWaiters(managed);
}

function emitProcessExited(managed: ManagedProcess, exitCode: number | null): void {
  if (!managed.exited) {
    const exitSeq = managed.nextSeq;
    managed.nextSeq += 1;
    managed.exitCode = exitCode;
    managed.exited = true;
    if (exitCode !== null) {
      managed.emitNotification("process/exited", {
        processId: managed.processId,
        seq: exitSeq,
        exitCode,
        sandboxDenied: false,
      });
    }
  }
  notifyProcessWaiters(managed);
}

function emitProcessClosed(managed: ManagedProcess, exitCode: number | null): void {
  emitProcessExited(managed, exitCode);
  if (!managed.closed) {
    const closeSeq = managed.nextSeq;
    managed.nextSeq += 1;
    managed.closed = true;
    managed.emitNotification("process/closed", {
      processId: managed.processId,
      seq: closeSeq,
    });
  }
  // Closed processes stay briefly readable so clients that observe close before
  // their final poll can still drain exit/output state.
  managed.evictProcess();
  notifyProcessWaiters(managed);
}

function limitProcessChunks(chunks: ProcessChunk[], maxBytes: number | undefined): ProcessChunk[] {
  if (!maxBytes) {
    return chunks;
  }
  const retained: ProcessChunk[] = [];
  let retainedBytes = 0;
  for (const chunk of chunks) {
    const byteLength = Buffer.from(chunk.chunk, "base64").byteLength;
    if (retained.length > 0 && retainedBytes + byteLength > maxBytes) {
      break;
    }
    retained.push(chunk);
    retainedBytes += byteLength;
    if (retainedBytes >= maxBytes) {
      break;
    }
  }
  return retained;
}

/** Reads buffered process output, optionally waiting for new output or process close. */
export async function readProcess(
  processes: Map<string, ManagedProcess>,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "process/read params");
  const processId = requireString(record.processId, "processId");
  const managed = requireProcess(processes, processId);
  const afterSeq = typeof record.afterSeq === "number" ? record.afterSeq : 0;
  const waitMs = typeof record.waitMs === "number" && record.waitMs > 0 ? record.waitMs : 0;
  if (!managed.closed && managed.nextSeq - 1 <= afterSeq && waitMs > 0) {
    await waitForProcessUpdate(managed, waitMs);
  }
  const chunks = limitProcessChunks(
    managed.chunks.filter((chunk) => chunk.seq > afterSeq),
    typeof record.maxBytes === "number" && record.maxBytes > 0 ? record.maxBytes : undefined,
  );
  const lastChunk = chunks.at(-1);
  return {
    chunks,
    nextSeq: lastChunk ? lastChunk.seq + 1 : managed.nextSeq,
    exited: managed.exited,
    exitCode: managed.exitCode,
    closed: managed.closed,
    failure: managed.failure,
  };
}

/** Writes base64 stdin data to a running process when stdin is still open. */
export function writeProcess(
  processes: Map<string, ManagedProcess>,
  params: JsonValue | undefined,
): JsonObject {
  const record = requireObject(params, "process/write params");
  const processId = requireString(record.processId, "processId");
  const managed = processes.get(processId);
  if (!managed) {
    return { status: "unknownProcess" };
  }
  const chunk = Buffer.from(requireString(record.chunk, "chunk"), "base64");
  if ((!managed.tty && !managed.pipeStdin) || managed.closed || !managed.child) {
    return { status: "stdinClosed" };
  }
  if ("pty" in managed.child) {
    managed.child.assertCurrent();
    managed.child.pty.write(chunk);
  } else {
    if (!managed.child.process.stdin.writable) {
      return { status: "stdinClosed" };
    }
    managed.child.assertCurrent();
    managed.child.process.stdin.write(chunk);
  }
  return { status: "accepted" };
}

export async function signalProcess(
  processes: Map<string, ManagedProcess>,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "process/signal params");
  const processId = requireString(record.processId, "processId");
  if (record.signal !== "interrupt") {
    throw new Error("process/signal only supports interrupt");
  }
  const managed = processes.get(processId);
  if (managed && !managed.exited) {
    await managed.startPromise;
    managed.child?.assertCurrent();
    await managed.child?.interrupt();
  }
  return {};
}

/** Requests process termination and reports whether it was running at call time. */
export async function terminateProcess(
  processes: Map<string, ManagedProcess>,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "process/terminate params");
  const processId = requireString(record.processId, "processId");
  const managed = processes.get(processId);
  if (!managed) {
    return { running: false };
  }
  return await terminateManagedProcess(managed);
}

async function terminateManagedProcess(managed: ManagedProcess): Promise<JsonObject> {
  const running = !managed.exited;
  managed.terminationRequested = true;
  await managed.startPromise?.catch(() => undefined);
  if (managed.child) {
    await managed.child.terminate();
  } else if (running && !managed.closed) {
    emitProcessClosed(managed, null);
  }
  return { running };
}

function waitForProcessUpdate(managed: ManagedProcess, waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.min(waitMs, 30_000));
    function done() {
      clearTimeout(timer);
      managed.waiters = managed.waiters.filter((waiter) => waiter !== done);
      resolve();
    }
    managed.waiters.push(done);
  });
}

function notifyProcessWaiters(managed: ManagedProcess): void {
  const waiters = managed.waiters;
  managed.waiters = [];
  for (const waiter of waiters) {
    waiter();
  }
}

function requireProcess(processes: Map<string, ManagedProcess>, processId: string): ManagedProcess {
  const managed = processes.get(processId);
  if (!managed) {
    throw new Error(`unknown process: ${processId}`);
  }
  return managed;
}

function rejectUnsupportedArg0(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === "string") {
    throw new Error("Codex sandbox exec-server does not support arg0 overrides.");
  }
  throw new Error("arg0 must be a string or null.");
}

function readEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "string" && ENV_KEY_RE.test(key)) {
      env[key] = rawValue;
    }
  }
  return env;
}

function readProcessEnv(record: JsonObject): Record<string, string> {
  const policyEnv = buildEnvFromPolicy(record.envPolicy);
  const requestedEnv = {
    ...policyEnv,
    ...readEnv(record.env),
  };
  // Codex inherits its app-server's full environment by default. Scrub again at
  // this last boundary so no credential can cross into any sandbox backend.
  return sanitizeEnvVars(requestedEnv).allowed;
}

function buildEnvFromPolicy(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const policy = value as Record<string, unknown>;
  const inheritedEnv = readEnv(policy.set);
  const includeOnly = readStringList(policy.includeOnly);
  if (includeOnly.length > 0) {
    filterEnvKeys(inheritedEnv, includeOnly, true);
  }
  return inheritedEnv;
}

function filterEnvKeys(
  env: Record<string, string>,
  patterns: string[],
  keepMatches: boolean,
): void {
  if (patterns.length === 0) {
    return;
  }
  const regexes = patterns.map((pattern) => wildcardPatternToRegex(pattern));
  for (const key of Object.keys(env)) {
    const matches = regexes.some((regex) => regex.test(key));
    if (matches !== keepMatches) {
      delete env[key];
    }
  }
}

function wildcardPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "iu");
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
