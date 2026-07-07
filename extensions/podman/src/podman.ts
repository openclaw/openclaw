import { spawn } from "node:child_process";
import type { PodmanPluginConfig } from "./config.js";

export type ExecPodmanRawOptions = {
  allowFailure?: boolean;
  input?: Buffer | string;
  signal?: AbortSignal;
};

export type ExecPodmanRawResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
};

type ExecPodmanRawError = Error & {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
};

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function buildPodmanInvocation(params: {
  config: PodmanPluginConfig;
  args: readonly string[];
}): { command: string; args: string[] } {
  const args: string[] = [];
  if (params.config.connection) {
    args.push("--connection", params.config.connection);
  }
  if (params.config.url) {
    args.push("--url", params.config.url);
  }
  args.push(...params.args);
  return { command: params.config.command, args };
}

export function execPodmanRaw(
  config: PodmanPluginConfig,
  args: string[],
  opts?: ExecPodmanRawOptions,
): Promise<ExecPodmanRawResult> {
  return new Promise<ExecPodmanRawResult>((resolve, reject) => {
    const invocation = buildPodmanInvocation({ config, args });
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;
    let outputStreamError: Error | undefined;

    const signal = opts?.signal;
    const handleAbort = () => {
      if (aborted) {
        return;
      }
      aborted = true;
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener("abort", handleAbort, { once: true });
      }
    }

    const handleStreamError = (error: Error) => {
      if (outputStreamError) {
        return;
      }
      outputStreamError = error;
      child.kill("SIGTERM");
    };
    child.stdout?.on("error", handleStreamError);
    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("error", handleStreamError);
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", (error) => {
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        reject(
          Object.assign(
            new Error(
              `Sandbox backend "podman" requires Podman, but the "${config.command}" command was not found in PATH. Install Podman or set agents.defaults.sandbox.backend to another backend.`,
            ),
            { code: "INVALID_CONFIG", cause: error },
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      if (aborted || signal?.aborted) {
        reject(createAbortError("Aborted"));
        return;
      }
      if (outputStreamError) {
        reject(outputStreamError);
        return;
      }
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !opts?.allowFailure) {
        reject(
          Object.assign(
            new Error(stderr.toString("utf8").trim() || `podman ${args.join(" ")} failed`),
            {
              code: exitCode,
              stdout,
              stderr,
            },
          ) satisfies ExecPodmanRawError,
        );
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });

    const stdin = child.stdin;
    if (stdin) {
      stdin.on("error", handleStreamError);
      if (opts?.input !== undefined) {
        stdin.end(opts.input);
      } else {
        stdin.end();
      }
    }
  });
}

export async function execPodman(
  config: PodmanPluginConfig,
  args: string[],
  opts?: ExecPodmanRawOptions,
) {
  const result = await execPodmanRaw(config, args, opts);
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    code: result.code,
  };
}

export async function podmanContainerState(config: PodmanPluginConfig, name: string) {
  const result = await execPodman(config, ["inspect", "-f", "{{.State.Running}}", name], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return { exists: false, running: false };
  }
  return { exists: true, running: result.stdout.trim() === "true" };
}

export async function readPodmanContainerLabel(
  config: PodmanPluginConfig,
  containerName: string,
  label: string,
): Promise<string | null> {
  const result = await execPodman(
    config,
    ["inspect", "-f", `{{ index .Config.Labels "${label}" }}`, containerName],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return null;
  }
  const raw = result.stdout.trim();
  return raw && raw !== "<no value>" ? raw : null;
}
