/**
 * Pluggable backend abstraction for sandbox command execution.
 *
 * Docker (default) and OpenSandbox are the two built-in implementations.
 * The rest of the sandbox subsystem (exec tool, fs-bridge, process registry)
 * operates through this interface so that the backend can be swapped without
 * touching upper layers.
 */

import type { SandboxBackendKind } from "../../config/types.sandbox.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type SandboxExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type SandboxCommandOutputItem = {
  /** 1 = stdout, 2 = stderr */
  fd: number;
  msg: string;
};

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

export interface SandboxBackend {
  readonly kind: SandboxBackendKind;

  /**
   * Execute a command synchronously (blocks until completion).
   * Returns the collected stdout/stderr and exit code.
   */
  exec(params: {
    command: string;
    workdir?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<SandboxExecResult>;

  /**
   * Start a command asynchronously, returning a session ID that can be used
   * to poll status, read output, and kill the process.
   */
  execAsync(params: {
    command: string;
    workdir?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ sessionId: string }>;

  /**
   * Poll the status of an async command session.
   */
  pollSession(sessionId: string): Promise<{
    running: boolean;
    exitCode?: number;
  }>;

  /**
   * Read accumulated output from an async command session.
   */
  readOutput(sessionId: string): Promise<SandboxCommandOutputItem[]>;

  /**
   * Kill a running async command session.
   */
  killSession(sessionId: string): Promise<void>;

  /**
   * Tear down the backend and release resources.
   * For lifecycle-managed sandboxes this may destroy the remote instance.
   */
  destroy(): Promise<void>;
}
