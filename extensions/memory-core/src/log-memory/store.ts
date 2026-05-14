import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { computeCurrentDecay } from "./decay.js";
import { parseBlocks, serializeEpisodicBlock, serializeSemanticBlock } from "./md-format.js";
import type { LogMemoryEntry, LogMemoryLayer } from "./types.js";

// Layout under <workspaceDir>:
//   log-memory/
//     2026-05-07.md     <- episodic (one file per UTC day)
//     2026-05-08.md
//     KNOWLEDGE.md      <- semantic (single file)
//
// All writes are append-only except for `recordAccess` and `removeEpisodic`,
// which rewrite a daily file in place. No SQLite, no migrations.

const EPISODIC_DIR = "log-memory";
const SEMANTIC_FILENAME = "KNOWLEDGE.md";
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

export type AppendInput = LogMemoryEntry;
// Back-compat alias for callers that imported the old SQLite-era name.
export type UpsertInput = AppendInput;

export interface LogMemoryHybridResult {
  entry: LogMemoryEntry;
  score: number;
  vectorScore: number;
  bm25Score: number;
}

export class LogMemoryStore {
  private readonly rootDir: string;

  static resolveRootDir(workspaceDir: string): string {
    return path.join(workspaceDir, EPISODIC_DIR);
  }

  constructor(opts: { workspaceDir: string }) {
    this.rootDir = LogMemoryStore.resolveRootDir(opts.workspaceDir);
    fsSync.mkdirSync(this.rootDir, { recursive: true });
  }

  // No-op kept so callers from the SQLite era can `store.close()` without a
  // crash. The file-based store has no resources to release.
  close(): void {}

  episodicPathFor(date: Date): string {
    return path.join(this.rootDir, `${formatDayKey(date)}.md`);
  }

  semanticPath(): string {
    return path.join(this.rootDir, SEMANTIC_FILENAME);
  }

  async has(id: string, opts?: { daysBack?: number }): Promise<boolean> {
    const entries = await this.loadEpisodic({ daysBack: opts?.daysBack ?? 30 });
    return entries.some((entry) => entry.id === id);
  }

  async appendEpisodic(entry: LogMemoryEntry): Promise<void> {
    const filePath = this.episodicPathFor(entry.timestamp);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const block = serializeEpisodicBlock(entry);
    await fs.appendFile(filePath, ensureLeadingBlankLine(filePath, block), "utf8");
  }

  async appendSemantic(entry: LogMemoryEntry): Promise<void> {
    const filePath = this.semanticPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const block = serializeSemanticBlock(entry);
    await fs.appendFile(filePath, ensureLeadingBlankLine(filePath, block), "utf8");
  }

  // Default loads skip entries that have been consolidated by a dream cycle —
  // mirrors the `!includePromoted && entry.promotedAt` filter in
  // short-term-promotion.ts. Pass { includeConsolidated: true } to see them.
  async loadEpisodic(opts?: {
    daysBack?: number;
    includeConsolidated?: boolean;
  }): Promise<LogMemoryEntry[]> {
    const daysBack = opts?.daysBack;
    const includeConsolidated = opts?.includeConsolidated ?? false;
    const files = await this.listEpisodicFiles();
    let selected = files;
    if (typeof daysBack === "number") {
      const allowed = recentDayKeys(daysBack + 1);
      selected = files.filter((file) => allowed.has(file.key));
    }
    const out: LogMemoryEntry[] = [];
    for (const file of selected) {
      const text = await safeReadFile(file.path);
      if (text === null) {
        continue;
      }
      const entries = parseBlocks(text, { layer: "episodic" });
      for (const entry of entries) {
        if (!includeConsolidated && entry.payload.consolidatedAt) {
          continue;
        }
        out.push(entry);
      }
    }
    out.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return out;
  }

  async loadSemantic(): Promise<LogMemoryEntry[]> {
    const text = await safeReadFile(this.semanticPath());
    if (text === null) {
      return [];
    }
    return parseBlocks(text, { layer: "semantic" });
  }

  async loadAll(opts?: {
    daysBack?: number;
    includeConsolidated?: boolean;
  }): Promise<LogMemoryEntry[]> {
    const [episodic, semantic] = await Promise.all([this.loadEpisodic(opts), this.loadSemantic()]);
    return [...episodic, ...semantic];
  }

  async countByLayer(
    layer: LogMemoryLayer,
    opts?: { includeConsolidated?: boolean },
  ): Promise<number> {
    if (layer === "semantic") {
      const entries = await this.loadSemantic();
      return entries.length;
    }
    if (layer === "episodic") {
      const entries = await this.loadEpisodic({
        includeConsolidated: opts?.includeConsolidated,
      });
      return entries.length;
    }
    return 0;
  }

  async selectDreamCandidates(opts: {
    threshold: number;
    limit: number;
    now: Date;
  }): Promise<LogMemoryEntry[]> {
    // Already-consolidated entries are not eligible candidates.
    const entries = await this.loadEpisodic({ includeConsolidated: false });
    return entries
      .filter(
        (entry) => !entry.payload.pinned && computeCurrentDecay(entry, opts.now) < opts.threshold,
      )
      .slice(0, opts.limit);
  }

