import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { MemoryPublicationFragment } from "./manager-publication-task.js";

const MEMORY_STAGE_BYTES = 32 * 1024 * 1024;
const OVERFLOW_READ_ROWS = 64;
let overflowTables = 0;

/**
 * One staged publication. Fragments stay in worker memory up to a budget; a larger
 * source moves to a connection-local TEMP table so its staging never grows with the worker heap.
 */
export class MemoryPublicationStage {
  private fragments: MemoryPublicationFragment[] = [];
  private bytes = 0;
  private overflow: { table: string; insert: StatementSync } | undefined;

  constructor(private readonly db: DatabaseSync) {}

  append(fragments: readonly MemoryPublicationFragment[]): void {
    if (this.overflow) {
      this.write(fragments);
      return;
    }
    for (const fragment of fragments) {
      this.fragments.push(fragment);
      this.bytes += fragment.json.length * 2;
    }
    if (this.bytes <= MEMORY_STAGE_BYTES) {
      return;
    }
    const name = `memory_publication_overflow_${++overflowTables}`;
    this.db.exec(
      `CREATE TEMP TABLE ${name} (ordinal INTEGER PRIMARY KEY, json TEXT NOT NULL, last INTEGER NOT NULL)`,
    );
    const table = `temp.${name}`;
    this.overflow = {
      table,
      insert: this.db.prepare(`INSERT INTO ${table} (json, last) VALUES (?, ?)`),
    };
    const held = this.fragments;
    this.fragments = [];
    this.bytes = 0;
    this.write(held);
  }

  *read(): Generator<MemoryPublicationFragment> {
    if (!this.overflow) {
      yield* this.fragments;
      return;
    }
    const select = this.db.prepare(
      `SELECT ordinal, json, last FROM ${this.overflow.table} WHERE ordinal > ? ORDER BY ordinal LIMIT ${OVERFLOW_READ_ROWS}`,
    );
    for (let cursor = 0; ;) {
      const rows = select.all(cursor);
      if (!rows.length) {
        return;
      }
      for (const row of rows) {
        cursor = Number(row.ordinal);
        yield { json: String(row.json), last: row.last === 1 };
      }
    }
  }

  close(): void {
    this.fragments = [];
    this.bytes = 0;
    const overflow = this.overflow;
    this.overflow = undefined;
    if (overflow && this.db.isOpen) {
      this.db.exec(`DROP TABLE IF EXISTS ${overflow.table}`);
    }
  }

  private write(fragments: readonly MemoryPublicationFragment[]): void {
    const { insert } = this.overflow!;
    for (const fragment of fragments) {
      insert.run(fragment.json, fragment.last ? 1 : 0);
    }
  }
}
