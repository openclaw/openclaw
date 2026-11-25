import type { DatabaseSync } from "node:sqlite";

export const WORKBOARD_SQLITE_STATE_PATH = "plugins/workboard/workboard.sqlite";

const cardChildren: ReadonlySet<string> = new Set([
  "workboard_card_artifacts",
  "workboard_card_attachments",
  "workboard_card_attempts",
  "workboard_card_comments",
  "workboard_card_diagnostics",
  "workboard_card_events",
  "workboard_card_labels",
  "workboard_card_links",
  "workboard_card_notifications",
  "workboard_card_proof",
  "workboard_worker_logs",
  "workboard_worker_protocol",
]);

/** Shared by the Workboard repair and the updater's read-only diagnosis. */
export function inspectWorkboardCardOrphans(database: DatabaseSync): {
  tables: string[];
  count: number;
} | null {
  const tables = new Map<string, bigint>();
  const violations = database.prepare("PRAGMA foreign_key_check");
  violations.setReadBigInts(true);
  let count = 0;
  for (const { table, parent, fkid, rowid } of violations.iterate()) {
    if (
      typeof table !== "string" ||
      !cardChildren.has(table) ||
      parent !== "workboard_cards" ||
      typeof fkid !== "bigint" ||
      typeof rowid !== "bigint"
    ) {
      return null;
    }
    if (!tables.has(table)) {
      const statement = database.prepare(`PRAGMA foreign_key_list("${table}")`);
      statement.setReadBigInts(true);
      const keys = statement.all().filter((key) => key.id === fkid);
      const key = keys[0];
      if (
        keys.length !== 1 ||
        key?.table !== "workboard_cards" ||
        key.from !== "card_id" ||
        key.to !== "id" ||
        key.on_delete !== "CASCADE" ||
        database
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?")
          .get(table)
      ) {
        return null;
      }
      tables.set(table, fkid);
    } else if (tables.get(table) !== fkid) {
      return null;
    }
    count += 1;
  }
  return { tables: [...tables.keys()].toSorted(), count };
}
