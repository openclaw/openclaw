/**
 * Terminal Interceptor
 *
 * Wraps a child process (Claude Code) using node:child_process with a PTY-like
 * approach. Captures stdout/stderr in real-time, buffers output, and flushes
 * to the analyzer on interval or when buffer is full.
 *
 * Think of this as a transparent proxy sitting between Claude and the terminal.
 * Everything Claude outputs, the operator still sees — but the conductor also
 * reads it looking for external-access requests.
 */

import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { ConductorConfig } from "./types.js";

export type InterceptorEvents = {
  output: (text: string) => void;
  flush: (buffered: string) => void;
  exit: (code: number | null, signal: string | null) => void;
  error: (err: Error) => void;
};

export class TerminalInterceptor extends EventEmitter {
  private child: ChildProcess | null = null;
  private buffer = "";
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;
  private readonly command: string;
  private readonly args: string[];

  constructor(config: ConductorConfig) {
    super();
    this.command = config.wrappedCommand ?? "claude";
    this.args = config.wrappedArgs ?? [];
    this.flushIntervalMs = config.bufferFlushIntervalMs ?? 2000;
    this.maxBufferSize = config.maxBufferSize ?? 8192;
  }

  /** Start the wrapped process and begin intercepting output. */
  start(): void {
    if (this.child) {
      throw new Error("Interceptor already running");
    }

    this.child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "1" },
      shell: true,
    });

    this.child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      // Pass through to the real terminal so the operator still sees everything
      process.stdout.write(chunk);
      this.appendBuffer(text);
      this.emit("output", text);
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stderr.write(chunk);
      this.appendBuffer(text);
      this.emit("output", text);
    });

    this.child.on("exit", (code, signal) => {
      this.flushBuffer();
      this.stopFlushTimer();
      this.emit("exit", code, signal);
    });

    this.child.on("error", (err) => {
      this.emit("error", err);
    });

    // Forward stdin from the operator to the child
    process.stdin.on("data", (chunk: Buffer) => {
      if (this.child?.stdin?.writable) {
        this.child.stdin.write(chunk);
      }
    });

    // Set up periodic buffer flushing
    this.startFlushTimer();
  }

  /** Inject text into the child's stdin (as if the operator typed it). */
  inject(text: string): void {
    if (!this.child?.stdin?.writable) {
      throw new Error("Cannot inject: child process stdin not writable");
    }
    this.child.stdin.write(text);
  }

  /** Inject a line (adds newline). */
  injectLine(text: string): void {
    this.inject(`${text}\n`);
  }

  /** Get the child process PID. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Check if the child process is still running. */
  get running(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null;
  }

  /** Stop the interceptor and kill the child process. */
  stop(): void {
    this.flushBuffer();
    this.stopFlushTimer();
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      // Force kill after 5s if still alive
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill("SIGKILL");
        }
      }, 5000);
    }
    this.child = null;
  }

  private appendBuffer(text: string): void {
    this.buffer += text;
    if (this.buffer.length >= this.maxBufferSize) {
      this.flushBuffer();
    }
  }

  private flushBuffer(): void {
    if (this.buffer.length > 0) {
      const flushed = this.buffer;
      this.buffer = "";
      this.emit("flush", flushed);
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flushBuffer();
    }, this.flushIntervalMs);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

/** Generate a unique request ID. */
export function generateRequestId(): string {
  return crypto.randomUUID();
}
