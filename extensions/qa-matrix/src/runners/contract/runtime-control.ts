import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import {
  parseStrictPositiveInteger,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import prettyMilliseconds from "pretty-ms";
import { createLiveTransportQaRunId } from "../../shared/live-transport-artifacts.js";

export type MatrixQaGatewayChild = {
  call(
    method: string,
    params: Record<string, unknown>,
    options?: { expectFinal?: boolean; timeoutMs?: number },
  ): Promise<unknown>;
  restartAfterStateMutation?: (
    mutateState: (context: { stateDir: string }) => Promise<void>,
  ) => Promise<void>;
  restart(): Promise<void>;
  runtimeEnv?: NodeJS.ProcessEnv;
  workspaceDir: string;
};

const DEFAULT_MATRIX_QA_RUN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MATRIX_QA_CLEANUP_TIMEOUT_MS = 90_000;
const DEFAULT_MATRIX_QA_CANARY_TIMEOUT_MS = 45_000;
const MATRIX_QA_GATEWAY_STDERR_LOG = "gateway.stderr.log";
const MATRIX_QA_GATEWAY_DEBUG_MAX_LINES = 6;
const MATRIX_QA_GATEWAY_DEBUG_MAX_LINE_CHARS = 700;

function shouldWriteMatrixQaProgress() {
  return process.env.OPENCLAW_QA_MATRIX_PROGRESS !== "0";
}

export function formatMatrixQaDurationMs(durationMs: number) {
  const roundedMs = durationMs < 1000 ? Math.round(durationMs) : Math.round(durationMs / 100) * 100;
  return prettyMilliseconds(Math.max(0, roundedMs), {
    unitCount: 1,
  });
}

export function writeMatrixQaProgress(message: string) {
  if (!shouldWriteMatrixQaProgress()) {
    return;
  }
  process.stderr.write(`[matrix-qa] ${message}\n`);
}

function isMatrixQaGatewayDebugRelevantLine(line: string) {
  return /\b(?:auth|authorization|unauthorized|forbidden|missing|error|fail(?:ed|ure)?|exception|provider|api[-_ ]?key|token|denied|rejected|timeout)\b/iu.test(
    line,
  );
}

function trimMatrixQaGatewayDebugLine(line: string) {
  const redacted = redactSensitiveText(line.trim());
  return redacted.length > MATRIX_QA_GATEWAY_DEBUG_MAX_LINE_CHARS
    ? `${redacted.slice(0, MATRIX_QA_GATEWAY_DEBUG_MAX_LINE_CHARS)}...`
    : redacted;
}

function summarizeMatrixQaGatewayStderrLog(stderrText: string) {
  const lines = stderrText.split(/\r?\n/u).map(trimMatrixQaGatewayDebugLine).filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  const relevantLines = lines.filter(isMatrixQaGatewayDebugRelevantLine);
  const selectedLines = (relevantLines.length > 0 ? relevantLines : lines).slice(
    -MATRIX_QA_GATEWAY_DEBUG_MAX_LINES,
  );
  return ["gateway stderr tail:", ...selectedLines.map((line) => `- ${line}`)].join("\n");
}

export async function readMatrixQaGatewayDebugSummary(debugDirPath: string) {
  const stderrText = await fs
    .readFile(path.join(debugDirPath, MATRIX_QA_GATEWAY_STDERR_LOG), "utf8")
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    });
  return summarizeMatrixQaGatewayStderrLog(stderrText);
}

function parsePositiveMatrixQaEnvMs(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  return resolveTimerTimeoutMs(parseStrictPositiveInteger(raw), fallback);
}

export function createMatrixQaRunDeadline() {
  const timeoutMs = parsePositiveMatrixQaEnvMs(
    "OPENCLAW_QA_MATRIX_TIMEOUT_MS",
    DEFAULT_MATRIX_QA_RUN_TIMEOUT_MS,
  );
  return {
    timeoutMs,
    deadlineMs: Date.now() + timeoutMs,
  };
}

export function resolveMatrixQaCanaryTimeoutMs() {
  return parsePositiveMatrixQaEnvMs(
    "OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS",
    DEFAULT_MATRIX_QA_CANARY_TIMEOUT_MS,
  );
}

