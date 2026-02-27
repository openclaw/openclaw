import { spawn } from "node:child_process";
import path from "node:path";

export type RunResult =
  | { ok: true; stdout: string; exitCode: number }
  | { ok: false; error: string; exitCode: number };

/**
 * Run the secret-wallet CLI binary and capture its output.
 * Resolves with parsed stdout or an error message.
 */
export async function runSecretWallet(
  binaryPath: string | undefined,
  args: string[],
  options?: {
    timeoutMs?: number;
    maxStdoutBytes?: number;
    stdin?: string;
  },
): Promise<RunResult> {
  let execPath: string;
  try {
    execPath = resolveBinaryPath(binaryPath);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid binaryPath",
      exitCode: -1,
    };
  }

  const timeoutMs = Math.max(200, options?.timeoutMs ?? 30_000);
  const maxStdoutBytes = Math.max(1024, options?.maxStdoutBytes ?? 1_048_576);

  return new Promise<RunResult>((resolve) => {
    const child = spawn(execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      timeout: timeoutMs,
    });

    let stdout = "";
    let stdoutBytes = 0;
    let killedForSize = false;
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > maxStdoutBytes) {
        killedForSize = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk;
    });

    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    if (options?.stdin !== undefined) {
      child.stdin?.write(options.stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }

    child.on("error", (err) => {
      resolve({
        ok: false,
        error: `Failed to spawn secret-wallet: ${err.message}`,
        exitCode: -1,
      });
    });

    child.on("close", (code) => {
      const exitCode = code ?? -1;
      if (exitCode === 0) {
        resolve({ ok: true, stdout, exitCode });
      } else {
        if (killedForSize) {
          resolve({
            ok: false,
            error: `Output exceeded ${maxStdoutBytes} bytes limit`,
            exitCode,
          });
          return;
        }
        resolve({
          ok: false,
          error: stderr.trim() || `secret-wallet exited with code ${exitCode}`,
          exitCode,
        });
      }
    });
  });
}

function resolveBinaryPath(raw: string | undefined): string {
  const p = raw?.trim() || "secret-wallet";
  if (p !== "secret-wallet" && !path.isAbsolute(p)) {
    throw new Error("binaryPath must be an absolute path (or omit to use PATH)");
  }
  return p;
}
