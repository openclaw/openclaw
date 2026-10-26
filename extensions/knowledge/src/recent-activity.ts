import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { Static } from "typebox";
import { claimCard } from "./claim-card.js";
import type { LoadedRecord } from "./model.js";
import type { RecentInput, RecentItem, RecentOutput } from "./recent.js";
import { recordSummary } from "./record-summary.js";
import { withinBudget, compactSummary } from "./response-budget.js";
import type { StorageTables } from "./storage-tables.js";

/** SQL value json_extract yields for a JSON value: containers stay JSON text. */
function extracted(value: unknown): string | number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return typeof value === "string" || typeof value === "number" ? value : JSON.stringify(value);
}
// One object member, or undefined when the value is not an object.
const jsonMember = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key] // SAFETY: a non-array object is checked above.
    : undefined;
const firstPresent = (...values: unknown[]) =>
  values.map(extracted).find((value) => value !== null) ?? null;
// json_extract yields INTEGER for whole JSON numbers; node:sqlite binds every number as REAL.
const integerClass = (value: string | number | null) =>
  typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value;
// TEXT-affinity columns store extracted numbers as their text.
const firstText = (...values: unknown[]) => {
  const value = firstPresent(...values);
  return value === null ? null : String(value);
};

/** Recent projection rows for one published mutation: one per published record. */
function projectRequest(scope: string, request: string, plan: unknown, receipt: unknown) {
  const listed = jsonMember(plan, "records") ?? [jsonMember(plan, "record") ?? null];
  const records = (Array.isArray(listed) ? listed : [listed]).map((r: unknown, ordinal) => {
    const metadata = jsonMember(r, "metadata");
    return {
      scope,
      request,
      ordinal,
      id: firstText(jsonMember(r, "id")),
      hash: firstText(jsonMember(r, "hash")),
      revision: integerClass(firstPresent(jsonMember(r, "revision"))),
      actor: firstText(jsonMember(plan, "actor")),
      kind: firstText(jsonMember(r, "kind")),
      type: firstText(
        jsonMember(metadata, "claim_kind"),
        jsonMember(metadata, "type"),
        jsonMember(r, "kind"),
      ),
      title: firstText(jsonMember(r, "title")),
    };
  });
  const receiptText = (key: string) => firstText(jsonMember(receipt, key));
  return {
    records,
    request: {
      scope,
      request,
      operation: receiptText("operation"),
      target_id: receiptText("targetId"),
      at: receiptText("at"),
      reason: receiptText("reason"),
      replacement_id: receiptText("replacementId"),
    },
  };
}

/** Bring the recent_* projection in line with this scope's published mutations.
 * Plans are parsed once per request, not on every read; the key comparisons
 * stop before the plan column. A projection written before an older plugin
 * version published (or removed) requests is repaired here. */
function syncRecentProjection(db: DatabaseSync, scope: string) {
  const published = "SELECT request FROM mutations WHERE scope=? AND state='published'";
  const fresh = `FROM mutations m WHERE m.scope=? AND m.state='published' AND NOT EXISTS (SELECT 1 FROM recent_requests_v1 r WHERE r.scope=m.scope AND r.request=m.request)`;
  const missing = db.prepare(`SELECT 1 ${fresh} LIMIT 1`).get(scope);
  const stale = db
    .prepare(
      `SELECT 1 FROM recent_requests_v1 r WHERE r.scope=? AND r.request NOT IN (${published}) LIMIT 1`,
    )
    .get(scope, scope);
  if (!missing && !stale) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    if (stale) {
      for (const table of ["recent_requests_v1", "recent_records_v1"]) {
        db.prepare(`DELETE FROM ${table} WHERE scope=? AND request NOT IN (${published})`).run(
          scope,
          scope,
        );
      }
    }
    const kysely = getNodeSqliteKysely<StorageTables>(db);
    for (const row of db.prepare(`SELECT m.request, m.plan, m.receipt ${fresh}`).all(scope)) {
      const projected = projectRequest(
        scope,
        String(row.request),
        JSON.parse(String(row.plan)),
        JSON.parse(String(row.receipt)),
      );
      for (const record of projected.records) {
        executeSqliteQuerySync(db, kysely.insertInto("recent_records_v1").values(record));
      }
      executeSqliteQuerySync(db, kysely.insertInto("recent_requests_v1").values(projected.request));
    }
  });
}

/** One logical recent event: a published correction/withdrawal or a history snapshot. */
type RecentEvent = {
  sequence: number;
  id: string;
  at: string;
  change: string;
  kind: string | null;
  type: string | null;
  reason: string | null;
  replacementId: string | null;
  title: string | null;
};
const isLifecycleEvent = (change: string) => change === "corrected" || change === "withdrawn";
const nullableText = (value: SQLOutputValue | undefined) =>
  value === null || value === undefined ? null : String(value);

