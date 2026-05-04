import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  validateRenderedCoordinationCommand,
  type CoordinationRenderedCommand,
} from "./command-contract.js";
import type { CoordinationJobContract } from "./job-contract.js";

export type CoordinationSafeProbeExecutionAdapterResult = {
  status: "completed" | "failed" | "timed_out" | "blocked";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  parsedOutputSource: "stdout" | "stderr" | "file" | "none" | "conflict";
  safeProbeSummary: string | Record<string, unknown>;
  wrapperTimeoutMs?: number;
  adapterTimeoutMs?: number;
  adapterGraceMs?: number;
  wrapperSpawned?: boolean;
  innerOpenClawSpawned?: boolean;
  wrapperCompletedBeforeAdapterKill?: boolean;
  adapterKilledWrapperAfterGrace?: boolean;
  durableResultState?: "final" | "placeholder" | "missing" | "malformed" | "job_id_mismatch";
  artifactEvidence?: {
    job_json?: boolean;
    job_local_debug?: boolean;
    fallback_debug?: boolean;
    safe_probe_result?: boolean;
    agent_status_json?: boolean;
    agent_proof_json?: boolean;
    stdout_file?: boolean | "optional_not_produced";
    stderr_file?: boolean | "optional_not_produced";
  };
  debugEvents?: unknown[];
  cleanupEvidence?: Record<string, unknown>;
  innerDebugEvidenceFound?: boolean;
  proofAttemptId?: string;
};

export type CoordinationSafeProbeSpawn = typeof spawn;

export async function executeCoordinationSafeProbe(
  validatedJob: CoordinationJobContract,
  renderedCommand: CoordinationRenderedCommand,
  options?: {
    spawnImpl?: CoordinationSafeProbeSpawn;
    now?: () => number;
  },
): Promise<CoordinationSafeProbeExecutionAdapterResult> {
  const validatedRenderedCommand = validateRenderedCoordinationCommand(
    renderedCommand,
    validatedJob,
  );
  const spawnImpl = options?.spawnImpl ?? spawn;
  const now = options?.now ?? Date.now;
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const wrapperTimeoutMs = Math.max(1, validatedJob.timeout_seconds * 1000);
  const adapterGraceMs = 5000;
  const timeoutMs = wrapperTimeoutMs + adapterGraceMs;

  return new Promise<CoordinationSafeProbeExecutionAdapterResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(validatedRenderedCommand.command, validatedRenderedCommand.args, {
        cwd: validatedRenderedCommand.cwd,
        env: {
          ...validatedRenderedCommand.env,
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      const finishedMs = now();
      const stderr = error instanceof Error ? error.message : String(error);
      resolve({
        status: "failed",
        started_at: startedAt,
        finished_at: new Date(finishedMs).toISOString(),
        duration_ms: Math.max(0, finishedMs - startedMs),
        exitCode: null,
        signal: null,
        stdout: "",
        stderr,
        stdoutExcerpt: "",
        stderrExcerpt: toExcerpt(stderr),
        parsedOutputSource: "none",
        safeProbeSummary: `spawn_failed:${stderr}`,
        wrapperTimeoutMs,
        adapterTimeoutMs: timeoutMs,
        adapterGraceMs,
        wrapperCompletedBeforeAdapterKill: false,
        adapterKilledWrapperAfterGrace: false,
        durableResultState: "missing",
      });
      return;
    }

    let resolved = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const finalize = (params: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      statusOverride?: CoordinationSafeProbeExecutionAdapterResult["status"];
      safeProbeSummary?: string | Record<string, unknown>;
    }) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timer);

      const finishedMs = now();
      const finishedAt = new Date(finishedMs).toISOString();
      const parsed = parseSafeProbeOutput(stdout, stderr);
      const derivedStatus = parsed.conflict
        ? "blocked"
        : (params.statusOverride ??
          deriveStatusFromExit(
            params.exitCode,
            parsed.parsedJson !== undefined,
            params.signal,
            timedOut,
          ));

      void resolveFromArtifacts({
        validatedJob,
        parsed,
        params,
        startedAt,
        finishedAt,
        startedMs,
        finishedMs,
        stdout,
        stderr,
        derivedStatus,
      })
        .then((result) => {
          resolve(result);
        })
        .catch((error) => {
          resolve({
            status: "blocked",
            started_at: startedAt,
            finished_at: finishedAt,
            duration_ms: Math.max(0, finishedMs - startedMs),
            exitCode: params.exitCode,
            signal: params.signal,
            stdout,
            stderr,
            stdoutExcerpt: toExcerpt(stdout),
            stderrExcerpt: toExcerpt(stderr),
            parsedOutputSource: parsed.source,
            safeProbeSummary: `artifact_resolution_failed:${error instanceof Error ? error.message : String(error)}`,
            wrapperTimeoutMs,
            adapterTimeoutMs: timeoutMs,
            adapterGraceMs,
            wrapperCompletedBeforeAdapterKill: params.signal !== "SIGTERM" || !timedOut,
            adapterKilledWrapperAfterGrace: timedOut,
            durableResultState: "missing",
          });
        });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finalize({
        exitCode: null,
        signal: null,
        statusOverride: "failed",
        safeProbeSummary: `spawn_runtime_error:${error.message}`,
      });
    });

    child.on("close", (exitCode, signal) => {
      finalize({
        exitCode,
        signal,
        statusOverride: timedOut ? "timed_out" : undefined,
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildProcessGroup(child);
    }, timeoutMs);
  });
}

