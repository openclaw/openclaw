import type { TimelineInput } from "./chronicle-contract.js";
import type { LoadedRecord } from "./model.js";
import { dateInterval, recordDate } from "./temporal-query.js";

/** One derived entity Timeline row: a dated source, or a dated claim with no dated source. */
type SourceRow = {
  record: LoadedRecord;
  date: string;
  summary: string;
  /** The entity's claims from this source; absent on a claim's own row. */
  claims?: number;
  note?: LoadedRecord;
  /** The record whose body is the summary; its links resolve from its own path. */
  author?: LoadedRecord;
};

type Group = {
  source: LoadedRecord;
  note?: LoadedRecord;
  event?: LoadedRecord;
  claims: LoadedRecord[];
};

// Prefer a current note with a body, then any current note, then an inactive one.
const noteRank = (record: LoadedRecord) =>
  (record.lifecycle === "active" &&
  !(record.metadata.expires_at && Date.parse(record.metadata.expires_at) <= Date.now())
    ? 2
    : 0) + (record.body.trim() ? 1 : 0);

/** Source grouping answers one entity's occurrence Timeline; reject inputs it cannot honor. */
export function assertSourceGrouping(input: TimelineInput) {
  if (
    input.group &&
    (!input.entity || input.kind || (input.timeField ?? "occurred_at") !== "occurred_at")
  ) {
    throw new Error(
      'group: "source" needs an entity and occurrence time, and does not take a kind filter.',
    );
  }
}

/**
 * Derive an entity's Timeline from records instead of page prose. A relationship
 * between the entity and a page makes that page a source and supplies the row's
 * note; a claim naming the entity joins the group of its source page, where a
 * source-event claim dates the row and stands in for a missing note. The row
 * date is the source's own occurrence date, else its source-event date, found
 * by source even when that claim does not name the entity. Claims
 * from an undated source, dated claims without one, and claims dated outside
 * the row's date (a past event a later source reports) stay individual rows.
 * Current notes win over superseded or expired ones.
 * `associated` must be in a stable order so the chosen note is deterministic.
 */
export function sourceRows(
  entity: string,
  associated: readonly LoadedRecord[],
  byId: ReadonlyMap<string, LoadedRecord>,
): SourceRow[] {
  const groups = new Map<string, Group>();
  const group = (source: LoadedRecord) => {
    let found = groups.get(source.id);
    if (!found) {
      found = { source, claims: [] };
      groups.set(source.id, found);
    }
    return found;
  };
  const standalone: LoadedRecord[] = [];
  for (const record of associated) {
    const m = record.metadata;
    if (record.kind === "relationship") {
      const other = m.from === entity ? m.to : m.to === entity ? m.from : undefined;
      const page = other && other !== entity ? byId.get(other) : undefined;
      if (page?.kind === "page") {
        const found = group(page);
        // The first current relationship with a written body is the note; an empty one still links.
        if (noteRank(record) > (found.note ? noteRank(found.note) : -1)) {
          found.note = record;
        }
      }
      continue;
    }
    if (record.kind !== "claim" || !m.entities?.includes(entity)) {
      continue;
    }
    const source = m.source_page && m.source_page !== entity ? byId.get(m.source_page) : undefined;
    if (!source) {
      standalone.push(record);
    } else if (m.source_event) {
      group(source).event ??= record;
    } else {
      group(source).claims.push(record);
    }
  }
  // A source's event claim dates it for every entity, including ones the claim does not list.
  let events: Map<string, LoadedRecord> | undefined;
  const eventOf = (source: LoadedRecord) => {
    if (!events) {
      events = new Map();
      for (const record of byId.values()) {
        const isEvent = record.kind === "claim" && record.metadata.source_event;
        if (isEvent && record.metadata.source_page && !events.has(record.metadata.source_page)) {
          events.set(record.metadata.source_page, record);
        }
      }
    }
    return events.get(source.id);
  };
  const rows: SourceRow[] = [];
  for (const found of groups.values()) {
    const { source, note, claims } = found;
    const event = found.event ?? (recordDate(source, "occurred_at") ? undefined : eventOf(source));
    const date = recordDate(source, "occurred_at") ?? (event && recordDate(event, "occurred_at"));
    if (!date) {
      standalone.push(...claims);
      continue;
    }
    // A claim keeps its own row when its date falls outside the row's date.
    const row = dateInterval(date);
    const own = claims.filter((claim) => {
      const at = recordDate(claim, "occurred_at");
      if (!at) {
        return false;
      }
      const span = dateInterval(at);
      return span.end < row.start || span.start > row.end;
    });
    standalone.push(...own);
    const counted = claims.length - own.length;
    const author = note?.body.trim() ? note : event?.body.trim() ? event : undefined;
    rows.push({
      record: source,
      date,
      summary: author?.body.trim() ?? "",
      claims: counted,
      ...(note ? { note } : {}),
      ...(author ? { author } : {}),
    });
  }
  for (const claim of standalone) {
    const date = recordDate(claim, "occurred_at");
    if (date) {
      rows.push({ record: claim, date, summary: claim.body.trim(), author: claim });
    }
  }
  return rows;
}
