import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { Check } from "typebox/value";
import { type ChronicleOutput, TimelineInput, DayInput } from "./chronicle-contract.js";
import { reconcileChronicle, chronologicalIds } from "./chronicle-index.js";
import { mergeRedirects } from "./merge.js";
import type { LoadedRecord } from "./model.js";
import { queryFreshness } from "./query-freshness.js";
import { eligible } from "./retrieval.js";
import {
  calendarDay,
  dateInterval,
  recordDate,
  sameTemporalDate,
  shiftDay,
  type TimeField,
  timeBounds,
} from "./temporal-query.js";
import { digest, type SampleVault } from "./vault.js";

type Snapshot = Awaited<ReturnType<SampleVault["scan"]>>;

/** Render a compact source-addressable temporal result without exposing raw frontmatter. */
function item(
  record: LoadedRecord,
  field: TimeField,
  visible: Set<string>,
): ChronicleOutput["items"][number] {
  const date = recordDate(record, field)!;
  return {
    record: reference(record, visible),
    date,
    dateField: field,
    precision: date.length === 10 ? "day" : "instant",
    summary: truncateUtf16Safe(record.body.trim(), 1000),
    entities: (record.metadata.entities ?? []).filter((id) => visible.has(id)),
    ...(record.metadata.source_page && visible.has(record.metadata.source_page)
      ? { sourcePage: record.metadata.source_page }
      : {}),
    evidenceCount: record.metadata.evidence?.length ?? 0,
  };
}

/** Lifecycle and replacement identities are filtered through the same authorized result set. */
function reference(record: LoadedRecord, visible: Set<string>) {
  const { id, title, path, kind, type, revision, hash, lifecycle } = record;
  const replacement = record.metadata.superseded_by;
  return {
    id,
    title,
    path,
    kind,
    type,
    revision,
    hash,
    lifecycle,
    ...(replacement && visible.has(replacement) ? { supersededBy: replacement } : {}),
    ...(record.metadata.expires_at ? { expiresAt: record.metadata.expires_at } : {}),
  };
}

/** Validate a day/week query and compare timestamp calendar days in the requested zone. */
function dayPredicate(input: DayInput): (value: string) => boolean {
  dateInterval(input.date);
  if (input.date.length !== 10) {
    throw new Error("date must be YYYY-MM-DD.");
  }
  // Construct even for an empty result, so invalid zones never masquerade as no matches.
  calendarDay(input.date, input.timezone);
  const weekday = new Date(input.date).getUTCDay();
  const first = input.week ? shiftDay(input.date, -(weekday + 6) % 7) : input.date;
  const last = input.week ? shiftDay(first, 6) : first;
  return (value) => {
    const day = calendarDay(value, input.timezone);
    return day >= first && day <= last;
  };
}

