/**
 * Low-level HTTP client for the OpenSandbox execd API.
 *
 * The execd daemon runs inside each OpenSandbox instance and exposes a small
 * REST API for command execution:
 *
 *   POST   /command                  – start a command (sync or async)
 *   GET    /command/status/:id       – poll running state + exit code
 *   GET    /command/output/:id       – retrieve accumulated stdout/stderr
 *   POST   /command/kill/:id         – terminate a running command
 *
 * This module intentionally uses Node.js built-in `fetch` so that no extra
 * dependencies are required.
 */

import type { SandboxCommandOutputItem } from "./backend.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenSandboxClientConfig = {
  /** Base URL of the execd service (e.g. "http://10.0.0.5:44772"). */
  baseUrl: string;
  /** Access token sent via `X-EXECD-ACCESS-TOKEN` header. */
  accessToken?: string;
  /** Default request timeout in milliseconds (default: 30 000). */
  requestTimeoutMs?: number;
};

export type StartCommandParams = {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  /** When true, the request blocks until the command exits. */
  wait?: boolean;
  /** Command timeout in seconds (server-side). */
  timeout?: number;
};

export type StartCommandResult = {
  /** Session ID for async commands (when wait=false). */
  sessionId?: string;
  /** Exit code (only present when wait=true and command completed). */
  exitCode?: number;
  /** stdout content (only present when wait=true). */
  stdout?: string;
  /** stderr content (only present when wait=true). */
  stderr?: string;
};

export type CommandStatusResult = {
  running: boolean;
  exitCode?: number;
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class OpenSandboxClient {
  private readonly baseUrl: string;
  private readonly accessToken: string | undefined;
  private readonly requestTimeoutMs: number;

  constructor(config: OpenSandboxClientConfig) {
    // Strip trailing slash for consistent URL construction.
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.accessToken = config.accessToken;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start a command execution session.
   *
   * When `wait` is `true` the request blocks until the command completes and
   * the response includes stdout/stderr/exitCode directly.
   *
   * When `wait` is `false` (default) the response contains a `sessionId` that
   * can be used with `getStatus`, `getOutput`, and `kill`.
   */
  async startCommand(params: StartCommandParams): Promise<StartCommandResult> {
    const body = {
      command: params.command,
      ...(params.workdir ? { workdir: params.workdir } : {}),
      ...(params.env && Object.keys(params.env).length > 0 ? { env: params.env } : {}),
      wait: params.wait ?? false,
      ...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
    };

    // When waiting synchronously, the server may take as long as the command
    // runs, so use a generous timeout derived from the command timeout.
    const timeoutMs = params.wait
      ? Math.max(this.requestTimeoutMs, (params.timeout ?? 1800) * 1000 + 10_000)
      : this.requestTimeoutMs;

    const resp = await this.request("POST", "/command", body, timeoutMs);
    return resp as StartCommandResult;
  }

  /**
   * Poll the execution status of an async command session.
   */
  async getStatus(sessionId: string): Promise<CommandStatusResult> {
    const resp = await this.request("GET", `/command/status/${encodeURIComponent(sessionId)}`);
    return resp as CommandStatusResult;
  }

  /**
   * Retrieve accumulated output from an async command session.
   * Returns an array of `{fd, msg}` items (fd=1 for stdout, fd=2 for stderr).
   */
  async getOutput(sessionId: string): Promise<SandboxCommandOutputItem[]> {
    const resp = await this.request("GET", `/command/output/${encodeURIComponent(sessionId)}`);
    if (Array.isArray(resp)) {
      return resp as SandboxCommandOutputItem[];
    }
    // Some execd versions wrap output in an object.
    if (resp && typeof resp === "object" && "output" in resp && Array.isArray(resp.output)) {
      return resp.output as SandboxCommandOutputItem[];
    }
    return [];
  }

  /**
   * Kill a running async command session.
   */
  async kill(sessionId: string): Promise<void> {
    await this.request("POST", `/command/kill/${encodeURIComponent(sessionId)}`);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.accessToken) {
      headers["X-EXECD-ACCESS-TOKEN"] = this.accessToken;
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
    init.signal = controller.signal;

    try {
      const resp = await fetch(url, init);
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `OpenSandbox execd ${method} ${path} failed: ${resp.status} ${resp.statusText}${text ? ` – ${text}` : ""}`,
        );
      }
      const contentType = resp.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return await resp.json();
      }
      return await resp.text();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `OpenSandbox execd ${method} ${path} timed out after ${effectiveTimeout}ms`, { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
