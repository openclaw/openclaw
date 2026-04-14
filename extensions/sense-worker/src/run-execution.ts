import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { notifyRunCompletion } from "./run-notify.js";
import { writeRunRecord } from "./run-store.js";
import type { RunKind, RunRecord, RunResult } from "./run-types.js";

const DEFAULT_WAIT_TIMEOUT_SEC = 180;
const DEFAULT_POLL_INTERVAL_SEC = 2;

type SenseWorkerExecutionConfig = {
  baseUrl?: string;
  token?: string;
  tokenEnv?: string;
  timeoutSec?: number;
  waitTimeoutSec?: number;
  pollIntervalSec?: number;
};

type BridgePayload = {
  sense_job_id?: string | null;
  summary?: string | null;
  key_points?: unknown;
  suggested_next_action?: string | null;
  exit_code?: number | null;
  raw_output?: string | null;
  error?: string | null;
};

type BridgeRunResult = {
  payload: BridgePayload;
  stdout: string;
  stderr: string;
  exitCode: number;
};

const BRIDGE_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/runtime/sense_runtime_manager_task.py",
);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveSenseWorkerConfig(config: OpenClawConfig | undefined): SenseWorkerExecutionConfig {
  const plugins = asRecord(config?.plugins);
  const entries = asRecord(plugins?.entries);
  const senseWorker = asRecord(entries?.["sense-worker"]);
  const pluginConfig = asRecord(senseWorker?.config);
  return {
    baseUrl: typeof pluginConfig?.baseUrl === "string" ? pluginConfig.baseUrl : undefined,
    token: typeof pluginConfig?.token === "string" ? pluginConfig.token : undefined,
    tokenEnv: typeof pluginConfig?.tokenEnv === "string" ? pluginConfig.tokenEnv : undefined,
    timeoutSec:
      typeof pluginConfig?.timeoutMs === "number"
        ? Math.max(1, pluginConfig.timeoutMs / 1000)
        : undefined,
    waitTimeoutSec: normalizeTimeout(pluginConfig?.waitTimeoutSec),
    pollIntervalSec: normalizeTimeout(pluginConfig?.pollIntervalSec),
  };
}

function buildBridgeTask(kind: RunKind): string {
  if (kind === "health") {
    return "health";
  }
  if (kind === "digest") {
    return "digest";
  }
  return "free";
}

function buildBridgeParams(record: RunRecord): Record<string, unknown> {
  if (record.kind === "digest") {
    return {
      mode: "digest_ready_probe",
      digest_ready_probe: true,
      task_type: "digest",
    };
  }
  return {
    mode: "nemoclaw_job",
    task_type: record.kind,
  };
}

function normalizeBridgeResult(payload: BridgePayload): RunResult {
  return {
    summary: typeof payload.summary === "string" && payload.summary.trim() ? payload.summary : null,
    key_points: Array.isArray(payload.key_points)
      ? payload.key_points.filter((item): item is string => typeof item === "string")
      : [],
    suggested_next_action:
      typeof payload.suggested_next_action === "string" && payload.suggested_next_action.trim()
        ? payload.suggested_next_action
        : null,
    exit_code: typeof payload.exit_code === "number" ? payload.exit_code : null,
    raw_output:
      typeof payload.raw_output === "string" && payload.raw_output.length > 0
        ? payload.raw_output
        : null,
  };
}

function buildRunError(params: {
  message: string;
  stderr?: string;
  stdout?: string;
}): NonNullable<RunRecord["error"]> {
  const detail = [params.stderr?.trim(), params.stdout?.trim()].filter(Boolean).join("\n\n");
  return {
    message: params.message,
    detail: detail || null,
  };
}

