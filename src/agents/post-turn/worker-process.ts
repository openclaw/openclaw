import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";

const DEFAULT_WORKER_TIMEOUT_MS = 30_000;
const MAX_CAPTURED_OUTPUT_BYTES = 32_000;

export class PostTurnWorkerProcessError extends Error {
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(params: {
    message: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    stdout?: string;
    stderr?: string;
    timedOut?: boolean;
  }) {
    super(params.message);
    this.name = "PostTurnWorkerProcessError";
    this.exitCode = params.exitCode;
    this.signal = params.signal;
    this.stdout = params.stdout ?? "";
    this.stderr = params.stderr ?? "";
    this.timedOut = params.timedOut ?? false;
  }
}

function appendCapturedOutput(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= MAX_CAPTURED_OUTPUT_BYTES) {
    return next;
  }
  return next.slice(next.length - MAX_CAPTURED_OUTPUT_BYTES);
}

export function resolvePostTurnWorkerRequestDir(): string {
  return path.join(resolveStateDir(), "post-turn", "worker-requests");
}

export async function cleanupPostTurnWorkerRequestFiles(): Promise<number> {
  const requestDir = resolvePostTurnWorkerRequestDir();
  let removed = 0;
  try {
    const entries = await fs.readdir(requestDir);
    removed = entries.length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  await fs.rm(requestDir, { force: true, recursive: true });
  return removed;
}

export function isPostTurnWorkerNativeCrash(error: unknown): boolean {
  if (!(error instanceof PostTurnWorkerProcessError)) {
    return false;
  }
  if (error.signal === "SIGSEGV" || error.signal === "SIGABRT" || error.signal === "SIGBUS") {
    return true;
  }
  return error.exitCode === 134 || error.exitCode === 135 || error.exitCode === 139;
}

export async function runPostTurnWorkerProcess(params: {
  workerModuleUrl: string;
  request: unknown;
  timeoutMs?: number;
}): Promise<void> {
  const serializedRequest = JSON.stringify(params.request);

  const timeoutMs = params.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const bootstrapScript = [
    `import(${JSON.stringify(params.workerModuleUrl)})`,
    "  .then(async (mod) => {",
    "    if (typeof mod.runPostTurnWorkerFromCli !== 'function') {",
    "      throw new Error('worker module does not export runPostTurnWorkerFromCli');",
    "    }",
    "    await mod.runPostTurnWorkerFromCli();",
    "  })",
    "  .catch((error) => {",
    "    console.error(error && error.stack ? error.stack : String(error));",
    "    process.exitCode = 1;",
    "  });",
  ].join("\n");

  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", bootstrapScript], {
      env: {
        ...process.env,
        OPENCLAW_POST_TURN_WORKER_REQUEST_STDIN: "1",
        OPENCLAW_POST_TURN_HOOK_WORKER_CHILD: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(serializedRequest);

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(
        new PostTurnWorkerProcessError({
          message: `post-turn worker timed out after ${timeoutMs}ms`,
          stdout,
          stderr,
          timedOut: true,
        }),
      );
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCapturedOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCapturedOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(
        new PostTurnWorkerProcessError({
          message: `post-turn worker failed to start: ${error.message}`,
          stdout,
          stderr,
        }),
      );
    });
    child.on("exit", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (exitCode === 0 && !signal) {
        resolve();
        return;
      }
      reject(
        new PostTurnWorkerProcessError({
          message:
            `post-turn worker exited with ` +
            (signal ? `signal ${signal}` : `code ${exitCode ?? "unknown"}`),
          exitCode,
          signal,
          stdout,
          stderr,
        }),
      );
    });
  });
}
