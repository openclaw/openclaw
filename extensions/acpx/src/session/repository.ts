import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedAcpxPluginConfig } from "../config.js";
import type { SessionRecord } from "../runtime-types.js";

export const SESSION_RECORD_SCHEMA = "openclaw.acpx.session.v1" as const;

function safeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

export class SessionRepository {
  constructor(private readonly config: ResolvedAcpxPluginConfig) {}

  get sessionDir(): string {
    return path.join(this.config.stateDir, "sessions");
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
  }

  filePath(sessionId: string): string {
    return path.join(this.sessionDir, `${safeSessionId(sessionId)}.json`);
  }

  async load(sessionId: string): Promise<SessionRecord | null> {
    try {
      const payload = await fs.readFile(this.filePath(sessionId), "utf8");
      return JSON.parse(payload) as SessionRecord;
    } catch {
      return null;
    }
  }

  async save(record: SessionRecord): Promise<void> {
    await this.ensureDir();
    const target = this.filePath(record.acpxRecordId);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await fs.rename(temp, target);
  }

  async close(sessionId: string): Promise<SessionRecord | null> {
    const record = await this.load(sessionId);
    if (!record) {
      return null;
    }
    record.closed = true;
    record.closedAt = new Date().toISOString();
    await this.save(record);
    return record;
  }
}