function remainingMatrixQaRunMs(
  deadline: { deadlineMs: number; timeoutMs: number },
  label: string,
) {
  const remainingMs = Math.floor(deadline.deadlineMs - Date.now());
  if (!Number.isFinite(deadline.deadlineMs) || remainingMs <= 0) {
    throw new Error(
      `${label} not started because Matrix QA run timed out after ${formatMatrixQaDurationMs(deadline.timeoutMs)}`,
    );
  }
  return remainingMs;
}

async function withMatrixQaTimeout<T>(
  label: string,
  timeoutMs: number,
  task: () => Promise<T>,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function withMatrixQaRunDeadline<T>(
  deadline: { deadlineMs: number; timeoutMs: number },
  label: string,
  task: () => Promise<T>,
) {
  return await withMatrixQaTimeout(label, remainingMatrixQaRunMs(deadline, label), task);
}

export async function cleanupMatrixQaResource(params: {
  action: () => Promise<void>;
  label: string;
  recovery?: string;
}) {
  const timeoutMs = parsePositiveMatrixQaEnvMs(
    "OPENCLAW_QA_MATRIX_CLEANUP_TIMEOUT_MS",
    DEFAULT_MATRIX_QA_CLEANUP_TIMEOUT_MS,
  );
  try {
    await withMatrixQaTimeout(params.label, timeoutMs, params.action);
  } catch (error) {
    const recovery = params.recovery ? `\nRecovery: ${params.recovery}` : "";
    throw new Error(`${formatErrorMessage(error)}${recovery}`, { cause: error });
  }
}

function isMatrixAccountReady(entry?: {
  connected?: boolean;
  healthState?: string;
  restartPending?: boolean;
  running?: boolean;
}): boolean {
  return (
    entry?.running === true &&
    entry.connected === true &&
    entry.restartPending !== true &&
    (entry.healthState === undefined || entry.healthState === "healthy")
  );
}

export async function waitForMatrixChannelReady(
  gateway: MatrixQaGatewayChild,
  accountId: string,
  opts?: {
    pollMs?: number;
    timeoutMs?: number;
  },
) {
  const pollMs = opts?.pollMs ?? 500;
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  const deadlineMs = startedAt + timeoutMs;
  let lastAccounts: unknown;
  while (Date.now() < deadlineMs) {
    const remainingMs = Math.max(1, deadlineMs - Date.now());
    const statusTimeoutMs = Math.min(5_000, remainingMs);
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: Math.min(2_000, statusTimeoutMs) },
        { timeoutMs: statusTimeoutMs },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            connected?: boolean;
            healthState?: string;
            restartPending?: boolean;
            running?: boolean;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.matrix ?? [];
      lastAccounts = accounts;
      const match = accounts.find((entry) => entry.accountId === accountId);
      if (isMatrixAccountReady(match)) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(Math.min(pollMs, Math.max(1, deadlineMs - Date.now())));
  }
  throw new Error(
    `matrix account "${accountId}" did not become ready; last matrix accounts: ${JSON.stringify(
      lastAccounts ?? [],
    )}`,
  );
}

export async function patchMatrixQaGatewayConfig(params: {
  gateway: MatrixQaGatewayChild;
  patch: Record<string, unknown>;
  replacePaths?: string[];
  restartDelayMs?: number;
}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = (await params.gateway.call("config.get", {}, { timeoutMs: 60_000 })) as {
      hash?: string;
    };
    if (!snapshot.hash) {
      throw new Error("Matrix QA config patch requires config.get hash");
    }
    try {
      await params.gateway.call(
        "config.patch",
        {
          raw: JSON.stringify(params.patch, null, 2),
          baseHash: snapshot.hash,
          ...(params.replacePaths?.length ? { replacePaths: params.replacePaths } : {}),
          restartDelayMs: params.restartDelayMs ?? 0,
        },
        { timeoutMs: 60_000 },
      );
      return;
    } catch (error) {
      if (
        attempt === 0 &&
        formatErrorMessage(error).toLowerCase().includes("config changed since last load")
      ) {
        continue;
      }
      throw error;
    }
  }
}

export function resolveMatrixQaOutputDir(params: { outputDir?: string; repoRoot: string }) {
  return (
    params.outputDir ??
    path.join(params.repoRoot, ".artifacts", "qa-e2e", `matrix-${createLiveTransportQaRunId()}`)
  );
}