function deriveStatusFromExit(
  exitCode: number | null,
  hasParsedJson: boolean,
  signal: NodeJS.Signals | null,
  timedOut = false,
): CoordinationSafeProbeExecutionAdapterResult["status"] {
  if (timedOut || exitCode === 124 || signal === "SIGTERM" || signal === "SIGKILL") {
    return "timed_out";
  }
  if (exitCode === 0) {
    return hasParsedJson ? "completed" : "blocked";
  }
  return "failed";
}

function parseCandidateJson(
  text: string,
  emptyCode: string,
  parsePrefix: string,
): {
  parsedJson?: Record<string, unknown>;
  parseError?: string;
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { parseError: emptyCode };
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { parsedJson: parsed as Record<string, unknown> };
    }
    return { parseError: `${parsePrefix}_json_not_object` };
  } catch (error) {
    return {
      parseError:
        error instanceof Error
          ? `${parsePrefix}_parse_error:${error.message}`
          : `${parsePrefix}_parse_error:unknown`,
    };
  }
}

function parseSafeProbeOutput(
  stdout: string,
  stderr: string,
): {
  parsedJson?: Record<string, unknown>;
  parseError?: string;
  conflict?: boolean;
  source: "stdout" | "stderr" | "file" | "none" | "conflict";
} {
  const stdoutResult = parseCandidateJson(stdout, "safe_probe_stdout_empty", "safe_probe_stdout");
  if (stdoutResult.parsedJson) {
    const stderrResult = parseCandidateJson(stderr, "safe_probe_stderr_empty", "safe_probe_stderr");
    if (
      stderrResult.parsedJson &&
      JSON.stringify(stderrResult.parsedJson) !== JSON.stringify(stdoutResult.parsedJson)
    ) {
      return {
        parseError: "safe_probe_output_conflicting_json",
        conflict: true,
        source: "conflict",
      };
    }
    return { ...stdoutResult, source: "stdout" };
  }

  if (stdout.trim().length === 0) {
    const stderrResult = parseCandidateJson(stderr, "safe_probe_stderr_empty", "safe_probe_stderr");
    if (stderrResult.parsedJson) {
      return { ...stderrResult, source: "stderr" };
    }
  }

  return { ...stdoutResult, source: "none" };
}

function toExcerpt(text: string, maxLength = 400): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function extractArtifactEvidence(
  parsed: Record<string, unknown> | undefined,
): CoordinationSafeProbeExecutionAdapterResult["artifactEvidence"] | undefined {
  const candidate = parsed?.artifactEvidence;
  if (!isPlainObject(candidate)) {
    return undefined;
  }
  return {
    job_json: candidate.job_json === true,
    job_local_debug: candidate.job_local_debug === true,
    fallback_debug: candidate.fallback_debug === true,
    safe_probe_result: candidate.safe_probe_result === true,
    agent_status_json: candidate.agent_status_json === true,
    agent_proof_json: candidate.agent_proof_json === true,
    stdout_file:
      candidate.stdout_file === true
        ? true
        : candidate.stdout_file === "optional_not_produced"
          ? "optional_not_produced"
          : false,
    stderr_file:
      candidate.stderr_file === true
        ? true
        : candidate.stderr_file === "optional_not_produced"
          ? "optional_not_produced"
          : false,
  };
}

