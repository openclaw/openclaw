import type { DatabaseSync } from "node:sqlite";
import { Type, type Static } from "typebox";
import { text, type LoadedRecord } from "./model.js";

/** Host provenance only; never accepted as tool input or used as authority. */
export type ActivityOrigin = {
  sessionKey: string;
  sessionId: string;
  toolCallId: string;
  operation: string;
  at: string;
};
export const SessionActivityInput = Type.Object(
  {
    sessionKey: text(512),
    sessionId: text(128),
    before: Type.Optional(Type.Integer({ minimum: 1 })),
    upper: Type.Optional(Type.Integer({ minimum: 0 })),
    filter: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);
export const SessionActivityOutput = Type.Object(
  {
    upper: Type.Integer({ minimum: 0 }),
    nextBefore: Type.Union([Type.Integer(), Type.Null()]),
    items: Type.Array(
      Type.Object(
        {
          sequence: Type.Integer(),
          at: text(40),
          operation: text(80),
          action: Type.Union([Type.Literal("read"), Type.Literal("write")]),
          id: text(96),
          title: text(200),
          kind: text(40),
          type: text(64),
          revision: Type.Integer(),
          toolCallId: text(512),
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
  },
  { additionalProperties: false },
);
export type ActivityInput = Static<typeof SessionActivityInput>;
export type ActivityOutput = Static<typeof SessionActivityOutput>;

export function appendActivity(
  db: DatabaseSync,
  scope: string,
  agent: string,
  origin: ActivityOrigin,
  action: "read" | "write",
  records: { id: string; revision: number }[],
) {
  // Retried tool calls record each record revision once.
  const insert = db.prepare(`INSERT INTO session_activity
    (scope,agent_id,session_key,session_id,call_id,operation,action,at,record_id,revision) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT DO NOTHING`);
  for (const r of records) {
    insert.run(
      scope,
      agent,
      origin.sessionKey,
      origin.sessionId,
      origin.toolCallId,
      origin.operation,
      action,
      origin.at,
      r.id,
      r.revision,
    );
  }
}
export function sessionActivity(
  db: DatabaseSync,
  scope: string,
  agent: string,
  active: LoadedRecord[],
  input: ActivityInput,
): ActivityOutput {
  const args = [scope, agent, input.sessionKey, input.sessionId];
  const upper =
    input.upper ??
    Number(
      db
        .prepare(
          `SELECT COALESCE(MAX(sequence),0) n FROM session_activity WHERE scope=? AND agent_id=? AND session_key=? AND session_id=?`,
        )
        .get(...args)!.n,
    );
  const byId = new Map(active.map((r) => [r.id, r]));
  const limit = input.limit ?? 40,
    items: ActivityOutput["items"] = [];
  // Scan bounded chunks until one extra eligible item; pagination never leaks hidden counts/titles.
  let before = input.before ?? upper + 1;
  for (;;) {
    const rows = db
      .prepare(
        `SELECT * FROM session_activity WHERE scope=? AND agent_id=? AND session_key=? AND session_id=? AND sequence<=? AND sequence<? AND (? IS NULL OR action=?) ORDER BY sequence DESC LIMIT 200`,
      )
      .all(...args, upper, before, input.filter ?? null, input.filter ?? null);
    if (!rows.length) {
      return { upper, items, nextBefore: null };
    }
    for (const row of rows) {
      before = Number(row.sequence);
      const r = byId.get(String(row.record_id));
      if (!r) {
        continue;
      }
      if (items.length === limit) {
        return { upper, items, nextBefore: items.at(-1)!.sequence };
      }
      items.push({
        sequence: before,
        at: String(row.at),
        operation: String(row.operation),
        // SAFETY: appendActivity writes only the read and write actions.
        action: row.action as "read" | "write",
        id: r.id,
        title: r.title.slice(0, 200),
        kind: r.kind,
        type: r.type,
        revision: Number(row.revision),
        toolCallId: String(row.call_id),
      });
    }
  }
}

/** Only actual returned record summaries, never input IDs or arbitrary body text. */
export function returnedRecords(value: unknown): { id: string; revision: number }[] {
  const records = new Map<string, { id: string; revision: number }>();
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 6) {
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        visit(item, depth + 1);
      }
      return;
    }
    // SAFETY: v is a non-null object, checked above.
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string" && Number.isInteger(o.revision)) {
      // SAFETY: Number.isInteger above proves revision is a number.
      records.set(o.id, { id: o.id, revision: o.revision as number });
    }
    for (const key of [
      "record",
      "records",
      "hits",
      "matches",
      "items",
      "references",
      "endpoints",
      "relatedStatements",
      "last",
      "sources",
    ]) {
      visit(o[key], depth + 1);
    }
  };
  visit(value, 0);
  return [...records.values()];
}
