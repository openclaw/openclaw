/**
 * OpenSandbox backend implementation for the SandboxBackend interface.
 *
 * Executes commands inside a remote OpenSandbox instance via the execd HTTP
 * API instead of `docker exec`.
 */

import type { SandboxOpenSandboxSettings } from "../../config/types.sandbox.js";
import { logInfo, logWarn } from "../../logger.js";
import type { SandboxBackend, SandboxCommandOutputItem, SandboxExecResult } from "./backend.js";
import { OpenSandboxClient } from "./opensandbox-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EXECD_PORT = 44772;
const DEFAULT_TIMEOUT_SEC = 1800;

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

export type ResolvedOpenSandboxConfig = {
  execdUrl: string;
  accessToken?: string;
  timeoutSec: number;
};

/**
 * Resolve the effective execd URL and access token from configuration and/or
 * environment variables.
 *
 * Priority: explicit config > environment variables > lifecycle discovery.
 *
 * Lifecycle discovery (Phase 2) is not yet implemented – this function will
 * throw if neither a direct URL nor a lifecycle URL can be resolved.
 */
export function resolveOpenSandboxConfig(
  settings?: SandboxOpenSandboxSettings,
): ResolvedOpenSandboxConfig {
  const execdUrl =
    settings?.execdUrl?.trim() || process.env.OPEN_SANDBOX_EXECD_URL?.trim() || undefined;

  const accessToken =
    settings?.accessToken?.trim() ||
    process.env.OPEN_SANDBOX_EXECD_ACCESS_TOKEN?.trim() ||
    undefined;

  const timeoutSec = settings?.timeoutSec ?? DEFAULT_TIMEOUT_SEC;

  if (execdUrl) {
    return { execdUrl, accessToken, timeoutSec };
  }

  // Attempt lifecycle discovery from env vars.
  const lifecycleUrl =
    settings?.lifecycleUrl?.trim() || process.env.OPEN_SANDBOX_LIFECYCLE_URL?.trim() || undefined;

  if (lifecycleUrl) {
    const sandboxId =
      settings?.sandboxId?.trim() || process.env.OPEN_SANDBOX_SANDBOX_ID?.trim() || undefined;
    const port =
      settings?.execdPort ?? (Number(process.env.OPEN_SANDBOX_EXECD_PORT) || DEFAULT_EXECD_PORT);

    if (sandboxId) {
      // TODO(phase-2): Call lifecycle API to resolve the execd endpoint for
      // the given sandbox ID.  For now we construct the URL directly assuming
      // the execd port is reachable on the lifecycle host.
      const baseHost = new URL(lifecycleUrl).hostname;
      return {
        execdUrl: `http://${baseHost}:${port}`,
        accessToken:
          accessToken ?? settings?.apiKey?.trim() ?? process.env.OPEN_SANDBOX_API_KEY?.trim(),
        timeoutSec,
      };
    }

    // Without a sandbox ID we cannot resolve the execd endpoint yet.
    throw new Error(
      "OpenSandbox lifecycle discovery requires OPEN_SANDBOX_SANDBOX_ID or opensandbox.sandboxId config. " +
        "Alternatively set OPEN_SANDBOX_EXECD_URL to connect directly to an execd endpoint.",
    );
  }

  throw new Error(
    "OpenSandbox backend requires either opensandbox.execdUrl / OPEN_SANDBOX_EXECD_URL " +
      "or opensandbox.lifecycleUrl / OPEN_SANDBOX_LIFECYCLE_URL to be configured.",
  );
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

export class OpenSandboxBackend implements SandboxBackend {
  readonly kind = "opensandbox" as const;

  private readonly client: OpenSandboxClient;
  private readonly timeoutSec: number;

  constructor(config: ResolvedOpenSandboxConfig) {
    this.client = new OpenSandboxClient({
      baseUrl: config.execdUrl,
      accessToken: config.accessToken,
    });
    this.timeoutSec = config.timeoutSec;
    logInfo(`OpenSandbox backend: connecting to execd at ${config.execdUrl}`);
  }

  // -----------------------------------------------------------------------
  // SandboxBackend interface
  // -----------------------------------------------------------------------

  async exec(params: {
    command: string;
    workdir?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<SandboxExecResult> {
    const timeout = params.timeoutMs ? Math.ceil(params.timeoutMs / 1000) : this.timeoutSec;

    const result = await this.client.startCommand({
      command: params.command,
      workdir: params.workdir,
      env: params.env,
      wait: true,
      timeout,
    });

    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  async execAsync(params: {
    command: string;
    workdir?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ sessionId: string }> {
    const timeout = params.timeoutMs ? Math.ceil(params.timeoutMs / 1000) : this.timeoutSec;

    const result = await this.client.startCommand({
      command: params.command,
      workdir: params.workdir,
      env: params.env,
      wait: false,
      timeout,
    });

    if (!result.sessionId) {
      throw new Error("OpenSandbox execd did not return a sessionId for async command");
    }
    return { sessionId: result.sessionId };
  }

  async pollSession(sessionId: string): Promise<{ running: boolean; exitCode?: number }> {
    return this.client.getStatus(sessionId);
  }

  async readOutput(sessionId: string): Promise<SandboxCommandOutputItem[]> {
    return this.client.getOutput(sessionId);
  }

  async killSession(sessionId: string): Promise<void> {
    try {
      await this.client.kill(sessionId);
    } catch (error) {
      // Best-effort kill; the session may have already exited.
      logWarn(
        `OpenSandbox: failed to kill session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async destroy(): Promise<void> {
    // Phase 2: If we created the sandbox via lifecycle API, destroy it here.
    logInfo("OpenSandbox backend: destroy (no-op for direct execd connections)");
  }
}