async function resolveFromArtifacts(params: {
  validatedJob: CoordinationJobContract;
  parsed: {
    parsedJson?: Record<string, unknown>;
    parseError?: string;
    source: "stdout" | "stderr" | "file" | "none" | "conflict";
    conflict?: boolean;
  };
  params: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    statusOverride?: CoordinationSafeProbeExecutionAdapterResult["status"];
    safeProbeSummary?: string | Record<string, unknown>;
  };
  startedAt: string;
  finishedAt: string;
  startedMs: number;
  finishedMs: number;
  stdout: string;
  stderr: string;
  derivedStatus: CoordinationSafeProbeExecutionAdapterResult["status"];
}): Promise<CoordinationSafeProbeExecutionAdapterResult> {
  const { validatedJob, parsed, stdout, stderr, startedAt, finishedAt, startedMs, finishedMs } =
    params;
  const jobPath = validatedJob.approval_scope.job_path;
  const jobDir = path.dirname(jobPath);
  const debugPath = path.join(jobDir, ".agent-exec-debug.jsonl");
  const safeProbeResultPath = path.join(jobDir, "safe-probe-result.json");

  const durableResult = parsed.parsedJson
    ? undefined
    : await readSafeProbeResultFile(safeProbeResultPath, validatedJob.id);
  const effectiveParsed = durableResult?.parsedJson
    ? { ...parsed, parsedJson: durableResult.parsedJson, source: "file" as const }
    : parsed;

  const parsedArtifactEvidence = extractArtifactEvidence(effectiveParsed.parsedJson) ?? {};
  const debugEvents =
    extractDebugEvents(effectiveParsed.parsedJson) ?? (await readDebugEvents(debugPath));
  const jobJsonExists = await pathExists(jobPath);
  const debugExists = await pathExists(debugPath);
  const inferredProofAttemptId = inferProofAttemptId(debugEvents);
  const wrapperSpawned =
    params.params.exitCode !== null || stdout.length > 0 || stderr.length > 0 || debugExists;
  const innerOpenClawSpawned = Array.isArray(debugEvents) && debugEvents.length > 0;

  const durableResultState =
    durableResult?.state ??
    (effectiveParsed.parsedJson
      ? "final"
      : await classifyDurableResultAbsence(safeProbeResultPath));
  const finalDurableResult = durableResultState === "final";

  return {
    status: params.derivedStatus,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, finishedMs - startedMs),
    exitCode: params.params.exitCode,
    signal: params.params.signal,
    stdout,
    stderr,
    stdoutExcerpt: toExcerpt(stdout),
    stderrExcerpt: toExcerpt(stderr),
    parsedOutputSource: effectiveParsed.source,
    proofAttemptId: inferredProofAttemptId,
    wrapperSpawned,
    innerOpenClawSpawned,
    innerDebugEvidenceFound: debugExists && innerOpenClawSpawned,
    safeProbeSummary:
      params.params.safeProbeSummary ??
      effectiveParsed.parsedJson ??
      effectiveParsed.parseError ??
      (debugExists ? "safe_probe_stdout_empty_job_debug_present" : "safe_probe_output_missing"),
    wrapperTimeoutMs: Math.max(1, validatedJob.timeout_seconds * 1000),
    adapterTimeoutMs: Math.max(1, validatedJob.timeout_seconds * 1000) + 5000,
    adapterGraceMs: 5000,
    wrapperCompletedBeforeAdapterKill: !(
      params.params.signal === "SIGTERM" && params.derivedStatus === "timed_out"
    ),
    adapterKilledWrapperAfterGrace:
      params.params.signal === "SIGTERM" && params.derivedStatus === "timed_out",
    durableResultState,
    artifactEvidence: {
      job_json:
        parsedArtifactEvidence.job_json === true ||
        (parsedArtifactEvidence.job_json !== false && jobJsonExists),
      job_local_debug: parsedArtifactEvidence.job_local_debug === true || debugExists,
      fallback_debug: parsedArtifactEvidence.fallback_debug === true,
      safe_probe_result:
        finalDurableResult &&
        (parsedArtifactEvidence.safe_probe_result === true ||
          (parsedArtifactEvidence.safe_probe_result !== false &&
            effectiveParsed.parsedJson !== undefined)),
      agent_status_json: parsedArtifactEvidence.agent_status_json === true,
      agent_proof_json: parsedArtifactEvidence.agent_proof_json === true,
      stdout_file: parsedArtifactEvidence.stdout_file ?? "optional_not_produced",
      stderr_file: parsedArtifactEvidence.stderr_file ?? "optional_not_produced",
    },
    debugEvents,
    cleanupEvidence: finalDurableResult
      ? extractCleanupEvidence(effectiveParsed.parsedJson)
      : undefined,
  };
}

async function readSafeProbeResultFile(
  resultPath: string,
  expectedJobId: string,
): Promise<
  | {
      parsedJson?: Record<string, unknown>;
      state: "final" | "placeholder" | "missing" | "malformed" | "job_id_mismatch";
    }
  | undefined
> {
  try {
    const raw = await fs.readFile(resultPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isPlainObject(parsed)) {
      return { state: "malformed" };
    }
    if (parsed.job_id !== expectedJobId) {
      return { state: "job_id_mismatch" };
    }
    if (parsed.final !== true || parsed.result_complete !== true) {
      return { parsedJson: parsed, state: "placeholder" };
    }
    return { parsedJson: parsed, state: "final" };
  } catch {
    return undefined;
  }
}