  // Non-destructive forgetting: stamp the consolidatedAt timestamp on each
  // matched entry and rewrite the daily file in place. Default reads will
  // hide the entry afterwards but the raw block stays on disk for audit /
  // replay (mirrors the promotedAt pattern in short-term-promotion.ts).
  async markConsolidated(ids: Iterable<string>, consolidatedAt: Date): Promise<number> {
    const idSet = new Set(ids);
    if (idSet.size === 0) {
      return 0;
    }
    const files = await this.listEpisodicFiles();
    let marked = 0;
    for (const file of files) {
      const text = await safeReadFile(file.path);
      if (text === null) {
        continue;
      }
      const entries = parseBlocks(text, { layer: "episodic" });
      let mutated = false;
      for (const entry of entries) {
        if (!idSet.has(entry.id) || entry.payload.consolidatedAt) {
          continue;
        }
        entry.payload.consolidatedAt = consolidatedAt;
        marked++;
        mutated = true;
      }
      if (!mutated) {
        continue;
      }
      const rewritten = entries.map((entry) => serializeEpisodicBlock(entry)).join("\n");
      await atomicWriteFile(file.path, rewritten);
    }
    return marked;
  }

  // Explicit cleanup escape hatch — parallel to `removeGroundedShortTermCandidates`
  // in short-term-promotion.ts. The dream cycle never calls this. Hosts can
  // invoke it from a separate retention job (e.g. drop entries older than 90d).
  async removeEpisodic(ids: Iterable<string>): Promise<number> {
    const idSet = new Set(ids);
    if (idSet.size === 0) {
      return 0;
    }
    const files = await this.listEpisodicFiles();
    let removed = 0;
    for (const file of files) {
      const text = await safeReadFile(file.path);
      if (text === null) {
        continue;
      }
      const entries = parseBlocks(text, { layer: "episodic" });
      const kept = entries.filter((entry) => {
        if (idSet.has(entry.id)) {
          removed++;
          return false;
        }
        return true;
      });
      if (kept.length === entries.length) {
        continue;
      }
      if (kept.length === 0) {
        await fs.rm(file.path, { force: true });
        continue;
      }
      const rewritten = kept.map((entry) => serializeEpisodicBlock(entry)).join("\n");
      await atomicWriteFile(file.path, rewritten);
    }
    return removed;
  }

  async recordAccess(id: string, now: Date): Promise<boolean> {
    const files = await this.listEpisodicFiles();
    for (const file of files) {
      const text = await safeReadFile(file.path);
      if (text === null) {
        continue;
      }
      const entries = parseBlocks(text, { layer: "episodic" });
      let mutated = false;
      for (const entry of entries) {
        if (entry.id !== id) {
          continue;
        }
        entry.payload.accessCount += 1;
        entry.payload.lastAccessedAt = now;
        mutated = true;
      }
      if (!mutated) {
        continue;
      }
      const rewritten = entries.map((entry) => serializeEpisodicBlock(entry)).join("\n");
      await atomicWriteFile(file.path, rewritten);
      return true;
    }
    return false;
  }

  async listEpisodicFiles(): Promise<Array<{ path: string; key: string }>> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch {
      return [];
    }
    const out: Array<{ path: string; key: string }> = [];
    for (const name of entries) {
      const m = DAY_FILE_RE.exec(name);
      if (!m) {
        continue;
      }
      out.push({ path: path.join(this.rootDir, name), key: m[1] });
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  }
}

function formatDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function recentDayKeys(count: number, now: Date = new Date()): Set<string> {
  const out = new Set<string>();
  const base = new Date(now);
  base.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    const day = new Date(base);
    day.setUTCDate(day.getUTCDate() - i);
    out.add(formatDayKey(day));
  }
  return out;
}

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function ensureLeadingBlankLine(filePath: string, block: string): string {
  // If the file already exists and doesn't end with a blank line, prepend one
  // so the next block's heading isn't fused onto the previous block's last
  // line. Append-mode writes happen frequently enough that we check fs sync.
  if (!fsSync.existsSync(filePath)) {
    return block;
  }
  try {
    const stat = fsSync.statSync(filePath);
    if (stat.size === 0) {
      return block;
    }
    // Cheap tail check: read the last 2 bytes.
    const fd = fsSync.openSync(filePath, "r");
    const buf = Buffer.alloc(2);
    const start = Math.max(0, stat.size - 2);
    fsSync.readSync(fd, buf, 0, 2, start);
    fsSync.closeSync(fd);
    const tail = buf.toString("utf8");
    if (tail.endsWith("\n\n") || tail === "\n\n") {
      return block;
    }
    if (tail.endsWith("\n")) {
      return `\n${block}`;
    }
    return `\n\n${block}`;
  } catch {
    return block;
  }
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

// ---------- vector helpers (kept on the module so other code can reuse) ----------

export function vectorNorm(vec: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  return Math.sqrt(sum);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array, normA?: number): number {
  if (a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let bSum = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    bSum += b[i] * b[i];
  }
  const aNorm = normA ?? vectorNorm(a);
  const bNorm = Math.sqrt(bSum);
  if (aNorm === 0 || bNorm === 0) {
    return 0;
  }
  return dot / (aNorm * bNorm);
}
