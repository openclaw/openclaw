import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type AcpxTerminalState =
  | "accepted"
  | "started"
  | "completed"
  | "failed"
  | "timed_out"
  | "lost";

export type AcpxRouteKind = "prompt_session";

export type AcpxRunArtifacts = {
  runId: string;
  requestId: string | null;
  runDir: string;
  routePath: string;
  terminalPath: string;
  stdoutPath: string;
  stderrPath: string;
};

type RouteArtifact = {
  run_id: string;
  request_id: string | null;
  backend: "acpx";
  session_key: string;
  runtime_session_name: string;
  agent: string;
  prompt_mode: "prompt" | "steer";
  route_kind: AcpxRouteKind;
  route_args: string[];
  cwd: string;
  acpx_record_id?: string;
  backend_session_id?: string;
  agent_session_id?: string;
  accepted_at: string;
  started_at?: string;
  state: AcpxTerminalState;
  pid?: number;
};

type TerminalArtifact = {
  run_id: string;
  request_id: string | null;
  state: AcpxTerminalState;
  capture_status: "pending" | "captured" | "missing";
  done_seen: boolean;
  synthetic_done: boolean;
  error_seen: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  started_at?: string;
  ended_at?: string;
  stdout_ref: string;
  stderr_ref: string;
  route_ref: string;
  result_ref: string | null;
  error_ref: string | null;
  stop_reason?: string;
  error_code?: string;
  error_message?: string;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_lines: number;
  stderr_lines: number;
};

function resolveStateDir(): string {
  const configured = process.env.OPENCLAW_STATE_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".openclaw");
}

export function resolveAcpxRunArtifactRoot(): string {
  return path.join(resolveStateDir(), "artifacts", "acpx", "runs");
}

function sanitizeRunId(value: string): string {
  const trimmed = value.trim();
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return sanitized.replace(/^-|-$/g, "") || "run";
}

async function allocateRunId(rootDir: string, seed: string): Promise<string> {
  const normalized = sanitizeRunId(seed);
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const candidate = attempt === 1 ? normalized : `${normalized}--${attempt}`;
    const candidateDir = path.join(rootDir, candidate);
    try {
      await mkdir(candidateDir, { recursive: false });
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      // directory already exists — try next suffix
    }
  }
  const timestampCandidate = `${normalized}--${Date.now()}`;
  await mkdir(path.join(rootDir, timestampCandidate), { recursive: false });
  return timestampCandidate;
}

async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(tempPath, filePath);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function updateRoute(
  artifacts: AcpxRunArtifacts,
  patch: Partial<RouteArtifact>,
): Promise<RouteArtifact> {
  const current = await readJsonFile<RouteArtifact>(artifacts.routePath);
  const next: RouteArtifact = {
    ...current,
    ...patch,
  };
  await writeJsonAtomic(artifacts.routePath, next);
  return next;
}

async function updateTerminal(
  artifacts: AcpxRunArtifacts,
  patch: Partial<TerminalArtifact>,
): Promise<TerminalArtifact> {
  const current = await readJsonFile<TerminalArtifact>(artifacts.terminalPath);
  const next: TerminalArtifact = {
    ...current,
    ...patch,
  };
  await writeJsonAtomic(artifacts.terminalPath, next);
  return next;
}

