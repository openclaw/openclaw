import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type SenseClientConfig = {
  baseUrl?: string;
  timeoutMs?: number;
  token?: string;
  tokenEnv?: string;
  logger?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
};

const execFileAsync = promisify(execFile);

export type SenseExecutePayload = {
  task: string;
  input: string;
  params: Record<string, unknown>;
};

export type SenseCallResult = {
  ok: boolean;
  status: number;
  url: string;
  body: unknown;
};

export type SenseJobEnvelope = {
  job_id?: string;
  status?: string;
  stage?: string;
  target?: string;
  message?: string;
};

export type SenseRecentJobRef = {
  jobId: string;
  source: "completed" | "picked";
};

export type NemoClawGpuStatus = {
  runner: "up" | "down" | "unknown";
  worker: string;
  workerHealth: "up" | "down" | "unknown";
  model?: string;
  gpu: "busy" | "idle" | "unknown" | "unavailable";
};

const DEFAULT_BASE_URL = "http://192.168.11.11:8787";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TOKEN_ENV = "SENSE_WORKER_TOKEN";
const DEFAULT_RECENT_JOB_LIMIT = 3;
const DEFAULT_RECENT_JOB_JOURNAL_LINES = 4000;
const RUNNER_SYSTEMD_UNIT = "openclaw-nemoclaw-runner.service";
const JOB_ID_PATTERN =
  /\b(completed|picked)\s+job_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const RUNNER_ACTIVITY_PATTERN = /\b(picked\s+job_id=|completed\s+job_id=|no queued jobs)\b/i;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function buildUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlash(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

function normalizeJobEnvelope(body: unknown): SenseJobEnvelope | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (record.error === "job_not_found") {
    return {
      job_id: typeof record.job_id === "string" ? record.job_id : undefined,
      status: "job_not_found",
    };
  }
  const result = record.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const resultRecord = result as Record<string, unknown>;
  if (typeof resultRecord.job_id !== "string") {
    return undefined;
  }
  return {
    job_id: resultRecord.job_id,
    status:
      typeof resultRecord.status === "string"
        ? resultRecord.status
        : typeof record.status === "string"
          ? record.status
          : undefined,
    stage: typeof resultRecord.stage === "string" ? resultRecord.stage : undefined,
    target: typeof resultRecord.target === "string" ? resultRecord.target : undefined,
    message: typeof resultRecord.message === "string" ? resultRecord.message : undefined,
  };
}

