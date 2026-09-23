import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { retainCodexCatalogRow } from "./session-catalog-index-order.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import {
  CODEX_CATALOG_MAX_ROWS,
  CODEX_CATALOG_MAX_STATE_KEY_BYTES,
  detachCodexCatalogString,
} from "./session-catalog-limits.js";
import { MAX_CWD_LENGTH, parseCatalogPage } from "./session-catalog-parsing.js";
import type { CodexSessionCatalogPage } from "./session-catalog-types.js";

export const CODEX_CATALOG_STATE_NAMESPACE = "session-catalog-resident";
export type StoredCodexCatalogEntry =
  | { version: 1; kind: "complete"; overflow?: true }
  | { version: 1; kind: "row"; row: CodexCatalogIndexRow };
export type CodexCatalogState = Pick<
  PluginStateKeyedStore<StoredCodexCatalogEntry>,
  "entries" | "register" | "delete"
>;

/** Durable metadata never asserts that a native process is still running. */
export function codexCatalogMetadataPage(page: CodexSessionCatalogPage): CodexSessionCatalogPage {
  return {
    sessions: page.sessions.map(({ status: _status, activeFlags: _flags, ...session }) => ({
      ...session,
      status: "notLoaded",
    })),
  };
}

function readStoredCodexCatalogRow(value: unknown): CodexCatalogIndexRow | undefined {
  if (!isRecord(value) || value.version !== 1 || value.kind !== "row" || !isRecord(value.row)) {
    return undefined;
  }
  const row = value.row;
  if (
    typeof row.threadId !== "string" ||
    !row.threadId ||
    row.threadId.length > 256 ||
    typeof row.archived !== "boolean" ||
    typeof row.nativeMetadata !== "boolean" ||
    (row.preview !== undefined && (typeof row.preview !== "string" || row.preview.length > 500)) ||
    (row.sourceOrder !== undefined &&
      (typeof row.sourceOrder !== "number" || !Number.isSafeInteger(row.sourceOrder))) ||
    (row.rolloutPath !== undefined &&
      (typeof row.rolloutPath !== "string" || row.rolloutPath.length > MAX_CWD_LENGTH)) ||
    !(
      row.updatedAt === null ||
      (typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt))
    ) ||
    !(
      row.recencyAt === null ||
      (typeof row.recencyAt === "number" && Number.isFinite(row.recencyAt))
    )
  ) {
    return undefined;
  }
  try {
    const page = parseCatalogPage(row.page);
    if (
      page.sessions.length > 1 ||
      page.sessions.some((session) => session.threadId !== row.threadId)
    ) {
      return undefined;
    }
    const fingerprint =
      isRecord(row.fingerprint) &&
      typeof row.fingerprint.mtimeMs === "number" &&
      Number.isFinite(row.fingerprint.mtimeMs) &&
      typeof row.fingerprint.size === "number" &&
      Number.isFinite(row.fingerprint.size)
        ? { mtimeMs: row.fingerprint.mtimeMs, size: row.fingerprint.size }
        : undefined;
    return {
      threadId: detachCodexCatalogString(row.threadId),
      updatedAt: row.updatedAt,
      recencyAt: row.recencyAt,
      archived: row.archived,
      nativeMetadata: row.nativeMetadata,
      page: codexCatalogMetadataPage(page),
      ...(typeof row.preview === "string"
        ? { preview: detachCodexCatalogString(row.preview) }
        : {}),
      ...(typeof row.sourceOrder === "number" ? { sourceOrder: row.sourceOrder } : {}),
      ...(typeof row.rolloutPath === "string"
        ? { rolloutPath: detachCodexCatalogString(row.rolloutPath) }
        : {}),
      ...(fingerprint ? { fingerprint } : {}),
    };
  } catch {
    return undefined;
  }
}

