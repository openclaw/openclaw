import fs from "node:fs";
import path from "node:path";

export type AuditEntry = {
  ts: string;
  tool: string;
  argsSummary: string;
  tier: string;
  tainted: boolean;
  result: string;
  chainFlags: string[];
  rateWindow: Record<string, number>;
};

export type AuditInput = Omit<AuditEntry, "ts">;

export class AuditLogger {
  private stream: fs.WriteStream | null = null;

  constructor(private logPath: string) {}

  private ensureStream(): fs.WriteStream {
    if (!this.stream) {
      const dir = path.dirname(this.logPath);
      fs.mkdirSync(dir, { recursive: true });
      this.stream = fs.createWriteStream(this.logPath, { flags: "a" });
    }
    return this.stream;
  }

  async log(input: AuditInput): Promise<void> {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      ...input,
    };
    const line = JSON.stringify(entry) + "\n";
    const stream = this.ensureStream();
    return new Promise((resolve, reject) => {
      stream.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
