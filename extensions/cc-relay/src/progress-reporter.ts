import * as fs from "node:fs";
import type { CcRelayConfig } from "./config.js";
import { findLatestSession, parseNewEntries } from "./session-parser.js";
import type { CcRelayJob, ProgressEntry } from "./types.js";

/**
 * Options for the progress reporter callback.
 */
export interface ProgressReporterCallbacks {
  /** Send a text message to the originating channel. */
  sendMessage: (channel: string, target: string, text: string) => Promise<void>;
}

/**
 * Progress reporter that monitors a Claude Code JSONL session file
 * and periodically sends progress updates to the originating channel.
 *
 * This is the TypeScript equivalent of T800's `progress-reporter.py`:
 * - Watches the Claude JSONL session file for new assistant entries
 * - Extracts only human-readable text and meaningful tool calls
 * - Skips noise (Read/Glob/Grep tool calls)
 * - Deduplicates by tracking byte offset
 * - Sends progress on a configurable interval
 */
export class ProgressReporter {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private waitHandle: ReturnType<typeof setInterval> | null = null;
  private sessionFile: string | null = null;
  private byteOffset = 0;
  private seq = 0;
  private stopped = false;

  constructor(
    private readonly job: CcRelayJob,
    private readonly cfg: CcRelayConfig,
    private readonly callbacks: ProgressReporterCallbacks,
  ) {}

  /**
   * Start monitoring. Returns immediately; reporting happens on a timer.
   */
  start(): void {
    if (this.cfg.progressIntervalSeconds <= 0 || !this.job.target) return;

    const homeDir = this.cfg.runAsUser
      ? `/home/${this.cfg.runAsUser}`
      : (process.env.HOME ?? "~");

    // Wait for the session file to appear (poll every 2s, max 120s)
    let waitCount = 0;
    this.waitHandle = setInterval(() => {
      if (this.stopped) {
        if (this.waitHandle) clearInterval(this.waitHandle);
        this.waitHandle = null;
        return;
      }
      waitCount++;
      this.sessionFile = findLatestSession(homeDir);
      if (this.sessionFile) {
        if (this.waitHandle) clearInterval(this.waitHandle);
        this.waitHandle = null;
        // Start from current position to skip historical data
        try {
          this.byteOffset = fs.statSync(this.sessionFile).size;
        } catch {
          this.byteOffset = 0;
        }
        this.startReporting();
      } else if (waitCount >= 60) {
        if (this.waitHandle) clearInterval(this.waitHandle);
        this.waitHandle = null;
      }
    }, 2000);
  }

  /**
   * Stop the reporter gracefully.
   */
  stop(): void {
    this.stopped = true;
    if (this.waitHandle) {
      clearInterval(this.waitHandle);
      this.waitHandle = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private startReporting(): void {
    this.intervalHandle = setInterval(() => {
      if (this.stopped) {
        this.stop();
        return;
      }
      void this.reportOnce();
    }, this.cfg.progressIntervalSeconds * 1000);
  }

  private async reportOnce(): Promise<void> {
    if (!this.sessionFile) return;

    // Check for session file rotation
    const homeDir = this.cfg.runAsUser
      ? `/home/${this.cfg.runAsUser}`
      : (process.env.HOME ?? "~");
    const currentSession = findLatestSession(homeDir);
    if (currentSession && currentSession !== this.sessionFile) {
      this.sessionFile = currentSession;
      this.byteOffset = 0;
    }

    const { entries, newOffset } = parseNewEntries(this.sessionFile, this.byteOffset);
    if (entries.length === 0) return;

    this.byteOffset = newOffset;
    this.seq++;

    const msg = formatProgressMessage(this.seq, entries.slice(-8));
    if (msg.length > 2000) {
      await this.callbacks.sendMessage(this.job.channel, this.job.target, msg.slice(0, 2000) + "...");
    } else {
      await this.callbacks.sendMessage(this.job.channel, this.job.target, msg);
    }
  }
}

function formatProgressMessage(seq: number, entries: ProgressEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "text") {
      lines.push(`  ${entry.content}`);
    } else {
      lines.push(`  > ${entry.content}`);
    }
  }
  return `[CC Progress #${seq}]\n${lines.join("\n")}`;
}
