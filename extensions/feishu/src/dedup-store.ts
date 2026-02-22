import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_DEDUP_DIR = path.join(os.homedir(), ".openclaw", "feishu", "dedup");
const MAX_ENTRIES_PER_FILE = 10_000;
const CLEANUP_PROBABILITY = 0.02;

type DedupData = Record<string, number>;

/**
 * Filesystem-backed dedup store.  Each "namespace" (typically a Feishu account
 * ID) maps to a single JSON file containing `{ messageId: timestampMs }` pairs.
 *
 * Writes use atomic rename to avoid partial-read corruption.  Probabilistic
 * cleanup keeps the file size bounded without adding latency to every call.
 */
export class DedupStore {
  private readonly dir: string;
  private cache = new Map<string, DedupData>();

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_DEDUP_DIR;
  }

  private filePath(namespace: string): string {
    const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.dir, `${safe}.json`);
  }

  async load(namespace: string): Promise<DedupData> {
    const cached = this.cache.get(namespace);
    if (cached) return cached;

    try {
      const raw = await fs.promises.readFile(this.filePath(namespace), "utf-8");
      const data: DedupData = JSON.parse(raw);
      this.cache.set(namespace, data);
      return data;
    } catch {
      const data: DedupData = {};
      this.cache.set(namespace, data);
      return data;
    }
  }

  async has(namespace: string, messageId: string, ttlMs: number): Promise<boolean> {
    const data = await this.load(namespace);
    const ts = data[messageId];
    if (ts == null) return false;
    if (Date.now() - ts > ttlMs) {
      delete data[messageId];
      return false;
    }
    return true;
  }

  async record(namespace: string, messageId: string, ttlMs: number): Promise<void> {
    const data = await this.load(namespace);
    data[messageId] = Date.now();

    if (Math.random() < CLEANUP_PROBABILITY) {
      this.evict(data, ttlMs);
    }

    await this.flush(namespace, data);
  }

  private evict(data: DedupData, ttlMs: number): void {
    const now = Date.now();
    for (const key of Object.keys(data)) {
      if (now - data[key] > ttlMs) delete data[key];
    }

    const keys = Object.keys(data);
    if (keys.length > MAX_ENTRIES_PER_FILE) {
      keys
        .sort((a, b) => data[a] - data[b])
        .slice(0, keys.length - MAX_ENTRIES_PER_FILE)
        .forEach((k) => delete data[k]);
    }
  }

  private async flush(namespace: string, data: DedupData): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const fp = this.filePath(namespace);
    const tmp = `${fp}.tmp.${process.pid}`;
    await fs.promises.writeFile(tmp, JSON.stringify(data), "utf-8");
    await fs.promises.rename(tmp, fp);
  }
}
