import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export type ColdStoreSegment = {
  id: string;
  sessionId: string;
  sessionKey?: string;
  timestamp: number;
  role: "user" | "assistant";
  content: string;
  embedding?: number[];
  tokens: number;
};

export class ColdStore {
  readonly path: string;
  private readonly filePath: string;
  private appendChain: Promise<void> = Promise.resolve();

  constructor(storagePath: string) {
    this.path = storagePath;
    this.filePath = path.join(storagePath, "segments.jsonl");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.path, { recursive: true });
    // Ensure file exists (best-effort)
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, "", { encoding: "utf8" });
    }
  }

  async append(segment: ColdStoreSegment): Promise<void> {
    // Don't persist embedding in JSONL — vectors.bin is used for vector caching
    const { embedding: _drop, ...rest } = segment;
    const line = JSON.stringify(rest);

    this.appendChain = this.appendChain.then(async () => {
      await this.ensureReady();
      await fs.appendFile(this.filePath, `${line}\n`, { encoding: "utf8" });
    });

    return this.appendChain;
  }

  /** Wait for all pending appends to complete. */
  async flush(): Promise<void> {
    await this.appendChain;
  }

  async *loadAll(): AsyncGenerator<ColdStoreSegment> {
    await this.ensureReady();

    // Use streaming readline to avoid loading the entire file into memory
    let stream: ReturnType<typeof createReadStream> | undefined;
    try {
      stream = createReadStream(this.filePath, { encoding: "utf8" });
    } catch {
      return;
    }

    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const obj = JSON.parse(trimmed) as ColdStoreSegment;
          // Basic validation
          if (!obj || typeof obj !== "object") {
            continue;
          }
          if (typeof obj.id !== "string" || typeof obj.sessionId !== "string") {
            continue;
          }
          if (obj.role !== "user" && obj.role !== "assistant") {
            continue;
          }
          if (typeof obj.content !== "string" || typeof obj.timestamp !== "number") {
            continue;
          }
          if (obj.embedding && !Array.isArray(obj.embedding)) {
            continue;
          }
          yield obj;
        } catch {
          // Ignore corrupt lines (best-effort recovery)
          continue;
        }
      }
    } finally {
      stream?.destroy();
    }
  }
}