async function fetchJson(params: {
  method: "GET" | "POST";
  url: string;
  timeoutMs: number;
  token?: string;
  body?: unknown;
  logger?: SenseClientConfig["logger"];
}): Promise<SenseCallResult & { job?: SenseJobEnvelope }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(100, params.timeoutMs));
  const startedAt = Date.now();
  try {
    params.logger?.info?.(
      `[sense-worker] request method=${params.method} url=${params.url} body=${params.body ? "yes" : "no"}`,
    );
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (params.body) {
      headers["Content-Type"] = "application/json";
    }
    if (params.token) {
      headers["X-Sense-Worker-Token"] = params.token;
    }
    const response = await fetch(params.url, {
      method: params.method,
      headers,
      body: params.body ? JSON.stringify(params.body) : undefined,
      signal: ctrl.signal,
    });
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(`Sense worker returned invalid JSON (status ${response.status})`);
    }
    const elapsedMs = Date.now() - startedAt;
    params.logger?.info?.(
      `[sense-worker] response method=${params.method} status=${response.status} elapsed_ms=${elapsedMs}`,
    );
    const result = {
      ok: response.ok,
      status: response.status,
      url: params.url,
      body: parsed,
    };
    const job = normalizeJobEnvelope(parsed);
    return job ? { ...result, job } : result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.name === "AbortError") {
      params.logger?.warn?.(
        `[sense-worker] timeout method=${params.method} url=${params.url} timeout_ms=${params.timeoutMs}`,
      );
      throw new Error(`Sense worker request timed out after ${params.timeoutMs}ms`);
    }
    params.logger?.error?.(
      `[sense-worker] request failed method=${params.method} url=${params.url}: ${message}`,
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function resolveToken(config: SenseClientConfig): string | undefined {
  if (typeof config.token === "string" && config.token.trim()) {
    return config.token.trim();
  }
  const envName =
    typeof config.tokenEnv === "string" && config.tokenEnv.trim()
      ? config.tokenEnv.trim()
      : DEFAULT_TOKEN_ENV;
  const value = process.env[envName];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function checkSenseHealth(config: SenseClientConfig = {}): Promise<SenseCallResult> {
  const baseUrl = config.baseUrl?.trim() || DEFAULT_BASE_URL;
  return await fetchJson({
    method: "GET",
    url: buildUrl(baseUrl, "/health"),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    token: resolveToken(config),
    logger: config.logger,
  });
}

export async function callSense(
  task: string,
  input: string,
  params: Record<string, unknown> = {},
  config: SenseClientConfig = {},
): Promise<SenseCallResult> {
  if (!task.trim()) {
    throw new Error("task required");
  }
  const baseUrl = config.baseUrl?.trim() || DEFAULT_BASE_URL;
  const payload: SenseExecutePayload = {
    task: task.trim(),
    input,
    params,
  };
  return await fetchJson({
    method: "POST",
    url: buildUrl(baseUrl, "/execute"),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    token: resolveToken(config),
    body: payload,
    logger: config.logger,
  });
}

export async function getSenseJobStatus(
  jobId: string,
  config: SenseClientConfig = {},
): Promise<SenseCallResult & { job?: SenseJobEnvelope }> {
  const trimmedJobId = jobId.trim();
  if (!trimmedJobId) {
    throw new Error("jobId required");
  }
  const baseUrl = config.baseUrl?.trim() || DEFAULT_BASE_URL;
  return await fetchJson({
    method: "GET",
    url: buildUrl(baseUrl, `/jobs/${encodeURIComponent(trimmedJobId)}`),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    token: resolveToken(config),
    logger: config.logger,
  });
}

export async function getRecentSenseJobRefs(
  limit = DEFAULT_RECENT_JOB_LIMIT,
): Promise<SenseRecentJobRef[]> {
  const normalizedLimit = Math.max(1, Math.min(10, Math.trunc(limit || DEFAULT_RECENT_JOB_LIMIT)));
  try {
    const { stdout } = await execFileAsync(
      "journalctl",
      [
        "--user",
        "-u",
        RUNNER_SYSTEMD_UNIT,
        "-n",
        String(DEFAULT_RECENT_JOB_JOURNAL_LINES),
        "--no-pager",
        "-o",
        "cat",
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    const refs: SenseRecentJobRef[] = [];
    const seen = new Set<string>();
    const lines = stdout.split(/\r?\n/).reverse();
    for (const line of lines) {
      const match = JOB_ID_PATTERN.exec(line);
      if (!match) {
        continue;
      }
      const source = match[1].toLowerCase() === "completed" ? "completed" : "picked";
      const jobId = match[2];
      if (seen.has(jobId)) {
        continue;
      }
      seen.add(jobId);
      refs.push({ jobId, source });
      if (refs.length >= normalizedLimit) {
        break;
      }
    }
    return refs;
  } catch {
    return [];
  }
}

function parseSystemdEnvironment(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  const line = stdout.trim();
  if (!line) {
    return values;
  }
  for (const token of line.split(/\s+/)) {
    const idx = token.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    values[token.slice(0, idx)] = token.slice(idx + 1);
  }
  return values;
}

function resolveGpuStateFromJournal(stdout: string): NemoClawGpuStatus["gpu"] {
  const lines = stdout.split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!RUNNER_ACTIVITY_PATTERN.test(line)) {
      continue;
    }
    if (line.includes("picked job_id=")) {
      return "busy";
    }
    if (line.includes("completed job_id=") || line.includes("no queued jobs")) {
      return "idle";
    }
  }
  return "unknown";
}

export async function getNemoClawGpuStatus(
  config: SenseClientConfig = {},
): Promise<NemoClawGpuStatus> {
  const worker = config.baseUrl?.trim() || DEFAULT_BASE_URL;
  let runner: NemoClawGpuStatus["runner"] = "unknown";
  let model: string | undefined;
  let gpu: NemoClawGpuStatus["gpu"] = "unknown";

  try {
    const [serviceState, envState, journalState, healthState] = await Promise.allSettled([
      execFileAsync(
        "systemctl",
        ["--user", "is-active", RUNNER_SYSTEMD_UNIT],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      ),
      execFileAsync(
        "systemctl",
        ["--user", "show", RUNNER_SYSTEMD_UNIT, "--property=Environment", "--value"],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      ),
      execFileAsync(
        "journalctl",
        ["--user", "-u", RUNNER_SYSTEMD_UNIT, "-n", "50", "--no-pager", "-o", "cat"],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      ),
      checkSenseHealth(config),
    ]);

    if (serviceState.status === "fulfilled") {
      const state = serviceState.value.stdout.trim();
      runner = state === "active" ? "up" : state ? "down" : "unknown";
    } else {
      runner = "unknown";
    }

    if (envState.status === "fulfilled") {
      const env = parseSystemdEnvironment(envState.value.stdout);
      model = env.OLLAMA_MODEL || undefined;
    }

    if (journalState.status === "fulfilled") {
      gpu = resolveGpuStateFromJournal(journalState.value.stdout);
    }

    const workerHealth =
      healthState.status === "fulfilled"
        ? healthState.value.ok
          ? "up"
          : "down"
        : "down";

    return {
      runner,
      worker,
      workerHealth,
      model,
      gpu: runner === "down" && workerHealth === "down" ? "unavailable" : gpu,
    };
  } catch {
    return {
      runner: "unknown",
      worker,
      workerHealth: "unknown",
      gpu: "unavailable",
    };
  }
}

export const __testing = {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOKEN_ENV,
  DEFAULT_RECENT_JOB_LIMIT,
  RUNNER_SYSTEMD_UNIT,
  resolveToken,
  normalizeJobEnvelope,
  parseSystemdEnvironment,
  resolveGpuStateFromJournal,
};
