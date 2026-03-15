import { spawn } from "node:child_process";
import type { PluginLogger } from "openclaw/plugin-sdk/byterover";

// ---------------------------------------------------------------------------
// Types — brv CLI JSON output shapes
// ---------------------------------------------------------------------------

/** Wrapper envelope for all brv --format json responses. */
export type BrvJsonResponse<T = unknown> = {
  command: string;
  success: boolean;
  timestamp: string;
  data: T;
};

export type BrvCurateResult = {
  status: "completed" | "queued" | "error";
  event?: string;
  message?: string;
  taskId?: string;
  logId?: string;
  changes?: {
    created?: string[];
    updated?: string[];
  };
  error?: string;
};

export type BrvQueryResult = {
  status: "completed" | "error";
  event?: string;
  taskId?: string;
  result?: string;
  content?: string;
  message?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type BrvProcessConfig = {
  /** Path to the brv binary. Defaults to "brv". */
  brvPath?: string;
  /** Working directory for brv commands. Defaults to process.cwd(). */
  cwd?: string;
  /** Timeout for query calls in ms. Defaults to 12_000. */
  queryTimeoutMs?: number;
  /** Timeout for curate calls in ms. Defaults to 60_000. */
  curateTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Core spawning utility
// ---------------------------------------------------------------------------

function runBrv(params: {
  brvPath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  logger: PluginLogger;
  signal?: AbortSignal;
  maxOutputChars?: number;
}): Promise<{ stdout: string; stderr: string }> {
  const maxOutput = params.maxOutputChars ?? 512_000;

  params.logger.debug?.(
    `spawn: ${params.brvPath} ${params.args.join(" ")} (cwd=${params.cwd}, timeout=${params.timeoutMs}ms)`,
  );

  return new Promise((resolve, reject) => {
    let settled = false;

    function settle(
      outcome: "resolve" | "reject",
      value: { stdout: string; stderr: string } | Error,
    ) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome === "resolve") {
        resolve(value as { stdout: string; stderr: string });
      } else {
        reject(value);
      }
    }

    const child = spawn(params.brvPath, params.args, {
      cwd: params.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle("reject", new Error(`brv ${params.args[0]} timed out after ${params.timeoutMs}ms`));
    }, params.timeoutMs);

    // External cancellation via AbortSignal (used by assemble deadline)
    if (params.signal) {
      if (params.signal.aborted) {
        child.kill("SIGKILL");
        settle("reject", new Error(`brv ${params.args[0]} aborted`));
      } else {
        params.signal.addEventListener(
          "abort",
          () => {
            child.kill("SIGKILL");
            settle("reject", new Error(`brv ${params.args[0]} aborted`));
          },
          { once: true },
        );
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > maxOutput) {
        child.kill("SIGKILL");
        settle("reject", new Error(`brv ${params.args[0]} output exceeded ${maxOutput} chars`));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > maxOutput) {
        stderr = stderr.slice(0, maxOutput) + "\n[stderr truncated]";
      }
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        settle(
          "reject",
          new Error(
            `ByteRover CLI not found at "${params.brvPath}". ` +
              `Install it (https://www.byterover.dev) or set brvPath in plugin config.`,
          ),
        );
        return;
      }
      params.logger.warn(`spawn error: ${err.message}`);
      settle("reject", err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        params.logger.debug?.(
          `exit 0 (stdout=${stdout.length} chars, stderr=${stderr.length} chars)`,
        );
        settle("resolve", { stdout, stderr });
      } else {
        const errMsg = `brv ${params.args[0]} failed (exit ${code}): ${stderr || stdout}`;
        params.logger.warn(errMsg);
        settle("reject", new Error(errMsg));
      }
    });
  });
}

/**
 * Parse the last complete JSON object from brv's newline-delimited JSON output.
 * brv streams events as NDJSON; the final line with `status: "completed"` is the result.
 */
export function parseLastJsonLine<T>(stdout: string): BrvJsonResponse<T> {
  const lines = stdout.trim().split("\n").filter(Boolean);
  // Walk backwards to find the final completed result
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as BrvJsonResponse<T>;
      return parsed;
    } catch {
      // Skip non-JSON lines (shouldn't happen with --format json, but be safe)
    }
  }
  throw new Error("No valid JSON in brv output");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `brv curate` with the given context text.
 * Uses --detach for fire-and-forget (non-blocking) curation.
 */
export async function brvCurate(params: {
  config: BrvProcessConfig;
  logger: PluginLogger;
  context: string;
  files?: string[];
  detach?: boolean;
}): Promise<BrvJsonResponse<BrvCurateResult>> {
  const brvPath = params.config.brvPath ?? "brv";
  const cwd = params.config.cwd ?? process.cwd();
  const timeoutMs = params.config.curateTimeoutMs ?? 60_000;

  const args = ["curate", "--format", "json"];
  if (params.detach) {
    args.push("--detach");
  }
  if (params.files) {
    for (const f of params.files) {
      args.push("-f", f);
    }
  }
  // "--" terminates flags so user text starting with "-" isn't parsed as a brv option
  args.push("--", params.context);

  const { stdout } = await runBrv({ brvPath, args, cwd, timeoutMs, logger: params.logger });
  return parseLastJsonLine<BrvCurateResult>(stdout);
}

/**
 * Run `brv query` and return the synthesized answer.
 */
export async function brvQuery(params: {
  config: BrvProcessConfig;
  logger: PluginLogger;
  query: string;
  signal?: AbortSignal;
}): Promise<BrvJsonResponse<BrvQueryResult>> {
  const brvPath = params.config.brvPath ?? "brv";
  const cwd = params.config.cwd ?? process.cwd();
  const timeoutMs = params.config.queryTimeoutMs ?? 12_000;

  // "--" terminates flags so user text starting with "-" isn't parsed as a brv option
  const args = ["query", "--format", "json", "--", params.query];

  const { stdout } = await runBrv({
    brvPath,
    args,
    cwd,
    timeoutMs,
    logger: params.logger,
    signal: params.signal,
  });
  return parseLastJsonLine<BrvQueryResult>(stdout);
}
