/**
 * External worker backend for sessions_spawn.
 *
 * When `agents.defaults.subagents.workerBackend` is set (e.g. "loa"),
 * sub-agent spawns are delegated to an external launcher instead of
 * running in-process via callGateway.
 *
 * The launcher is an executable specified by `workerLauncher` (path)
 * or `workerSocket` (Unix socket for HTTP). It receives a JSON spawn
 * request on stdin and returns a JSON response on stdout.
 *
 * This enables governance frameworks like LOA (Land of Agents) to
 * manage worker lifecycle, enforce network/mount/secret policies,
 * and maintain an auditable spawn trail.
 */

import { spawn } from "node:child_process";

export type ExternalWorkerBackendConfig = {
  /** Backend identifier (e.g. "loa"). */
  backend: string;
  /** Path to launcher executable. Receives JSON on stdin, returns JSON on stdout. */
  launcher: string;
};

export type ExternalSpawnRequest = {
  /** Protocol version for the spawn request. */
  version: "openclaw.worker.v1";
  /** Unique request identifier. */
  requestId: string;
  /** Target agent identifier. */
  agentId: string;
  /** Child session key assigned by OpenClaw. */
  childSessionKey: string;
  /** Session key of the requester (parent). */
  requesterSessionKey: string;
  /** Spawn depth (1 = direct child, 2 = grandchild, etc). */
  depth: number;
  /** The task message for the child agent. */
  task: string;
  /** System prompt for the child agent. */
  systemPrompt: string;
  /** Run timeout in seconds (0 = no timeout). */
  runTimeoutSeconds: number;
  /** Spawn mode: "run" (one-shot) or "session" (persistent). */
  mode: "run" | "session";
  /** Model selection for the child agent (if any). */
  model?: string;
  /** Thinking level override (if any). */
  thinking?: string;
  /** Label for the child agent run. */
  label?: string;
  /** Workspace directory to inherit. */
  workspaceDir?: string;
};

export type ExternalSpawnResponse = {
  /** "accepted" on success, "error" or "denied" on failure. */
  status: "accepted" | "denied" | "error";
  /** Worker/run identifier assigned by the external backend. */
  workerId?: string;
  /** Human-readable error message on failure. */
  error?: string;
};

/**
 * Resolve external worker backend config from OpenClaw config.
 * Returns undefined if no external backend is configured.
 */
export function resolveExternalWorkerBackend(cfg: {
  agents?: {
    defaults?: {
      subagents?: {
        workerBackend?: string;
        workerLauncher?: string;
      };
    };
  };
}): ExternalWorkerBackendConfig | undefined {
  const backend = cfg?.agents?.defaults?.subagents?.workerBackend?.trim();
  if (!backend) {
    return undefined;
  }
  const launcher = cfg?.agents?.defaults?.subagents?.workerLauncher?.trim();
  if (!launcher) {
    return undefined;
  }
  return { backend, launcher };
}

/**
 * Spawn a sub-agent via an external worker backend.
 *
 * Calls the launcher executable with the spawn request as JSON on stdin.
 * The launcher must return a JSON response on stdout within the timeout.
 */
export async function spawnExternalWorker(
  config: ExternalWorkerBackendConfig,
  request: ExternalSpawnRequest,
): Promise<ExternalSpawnResponse> {
  const input = JSON.stringify(request);
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(config.launcher, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          OPENCLAW_WORKER_BACKEND: config.backend,
        },
        timeout: 30_000,
      });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      child.stdout.on("data", (data: Buffer) => chunks.push(data));
      child.stderr.on("data", (data: Buffer) => errChunks.push(data));
      child.on("error", reject);
      child.on("close", (code) => {
        const stdout = Buffer.concat(chunks).toString("utf8");
        const stderr = Buffer.concat(errChunks).toString("utf8");
        if (code !== 0 && !stdout.trim()) {
          reject(new Error(`Launcher exited with code ${code}: ${stderr.trim()}`));
        } else {
          resolve({ stdout, stderr });
        }
      });
      child.stdin.write(input);
      child.stdin.end();
    });
    if (result.stderr.trim()) {
      process.stderr.write(
        `[external-worker-backend] ${config.backend}: ${result.stderr.trim()}\n`,
      );
    }
    const trimmed = result.stdout.trim();
    if (!trimmed) {
      return {
        status: "error",
        error: `External worker launcher (${config.backend}) returned empty response`,
      };
    }
    const parsed = JSON.parse(trimmed) as ExternalSpawnResponse;
    if (!parsed.status) {
      return {
        status: "error",
        error: `External worker launcher (${config.backend}) returned invalid response (missing status)`,
      };
    }
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      error: `External worker launcher (${config.backend}) failed: ${message}`,
    };
  }
}
