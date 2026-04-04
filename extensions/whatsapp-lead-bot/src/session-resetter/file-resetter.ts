import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionResetter } from "../session-resetter.js";

type SessionStoreEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  origin?: Record<string, unknown>;
  label?: string;
  [key: string]: unknown;
};

export class FileSessionResetter implements SessionResetter {
  constructor(
    private stateDir: string,
    private agentId: string,
    private channel: string,
    private accountId: string,
  ) {}

  async resetSession(phoneNumber: string): Promise<boolean> {
    const sessionKey = this.buildSessionKey(phoneNumber);
    const storePath = path.join(this.stateDir, "agents", this.agentId, "sessions", "sessions.json");

    if (!fs.existsSync(storePath)) {
      return false;
    }

    const raw = await fs.promises.readFile(storePath, "utf-8");
    const store: Record<string, SessionStoreEntry> = JSON.parse(raw);

    const entry = store[sessionKey];
    if (!entry) {
      return false;
    }

    // Archive old transcript file
    if (entry.sessionFile) {
      await this.archiveTranscript(entry.sessionFile);
    } else {
      // Try default transcript path
      const defaultPath = path.join(
        this.stateDir,
        "agents",
        this.agentId,
        "sessions",
        `${entry.sessionId}.jsonl`,
      );
      await this.archiveTranscript(defaultPath);
    }

    // Create fresh session entry preserving routing fields
    store[sessionKey] = {
      sessionId: crypto.randomUUID(),
      updatedAt: Date.now(),
      lastChannel: entry.lastChannel,
      lastTo: entry.lastTo,
      lastAccountId: entry.lastAccountId,
      origin: entry.origin,
      label: entry.label,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    // Atomic write: temp file + rename
    const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const json = JSON.stringify(store, null, 2);
    await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fs.promises.rename(tmp, storePath);

    return true;
  }

  private buildSessionKey(phoneNumber: string): string {
    const phone = phoneNumber.toLowerCase();
    return `agent:${this.agentId}:${this.channel}:${this.accountId}:direct:${phone}`;
  }

  private async archiveTranscript(filePath: string): Promise<void> {
    try {
      if (!fs.existsSync(filePath)) {
        return;
      }
      // Delete the transcript file completely (don't archive)
      // This ensures the next message starts with a fresh session
      await fs.promises.unlink(filePath);
    } catch {
      // Best-effort deletion
    }
  }
}