/** An incomplete cache cannot prove which native rows precede an issued cursor. */
async function readCodexCatalogSnapshot(state: CodexCatalogState | undefined) {
  const entries = (await state?.entries()) ?? [];
  const rows = new Map<string, CodexCatalogIndexRow>();
  const keys = new Map<string, string>();
  const obsolete = new Set<string>();
  let cleanupIncomplete = false;
  let valid = true;
  const discard = (key: string) => {
    if (obsolete.has(key)) {
      return;
    }
    if (
      (key === "complete" ||
        obsolete.size - Number(obsolete.has("complete")) < CODEX_CATALOG_MAX_ROWS) &&
      Buffer.byteLength(key) <= CODEX_CATALOG_MAX_STATE_KEY_BYTES
    ) {
      obsolete.add(detachCodexCatalogString(key));
    } else {
      cleanupIncomplete = true;
      obsolete.add("complete");
    }
  };
  let complete = false;
  let overflow = false;
  for (const entry of entries) {
    if (Buffer.byteLength(entry.key) > CODEX_CATALOG_MAX_STATE_KEY_BYTES) {
      valid = false;
      discard(entry.key);
      continue;
    }
    if (entry.value?.version === 1 && entry.value.kind === "complete") {
      complete = true;
      overflow ||= entry.value.overflow === true;
      continue;
    }
    const row = readStoredCodexCatalogRow(entry.value);
    if (row) {
      const evicted = retainCodexCatalogRow(rows, row);
      if (evicted) {
        discard(evicted === row ? entry.key : keys.get(evicted.threadId)!);
        keys.delete(evicted.threadId);
      }
      if (evicted !== row) {
        keys.set(row.threadId, detachCodexCatalogString(entry.key));
      }
    } else {
      valid = false;
      discard(entry.key);
    }
  }
  complete &&= valid;
  if (!complete) {
    rows.clear();
    for (const entry of entries) {
      discard(entry.key);
    }
    if (entries.length) {
      obsolete.add("complete");
    }
  }
  return { rows: [...rows.values()], complete, overflow, obsolete, cleanupIncomplete };
}

/** Serializes reconstructible cache writes without blocking resident queries. */
export class CodexCatalogPersistence {
  private readonly pending = new Map<string, StoredCodexCatalogEntry | undefined>();
  private writing: Promise<void> | undefined;
  private failed = false;
  private retired = false;

  invalidate(error: unknown): void {
    if (!this.failed) {
      this.report(error);
    }
    this.failed = true;
    this.queue("complete", undefined);
  }

  constructor(
    private readonly state: CodexCatalogState | undefined,
    private readonly report: (error: unknown) => void,
  ) {}

  hasActiveWork(): boolean {
    return this.writing !== undefined || this.pending.size > 0;
  }

  async readSnapshot() {
    await this.drain();
    return await readCodexCatalogSnapshot(this.state);
  }

  private key(threadId: string): string {
    return `thread:${createHash("sha256").update(threadId).digest("hex")}`;
  }

  put(row: CodexCatalogIndexRow): void {
    if (!this.state || this.retired) {
      return;
    }
    this.queue(this.key(row.threadId), { version: 1, kind: "row", row });
  }

  remove(threadId: string): void {
    this.queue(this.key(threadId), undefined);
  }

  async pruneObsolete(
    keys: Iterable<string>,
    currentRows: Iterable<CodexCatalogIndexRow>,
  ): Promise<void> {
    const currentKeys = new Set(Array.from(currentRows, (row) => this.key(row.threadId)));
    for (const key of keys) {
      if (!currentKeys.has(key)) {
        this.queue(key, undefined);
      }
    }
    await this.drain();
  }

  async finishHydration(overflow = false): Promise<void> {
    await this.drain();
    if (!this.failed) {
      this.queue("complete", {
        version: 1,
        kind: "complete",
        ...(overflow ? { overflow: true } : {}),
      });
      await this.drain();
    }
  }

  private async drain(): Promise<void> {
    while (this.writing) {
      await this.writing;
    }
  }

  retire(): Promise<void> {
    this.retired = true;
    return this.drain();
  }

  private queue(key: string, value: StoredCodexCatalogEntry | undefined): void {
    // Failure cleanup joins an admitted drain without reopening retired persistence.
    if (
      !this.state ||
      (this.retired && (!this.writing || key !== "complete" || value !== undefined))
    ) {
      return;
    }
    if (
      key !== "complete" &&
      !this.pending.has(key) &&
      this.pending.size - Number(this.pending.has("complete")) >= CODEX_CATALOG_MAX_ROWS
    ) {
      this.invalidate(new Error("Codex catalog persistence queue reached its resident row limit"));
      return;
    }
    this.pending.set(key, value);
    this.writing ??= this.writePending();
  }

  private async writePending(): Promise<void> {
    try {
      await nextTurn();
      for (const [key, value] of this.pending) {
        this.pending.delete(key);
        try {
          // Bound state operations retain authority for already-admitted shutdown work.
          if (value) {
            await this.state!.register(key, value);
          } else {
            await this.state!.delete(key);
          }
        } catch (error) {
          if (!this.failed) {
            this.invalidate(error);
          }
        }
      }
    } finally {
      // New work can arrive before this promise's settlement callbacks run.
      this.writing = undefined;
    }
  }
}
