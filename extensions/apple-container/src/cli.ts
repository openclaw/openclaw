import { spawn } from "node:child_process";
import type { ResolvedAppleContainerPluginConfig } from "./config.js";

type AppleContainerSystemStatus = {
  status?: string;
};

type AppleContainerResources = {
  cpus?: number;
  memoryInBytes?: number;
};

type AppleContainerMount = {
  source?: string;
  destination?: string;
  readonly?: boolean;
  options?: string[];
};

type AppleContainerUser = {
  raw?: { userString?: string };
  id?: { uid?: number; gid?: number };
};

type AppleContainerInitProcess = {
  workingDirectory?: string;
  environment?: string[];
  user?: AppleContainerUser;
  rlimits?: Array<{ type?: string; soft?: number; hard?: number }>;
};

type AppleContainerConfiguration = {
  id?: string;
  labels?: Record<string, string>;
  image?: { reference?: string };
  readOnly?: boolean;
  mounts?: AppleContainerMount[];
  resources?: AppleContainerResources;
  initProcess?: AppleContainerInitProcess;
};

export type AppleContainerInspectEntry = {
  status?: string;
  configuration?: AppleContainerConfiguration;
};

export type RunAppleContainerCliResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
};

type RunAppleContainerCliOptions = {
  config: ResolvedAppleContainerPluginConfig;
  args: string[];
  input?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
};

function createAbortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

export function createAppleContainerCommandMissingError(command: string): Error {
  return Object.assign(
    new Error(
      `Sandbox backend "apple-container" requires the Apple container CLI, but "${command}" was not found in PATH. Install Apple's container runtime or set agents.defaults.sandbox.backend=docker.`,
    ),
    { code: "INVALID_CONFIG" },
  );
}

export function createAppleContainerUnsupportedHostError(): Error {
  return Object.assign(
    new Error('Sandbox backend "apple-container" is supported only on macOS Apple silicon hosts.'),
    { code: "INVALID_CONFIG" },
  );
}

export function createAppleContainerSystemStoppedError(command: string): Error {
  return Object.assign(
    new Error(
      `Sandbox backend "apple-container" requires the Apple container system to be running. Check \`${command} system status --format json\` and start it before retrying.`,
    ),
    { code: "INVALID_CONFIG" },
  );
}

function createAppleContainerCommandError(
  command: string,
  args: string[],
  stderr: Buffer,
  stdout: Buffer,
  code: number,
): Error {
  const detail =
    stderr.toString("utf8").trim() || stdout.toString("utf8").trim() || `${command} failed`;
  return Object.assign(new Error(detail || `${command} ${args.join(" ")} failed`), {
    code,
    stdout,
    stderr,
  });
}

export async function runAppleContainerCli(
  options: RunAppleContainerCliOptions,
): Promise<RunAppleContainerCliResult> {
  return await new Promise<RunAppleContainerCliResult>((resolve, reject) => {
    const child = spawn(options.config.command, options.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let timeoutId: NodeJS.Timeout | null = setTimeout(() => {
      timeoutId = null;
      timedOut = true;
      child.kill("SIGKILL");
    }, options.config.timeoutMs);
    let aborted = false;

    const signal = options.signal;
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
        signal.addEventListener("abort", handleAbort);
      }
    }

    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", (error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") {
        reject(createAppleContainerCommandMissingError(options.config.command));
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
      if (timedOut) {
        reject(
          new Error(
            `${options.config.command} ${options.args.join(" ")} timed out after ${options.config.timeoutMs}ms`,
          ),
        );
        return;
      }
      if (aborted || signal?.aborted) {
        reject(createAbortError());
        return;
      }
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      // Treat signal-killed processes (code === null) as failure
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        reject(
          createAppleContainerCommandError(
            options.config.command,
            options.args,
            stderr,
            stdout,
            exitCode,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

export async function assertAppleContainerHostSupport(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw createAppleContainerUnsupportedHostError();
  }
}

export async function assertAppleContainerSystemRunning(
  config: ResolvedAppleContainerPluginConfig,
): Promise<void> {
  await assertAppleContainerHostSupport();
  const result = await runAppleContainerCli({
    config,
    args: ["system", "status", "--format", "json"],
  });
  let parsed: AppleContainerSystemStatus | null = null;
  try {
    parsed = JSON.parse(result.stdout.toString("utf8")) as AppleContainerSystemStatus;
  } catch {
    throw createAppleContainerSystemStoppedError(config.command);
  }
  if (parsed?.status !== "running") {
    throw createAppleContainerSystemStoppedError(config.command);
  }
}

export async function inspectAppleContainer(params: {
  config: ResolvedAppleContainerPluginConfig;
  containerId: string;
}): Promise<AppleContainerInspectEntry | null> {
  const result = await runAppleContainerCli({
    config: params.config,
    args: ["inspect", params.containerId],
    allowFailure: true,
  });
  if (result.code !== 0) {
    return null;
  }
  const raw = result.stdout.toString("utf8").trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as AppleContainerInspectEntry[];
    return parsed[0] ?? null;
  } catch {
    return null;
  }
}