export async function createRunArtifacts(params: {
  requestId?: string;
  sessionKey: string;
  runtimeSessionName: string;
  agent: string;
  promptMode: "prompt" | "steer";
  routeKind: AcpxRouteKind;
  routeArgs: string[];
  cwd: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
}): Promise<AcpxRunArtifacts> {
  const rootDir = resolveAcpxRunArtifactRoot();
  await mkdir(rootDir, { recursive: true });
  const requestId = params.requestId?.trim() || null;
  const runId = await allocateRunId(rootDir, requestId || `${params.agent}-${Date.now()}`);
  const runDir = path.join(rootDir, runId);
  const routePath = path.join(runDir, "route.json");
  const terminalPath = path.join(runDir, "terminal.json");
  const stdoutPath = path.join(runDir, "stdout.log");
  const stderrPath = path.join(runDir, "stderr.log");
  const acceptedAt = new Date().toISOString();

  const artifacts: AcpxRunArtifacts = {
    runId,
    requestId,
    runDir,
    routePath,
    terminalPath,
    stdoutPath,
    stderrPath,
  };

  const routeArtifact: RouteArtifact = {
    run_id: runId,
    request_id: requestId,
    backend: "acpx",
    session_key: params.sessionKey,
    runtime_session_name: params.runtimeSessionName,
    agent: params.agent,
    prompt_mode: params.promptMode,
    route_kind: params.routeKind,
    route_args: params.routeArgs,
    cwd: params.cwd,
    accepted_at: acceptedAt,
    state: "accepted",
    ...(params.acpxRecordId ? { acpx_record_id: params.acpxRecordId } : {}),
    ...(params.backendSessionId ? { backend_session_id: params.backendSessionId } : {}),
    ...(params.agentSessionId ? { agent_session_id: params.agentSessionId } : {}),
  };

  const terminalRef = pathToFileURL(terminalPath).toString();
  const terminalArtifact: TerminalArtifact = {
    run_id: runId,
    request_id: requestId,
    state: "accepted",
    capture_status: "pending",
    done_seen: false,
    synthetic_done: false,
    error_seen: false,
    exit_code: null,
    signal: null,
    stdout_ref: pathToFileURL(stdoutPath).toString(),
    stderr_ref: pathToFileURL(stderrPath).toString(),
    route_ref: pathToFileURL(routePath).toString(),
    result_ref: null,
    error_ref: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_lines: 0,
    stderr_lines: 0,
  };

  await writeFile(stdoutPath, "", "utf8");
  await writeFile(stderrPath, "", "utf8");
  await writeJsonAtomic(routePath, routeArtifact);
  await writeJsonAtomic(terminalPath, terminalArtifact);

  return artifacts;
}

export async function setRunStarted(params: {
  artifacts: AcpxRunArtifacts;
  startedAt: string;
  pid?: number;
}): Promise<void> {
  await updateRoute(params.artifacts, {
    state: "started",
    started_at: params.startedAt,
    ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
  });
  await updateTerminal(params.artifacts, {
    state: "started",
    started_at: params.startedAt,
  });
}

export async function appendStdout(params: {
  artifacts: AcpxRunArtifacts;
  line: string;
}): Promise<void> {
  await appendFile(params.artifacts.stdoutPath, params.line + "\n", "utf8");
}

export async function appendStderr(params: {
  artifacts: AcpxRunArtifacts;
  chunk: string;
}): Promise<void> {
  await appendFile(params.artifacts.stderrPath, params.chunk, "utf8");
}

export async function finalizeRun(params: {
  artifacts: AcpxRunArtifacts;
  state: Exclude<AcpxTerminalState, "accepted" | "started">;
  captureStatus?: "captured" | "missing";
  doneSeen: boolean;
  syntheticDone: boolean;
  errorSeen: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutLines: number;
  stderrLines: number;
  startedAt?: string;
  endedAt: string;
}): Promise<void> {
  const terminalRef = pathToFileURL(params.artifacts.terminalPath).toString();
  const finalState = params.state;
  const captureStatus = params.captureStatus ?? "captured";
  if (finalState === "completed" && captureStatus !== "captured") {
    throw new Error("completed state requires captured terminal truth");
  }
  await updateTerminal(params.artifacts, {
    state: finalState,
    capture_status: captureStatus,
    done_seen: params.doneSeen,
    synthetic_done: params.syntheticDone,
    error_seen: params.errorSeen,
    exit_code: params.exitCode,
    signal: params.signal,
    started_at: params.startedAt,
    ended_at: params.endedAt,
    stop_reason: params.stopReason,
    error_code: params.errorCode,
    error_message: params.errorMessage,
    stdout_bytes: params.stdoutBytes,
    stderr_bytes: params.stderrBytes,
    stdout_lines: params.stdoutLines,
    stderr_lines: params.stderrLines,
    result_ref: finalState === "completed" ? terminalRef : null,
    error_ref: finalState === "completed" ? null : terminalRef,
  });

  try {
    await updateRoute(params.artifacts, {
      state: finalState,
    });
  } catch {
    // Preserve terminal.json as strongest terminal truth; route.json is a best-effort mirror.
  }
}