/** Group visible events by source, newest first, as the Recent "by source" view pages them. */
function groupBySource(
  events: RecentEvent[],
  sourceIds: Record<string, string>,
  sourceId: string | undefined,
  before: number,
  limit: number,
) {
  // Only the newest event per record (or per lifecycle event) represents it.
  const seen = new Set<string>();
  const groups = new Map<string, RecentEvent[]>();
  for (const event of events) {
    const partition = isLifecycleEvent(event.change)
      ? `event:${event.sequence}`
      : `record:${event.id}`;
    if (seen.has(partition)) {
      continue;
    }
    seen.add(partition);
    const source = sourceIds[event.id];
    const key = isLifecycleEvent(event.change)
      ? `event:${event.sequence}`
      : event.change === "external"
        ? `external:${event.id}`
        : source !== undefined
          ? `source:${source}`
          : `record:${event.id}`;
    if (sourceId === undefined || key === `source:${sourceId}`) {
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
  }
  return [...groups.values()]
    .filter((members) => members[0]!.sequence < before)
    .toSorted((a, b) => b[0]!.sequence - a[0]!.sequence)
    .slice(0, limit)
    .map((members) => ({ row: members[0]!, members }));
}

/** Project exact published snapshots into logical events BEFORE cursor paging.
 * No timestamp heuristics or independently paginated receipt/history merging.
 * Earlier snapshots of inactive/dependency-hidden records stay in history only.
 */
export function recentActivity(
  db: DatabaseSync,
  scope: string,
  active: LoadedRecord[],
  input: Static<typeof RecentInput>,
  fixtureIds: string[] = [],
): Static<typeof RecentOutput> {
  const upperSequence =
    input.upperSequence ??
    Number(
      db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM history WHERE scope=?").get(scope)!.n,
    );
  const byId = new Map(active.map((r) => [r.id, r]));
  const sourceIds = Object.fromEntries(
    active
      .map((r) => [
        r.id,
        r.kind === "page" && ["meeting", "source"].includes(r.type) ? r.id : r.metadata.source_page,
      ])
      .filter(([, id]) => typeof id === "string" && byId.has(id)),
  );
  syncRecentProjection(db, scope);
  // Reuse this history join in both event branches. The projection holds the
  // plan and receipt fields, so no publication plan is parsed per read. Record
  // eligibility is applied while streaming, newest first.
  const statement = db.prepare(`
    WITH published AS MATERIALIZED (
      SELECT p.request, q.operation, q.target_id, q.at, q.reason, q.replacement_id, p.id AS record_id, p.kind, p.type, p.title,
        (SELECT MIN(h.sequence) FROM history h WHERE h.scope=p.scope
          AND h.id=p.id AND h.hash=p.hash AND h.revision=p.revision AND h.provenance=p.actor) AS sequence
      FROM recent_records_v1 p JOIN recent_requests_v1 q ON q.scope=p.scope AND q.request=p.request
      WHERE p.scope=?
    ), plain AS MATERIALIZED (
      -- Sequence sets for the history branch. Joining history to the wide
      -- published rows scanned every published record per history event.
      SELECT sequence FROM published WHERE sequence IS NOT NULL AND operation IS NULL
    ), any_published AS MATERIALIZED (
      SELECT sequence FROM published WHERE sequence IS NOT NULL
    ), events AS (
      SELECT MAX(sequence) AS sequence, target_id AS id, at,
        CASE operation WHEN 'correct' THEN 'corrected' ELSE 'withdrawn' END AS change,
        MAX(CASE WHEN record_id=target_id THEN kind END) AS kind,
        MAX(CASE WHEN record_id=target_id THEN type END) AS type,
        reason, replacement_id AS replacementId,
        MAX(CASE WHEN record_id=target_id THEN title END) AS title
      FROM published WHERE operation IN ('correct','withdraw') GROUP BY request
      UNION ALL
      SELECT h.sequence, h.id, h.at,
        CASE WHEN h.sequence IN (SELECT sequence FROM plain) THEN CASE h.revision WHEN 1 THEN 'created' ELSE 'updated' END
          WHEN h.provenance='external-edit' THEN 'external' ELSE 'observed' END AS change,
        NULL, NULL, NULL, NULL, NULL
      FROM history h
      WHERE h.scope=? AND h.provenance!='conversion'
        AND (h.sequence IN (SELECT sequence FROM plain) OR h.sequence NOT IN (SELECT sequence FROM any_published))
    )
    SELECT * FROM events WHERE sequence<=? AND sequence<? ORDER BY sequence DESC
  `);
  const fixtures = new Set(fixtureIds);
  const limit = (input.limit ?? 20) + 1,
    before = input.beforeSequence ?? upperSequence + 1;
  const visible: RecentEvent[] = [];
  // Grouping ranks every visible event; the flat list stops at its page.
  for (const row of statement.iterate(
    scope,
    scope,
    upperSequence,
    input.groupBySource ? upperSequence + 1 : before,
  )) {
    const event: RecentEvent = {
      sequence: Number(row.sequence),
      id: String(row.id),
      at: String(row.at),
      change: String(row.change),
      kind: nullableText(row.kind),
      type: nullableText(row.type),
      reason: nullableText(row.reason),
      replacementId: nullableText(row.replacementId),
      title: nullableText(row.title),
    };
    if (fixtures.has(event.id) || (!isLifecycleEvent(event.change) && !byId.has(event.id))) {
      continue;
    }
    visible.push(event);
    if (!input.groupBySource && visible.length === limit) {
      break;
    }
  }
  const rows: { row: RecentEvent; members?: RecentEvent[] }[] = input.groupBySource
    ? groupBySource(visible, sourceIds, input.sourceId, before, limit)
    : visible.map((row) => ({ row }));
  const items = rows.slice(0, input.limit ?? 20).map(({ row, members }) => {
    // Newest member first: it supplies the row, and later counts iterate in this order.
    const current = byId.get(row.id);
    const item: RecentItem = {
      sequence: row.sequence,
      id: row.id,
      at: row.at,
      kind: row.kind ?? current!.kind,
      type: row.type ?? current!.type,
      // SAFETY: the recent query emits only the RecentOutput change labels.
      change: row.change as RecentItem["change"],
    };
    if (item.change === "corrected" || item.change === "withdrawn") {
      // Identify the historical item under an explicit lifecycle label, without
      // resurfacing its body or evidence as current knowledge.
      if (row.title) {
        item.title = row.title;
      }
      if (row.reason) {
        item.reason = row.reason;
      }
      if (row.replacementId) {
        item.replacementId = row.replacementId;
        item.replacementActive = byId.has(item.replacementId);
        const replacement = byId.get(item.replacementId);
        if (replacement) {
          item.title = replacement.title;
        }
      }
    } else if (current) {
      item.title = current.title;
      if (current.metadata.identity) {
        item.identityStatus = current.metadata.identity.status;
      }
    }
    const sourceId = sourceIds[item.id],
      source = sourceId ? byId.get(sourceId) : undefined;
    if (members && source && !["corrected", "withdrawn", "external"].includes(item.change)) {
      const records = members
        .map((m) => byId.get(m.id))
        .filter((r): r is LoadedRecord => Boolean(r));
      const counts: Record<string, number> = {};
      const attendees = new Set<string>();
      for (const record of records) {
        if (record.metadata.label === "attended" && record.metadata.to === source.id) {
          attendees.add(record.metadata.from!);
        } else {
          const kind = record.metadata.source_event
            ? "sourceEvent"
            : record.kind === "page"
              ? "page"
              : record.type;
          counts[kind] = (counts[kind] ?? 0) + 1;
        }
      }
      if (attendees.size) {
        counts.attendees = attendees.size;
      }
      item.group = {
        source: recordSummary(source),
        total: records.length,
        counts,
        records: records.slice(input.recordOffset ?? 0, (input.recordOffset ?? 0) + 20).map((r) =>
          Object.assign(
            recordSummary(r),
            {
              change: members.find((member) => member.id === r.id)?.change ?? "observed",
            },
            r.kind === "claim" ? { card: claimCard(r, active) } : {},
          ),
        ),
        truncated: records.length > (input.recordOffset ?? 0) + 20,
        nextRecordOffset:
          records.length > (input.recordOffset ?? 0) + 20 ? (input.recordOffset ?? 0) + 20 : null,
        firstSaved: members.at(-1)!.at,
        lastSaved: members[0]!.at,
      };
      if (input.includeEndpoints) {
        const ids = new Set(
          item.group.records.flatMap((r) => (r.kind === "relationship" ? [r.from, r.to] : [])),
        );
        item.group.endpoints = active.filter((r) => ids.has(r.id)).map(recordSummary);
      }
    }
    return item;
  });
  const bounded: RecentItem[] = [];
  const response = (entries: RecentItem[]) => ({
    items: entries,
    upperSequence,
    nextBefore: rows.length > entries.length ? entries.at(-1)!.sequence : null,
  });
  for (const item of items) {
    // Do not shrink later groups to fill the page: resume them intact on Older.
    if (!withinBudget(response([...bounded, item])) && bounded.length) {
      break;
    }
    const group = item.group;
    if (group) {
      while (!withinBudget(response([item])) && group.records.length > 1) {
        group.records.pop();
        group.truncated = true;
        group.nextRecordOffset = (input.recordOffset ?? 0) + group.records.length;
        if (group.endpoints) {
          const ids = new Set(
            group.records.flatMap((r) => (r.kind === "relationship" ? [r.from, r.to] : [])),
          );
          group.endpoints = group.endpoints.filter((r) => ids.has(r.id));
        }
      }
      if (!withinBudget(response([item]))) {
        // A single unusually rich record still needs to be reachable. Return its
        // clickable summary; full content and evidence remain on record detail.
        group.source = compactSummary(group.source);
        group.records = group.records.map(({ card: _card, ...record }) => compactSummary(record));
        if (group.endpoints) {
          group.endpoints = group.endpoints.map(compactSummary);
        }
      }
    }
    if (!withinBudget(response([item]))) {
      throw new Error(
        "Recent activity summary exceeds the response budget; open the record from Browse.",
      );
    }
    bounded.push(item);
  }
  return response(bounded);
}