/** Query one authoritative scoped snapshot through its rebuildable SQLite date index. */
export function chronicle(
  db: DatabaseSync,
  data: Snapshot,
  binding: string,
  requested: TimelineInput,
  withdrawn = new Set<string>(),
  onDay?: DayInput,
): ChronicleOutput {
  const records = eligible(data, withdrawn, requested.eligibility === "include_inactive");
  // An entity filter naming a merged page asks about the page it was merged into.
  const merged = mergeRedirects(data.records).get(requested.entity ?? "");
  const input =
    merged && !withdrawn.has(requested.entity!) ? { ...requested, entity: merged } : requested;
  const byId = new Map(records.map((r) => [r.id, r])),
    visible = new Set(byId.keys());
  const predicate = onDay ? dayPredicate(onDay) : undefined;
  const field = input.timeField ?? "occurred_at";
  let { snapshot, ids } = runSqliteImmediateTransactionSync(db, () => ({
    snapshot: reconcileChronicle(db, records, binding),
    ids: chronologicalIds(db, binding, input),
  }));
  // A cursor belongs to both a source snapshot and a particular query.
  snapshot = digest(
    JSON.stringify([
      snapshot,
      field,
      input.entity ?? null,
      input.kind ?? null,
      input.since ?? null,
      input.until ?? null,
      input.order ?? "desc",
      input.eligibility ?? "current",
      input.includeSources ?? false,
      onDay ? [onDay.date, onDay.week ?? false, onDay.timezone ?? "UTC"] : null,
    ]),
  );
  if (input.snapshot && input.snapshot !== snapshot) {
    throw new Error("Knowledge changed; restart temporal pagination without offset or snapshot.");
  }
  if (input.entity && (!byId.has(input.entity) || byId.get(input.entity)!.kind !== "page")) {
    ids = [];
  }
  // Group only explicit representations of the same source event with an identical date.
  // Dated claims about other events remain separate even when sourced from that meeting.
  const candidates = ids
    .map((id) => byId.get(id)!)
    .filter((r) => r && (!input.kind || r.type === input.kind));
  const represented = new Set(
    candidates
      .filter(
        (r) =>
          r.metadata.source_event &&
          r.metadata.source_page &&
          sameTemporalDate(
            recordDate(r, field),
            byId.has(r.metadata.source_page)
              ? recordDate(byId.get(r.metadata.source_page)!, field)
              : undefined,
          ),
      )
      .map((r) => r.metadata.source_page!),
  );
  const matched = candidates.filter(
    (r) =>
      (field !== "occurred_at" || !represented.has(r.id)) &&
      (!predicate || predicate(recordDate(r, field)!)),
  );
  const offset = input.offset ?? 0,
    limit = input.limit ?? 20;
  const result: ChronicleOutput = {
    items: [],
    total: matched.length,
    offset,
    nextOffset: null,
    snapshot,
    freshness: queryFreshness(data.checkedAt),
    ...(input.includeSources ? { sources: [] } : {}),
    coverage: {
      complete: data.issues.length === 0,
      message:
        "Structured dated records only; undated records and Markdown-only timeline bullets are not inferred. Source dates retain their precision. " +
        (data.issues.length
          ? "Some authorized source material has validation issues; inspect diagnostics."
          : ""),
    },
  };
  // Admit each row together with its source summary and final continuation metadata.
  for (const record of matched.slice(offset, offset + limit)) {
    const row = item(record, field, visible);
    const sources = result.sources ? [...result.sources] : undefined;
    const source = row.sourcePage
      ? byId.get(row.sourcePage)
      : record.kind === "page"
        ? record
        : undefined;
    if (sources && source && !sources.some((r) => r.id === source.id)) {
      sources.push(reference(source, visible));
    }
    const count = result.items.length + 1;
    const candidate = {
      ...result,
      items: [...result.items, row],
      ...(sources ? { sources } : {}),
      nextOffset: offset + count < matched.length ? offset + count : null,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > 24 * 1024) {
      if (!result.items.length) {
        throw new Error("Temporal record exceeds response budget; inspect the record directly.");
      }
      break;
    }
    result.items = candidate.items;
    result.nextOffset = candidate.nextOffset;
    if (sources) {
      result.sources = sources;
    }
  }
  return result;
}

/** An operator can inspect an unprovisioned store without creating its files or database. */
export function emptyChronicle(input: TimelineInput, onDay?: DayInput): ChronicleOutput {
  if (!Check(TimelineInput, input) || (onDay && !Check(DayInput, onDay))) {
    throw new Error("Invalid temporal query input.");
  }
  timeBounds(input);
  if (onDay) {
    dayPredicate(onDay);
  }
  const snapshot = digest(
    JSON.stringify([
      "unprovisioned",
      { ...input, offset: undefined, limit: undefined, snapshot: undefined },
      onDay,
    ]),
  );
  if (input.snapshot && input.snapshot !== snapshot) {
    throw new Error("Knowledge changed; restart temporal pagination without offset or snapshot.");
  }
  return {
    items: [],
    total: 0,
    offset: input.offset ?? 0,
    nextOffset: null,
    snapshot,
    freshness: queryFreshness(new Date().toISOString()),
    ...(input.includeSources ? { sources: [] } : {}),
    coverage: {
      complete: true,
      message: "This store has not been provisioned; no dated records are available.",
    },
  };
}