export function buildSenseManagerTaskInvocation(
  record: RunRecord,
  config: SenseWorkerExecutionConfig = {},
): { command: string; args: string[] } {
  const args = [
    BRIDGE_SCRIPT_PATH,
    "--task",
    buildBridgeTask(record.kind),
    "--input",
    record.raw_text,
    "--params-json",
    JSON.stringify(buildBridgeParams(record)),
  ];
  if (typeof config.baseUrl === "string" && config.baseUrl.trim()) {
    args.push("--base-url", config.baseUrl.trim());
  }
  if (typeof config.token === "string" && config.token.trim()) {
    args.push("--token", config.token.trim());
  }
  if (typeof config.tokenEnv === "string" && config.tokenEnv.trim()) {
    args.push("--token-env", config.tokenEnv.trim());
  }
  if (
    typeof config.timeoutSec === "number" &&
    Number.isFinite(config.timeoutSec) &&
    config.timeoutSec > 0
  ) {
    args.push("--timeout", String(config.timeoutSec));
  }
  const waitTimeoutSec = config.waitTimeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC;
  args.push("--wait-timeout", String(waitTimeoutSec));
  const pollIntervalSec = config.pollIntervalSec ?? DEFAULT_POLL_INTERVAL_SEC;
  args.push("--poll-interval", String(pollIntervalSec));
  return {
    command: "python3",
    args,
  };
}

export async function invokeSenseManagerTask(
  record: RunRecord,
  config: SenseWorkerExecutionConfig = {},
): Promise<BridgeRunResult> {
  const invocation = buildSenseManagerTaskInvocation(record, config);
  return await new Promise<BridgeRunResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (exitCode) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(
          new Error(
            `Sense manager task returned no JSON output${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      try {
        const payload = JSON.parse(trimmed) as BridgePayload;
        resolve({
          payload,
          stdout,
          stderr,
          exitCode: typeof exitCode === "number" ? exitCode : 1,
        });
      } catch (error) {
        reject(
          new Error(
            `Sense manager task returned invalid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });
  });
}

export async function executeQueuedRun(
  record: RunRecord,
  params: {
    config?: OpenClawConfig;
    now?: () => Date;
    writeRecord?: typeof writeRunRecord;
    runBridge?: typeof invokeSenseManagerTask;
    notify?: typeof notifyRunCompletion;
  } = {},
): Promise<RunRecord> {
  const writeRecord = params.writeRecord ?? writeRunRecord;
  const runBridge = params.runBridge ?? invokeSenseManagerTask;
  const notify = params.notify ?? notifyRunCompletion;
  const now = params.now ?? (() => new Date());

  const runningRecord: RunRecord = {
    ...record,
    status: "running",
    started_at: now().toISOString(),
  };
  await writeRecord(runningRecord);

  try {
    const bridgeResult = await runBridge(runningRecord, resolveSenseWorkerConfig(params.config));
    const runResult = normalizeBridgeResult(bridgeResult.payload);
    const failed =
      bridgeResult.exitCode !== 0 ||
      (typeof bridgeResult.payload.exit_code === "number" &&
        bridgeResult.payload.exit_code !== 0) ||
      (typeof bridgeResult.payload.error === "string" &&
        bridgeResult.payload.error.trim().length > 0);

    const completedRecord: RunRecord = {
      ...runningRecord,
      status: failed ? "failed" : "done",
      sense_job_id:
        typeof bridgeResult.payload.sense_job_id === "string" &&
        bridgeResult.payload.sense_job_id.trim()
          ? bridgeResult.payload.sense_job_id
          : runningRecord.sense_job_id,
      done_at: now().toISOString(),
      result: runResult,
      error: failed
        ? buildRunError({
            message:
              typeof bridgeResult.payload.error === "string" && bridgeResult.payload.error.trim()
                ? bridgeResult.payload.error
                : "Sense worker run failed",
            stderr: bridgeResult.stderr,
            stdout: bridgeResult.stdout,
          })
        : null,
    };
    await writeRecord(completedRecord);
    try {
      await notify({ record: completedRecord, config: params.config });
    } catch {}
    return completedRecord;
  } catch (error) {
    const failedRecord: RunRecord = {
      ...runningRecord,
      status: "failed",
      done_at: now().toISOString(),
      error: buildRunError({
        message: error instanceof Error ? error.message : String(error),
      }),
    };
    await writeRecord(failedRecord);
    try {
      await notify({ record: failedRecord, config: params.config });
    } catch {}
    return failedRecord;
  }
}