async function classifyDurableResultAbsence(resultPath: string): Promise<"missing" | "malformed"> {
  try {
    await fs.stat(resultPath);
    return "malformed";
  } catch {
    return "missing";
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readDebugEvents(debugPath: string): Promise<unknown[] | undefined> {
  try {
    const text = await fs.readFile(debugPath, "utf8");
    const events = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((value): value is Record<string, unknown> => value !== undefined);
    return events.length > 0 ? events : undefined;
  } catch {
    return undefined;
  }
}

function inferProofAttemptId(debugEvents: unknown[] | undefined): string | undefined {
  if (!Array.isArray(debugEvents)) {
    return undefined;
  }
  for (const entry of debugEvents) {
    if (
      isPlainObject(entry) &&
      typeof entry.proof_attempt_id === "string" &&
      entry.proof_attempt_id.length > 0
    ) {
      return entry.proof_attempt_id;
    }
  }
  return undefined;
}

function extractDebugEvents(parsed: Record<string, unknown> | undefined): unknown[] | undefined {
  const candidate = parsed?.debugEvents;
  return Array.isArray(candidate) ? candidate : undefined;
}

function extractCleanupEvidence(
  parsed: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const candidate = parsed?.cleanupEvidence;
  if (isPlainObject(candidate)) {
    return candidate;
  }
  return mapFlatSafeProbeCleanupEvidence(parsed);
}

function mapFlatSafeProbeCleanupEvidence(
  parsed: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!isPlainObject(parsed) || parsed.final !== true || parsed.result_complete !== true) {
    return undefined;
  }

  const hasFlatCleanupSignal =
    "lock_exists_after_run" in parsed ||
    "remaining_processes" in parsed ||
    "remaining_openclaw_processes" in parsed;

  if (!hasFlatCleanupSignal) {
    return undefined;
  }

  const remainingOpenClawProcesses = Array.isArray(parsed.remaining_openclaw_processes)
    ? parsed.remaining_openclaw_processes
    : [];
  const remainingProcesses = Array.isArray(parsed.remaining_processes)
    ? parsed.remaining_processes
    : [];

  const mappedObserved = remainingProcesses
    .map((proc) => mapObservedProcess(proc))
    .filter((value): value is Record<string, unknown> => value !== undefined);

  const mappedDescendants = remainingOpenClawProcesses
    .map((proc) => mapRemainingDescendant(proc))
    .filter((value): value is Record<string, unknown> => value !== undefined);

  return {
    lock: {
      existsAfterRun: parsed.lock_exists_after_run === true,
      path: typeof parsed.lock_path === "string" ? parsed.lock_path : undefined,
      details:
        typeof parsed.stale_lock_removal_reason === "string"
          ? parsed.stale_lock_removal_reason
          : undefined,
    },
    processLineage: {
      safeProbePid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      processGroupId:
        typeof parsed.process_group_id === "number" ? parsed.process_group_id : undefined,
      remainingDescendants: mappedDescendants,
    },
    observedProcesses: mappedObserved,
  };
}

function mapRemainingDescendant(proc: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(proc) || typeof proc.pid !== "number") {
    return undefined;
  }
  return {
    pid: proc.pid,
    ppid: typeof proc.ppid === "number" ? proc.ppid : undefined,
    command: typeof proc.command === "string" ? proc.command : undefined,
    args: [],
    lineageTiedToProof: false,
  };
}

function mapObservedProcess(proc: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(proc) || typeof proc.pid !== "number") {
    return undefined;
  }
  return {
    pid: proc.pid,
    ppid: typeof proc.ppid === "number" ? proc.ppid : undefined,
    command: typeof proc.command === "string" ? proc.command : undefined,
    args: [],
    type: inferObservedProcessType(typeof proc.command === "string" ? proc.command : undefined),
    lineageTiedToProof: false,
  };
}

function inferObservedProcessType(command: string | undefined): string {
  if (!command) {
    return "unknown";
  }
  const normalized = command.toLowerCase();
  if (normalized.includes("zapier")) {
    return "zapier";
  }
  if (normalized.includes("mcp-remote") || normalized.includes("mcp_remote")) {
    return "mcp_remote";
  }
  if (normalized.includes("slack")) {
    return normalized.includes("slack.app") || normalized.includes("slack desktop")
      ? "slack_desktop"
      : "slack_runtime";
  }
  if (
    normalized.includes("openclaw") ||
    normalized.includes("agent-exec") ||
    normalized.includes("safe-probe")
  ) {
    return "openclaw";
  }
  return "unknown";
}

function terminateChildProcessGroup(child: ChildProcess): void {
  if (typeof child.pid !== "number") {
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // best effort only
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
