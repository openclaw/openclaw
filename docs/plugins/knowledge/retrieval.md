---
summary: "Knowledge keyword search, exact lookup, citations, index behavior, and structured date queries"
read_when:
  - You want to know how knowledge_grep ranks results or why a search returned nothing
  - You are querying Knowledge by date with the timeline or chronicle tools
  - You need to know which Knowledge SQLite state is rebuildable
title: "Knowledge retrieval and dates"
sidebarTitle: "Retrieval and dates"
---

Keyword search, exact identity lookup, and date queries. Part of the
[Knowledge plugin](/plugins/knowledge) guide.

Knowledge has no embeddings, remote search services, query expansion, answer
synthesis, or regex search. `knowledge_records` is the exhaustive inventory;
ranked search never proves that an inventory is complete.

## Query contract

| Operation or input            | Meaning                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `knowledge_grep({query})`     | FTS5/BM25 over title, aliases, and body; every word token must match                 |
| `mode: "any"`                 | Any word token may match                                                             |
| `mode: "phrase"`              | Word tokens in order and adjacent within one field                                   |
| `knowledge_lookup({query})`   | Exact ID, full title, or alias; returns `found`, `ambiguous`, or `missing`           |
| `kind`, `type`, `tag`         | Record kind, ontology type with alias expansion, exact case-sensitive tag            |
| `lifecycle`                   | `active` (default), `superseded`, or `all` (active plus superseded)                  |
| `limit`, `offset`             | 1–50 results (default 20), offset 0–500; follow `nextOffset` with unchanged filters  |
| `timeField`, `since`, `until` | Date filters applied before ranking; see [Dates and Chronicle](#dates-and-chronicle) |

Queries accept 1–64 word tokens within 500 characters. Punctuation separates
tokens; `OR`, `NOT`, column syntax, and quotes are not executed as FTS syntax.
Matching is case- and diacritic-insensitive. There is no stemming, prefix search,
or language-specific segmentation, so unsegmented CJK substrings may not match.

Exact lookup accepts up to 200 characters. IDs are case-sensitive; names and
aliases are normalized (NFKC, lowercase, trimmed, whitespace collapsed) but never
fuzzy-matched. Ambiguity is computed across all matches, not from one returned
hit.

Defaults cover all active saved records. Invalid and duplicate IDs, withdrawn
records, and records whose structured dependencies, endpoints, or entities are
unavailable are excluded in every mode. Authored prose without declared
dependencies cannot be redacted automatically.

## Results and citations

Each hit has a summary, lifecycle, matched fields, attribution and assertion
origin, and the stable ID, path, revision, and SHA-256 of the observed Markdown.

- Snippets are at most 480 UTF-16 characters with zero-based start/end offsets.
  Body snippets also carry one-based Markdown line ranges, counting frontmatter
  lines.
- At most three verified evidence locators are included. `evidenceTruncated`
  points to `knowledge_record` for more.
- For bodies over 64 KiB, the snippet is an opening excerpt, not the match
  location (`snippet.matchLocated: false`).
- Citation hashes identify the searched revision. Compare hashes before relying
  on a later read.

BM25 weights are title 8, aliases 6, body 1. Scores are positive and only
comparable within one query, filter set, and corpus snapshot. Scope and filters
are applied before corpus statistics, so other scopes cannot affect rank, counts,
or snippets.

## Index behavior

Markdown is authoritative. Each search first runs the scoped scan and
validation, then reconciles a per-scope FTS5 projection in the store's
`state.sqlite`. These tables are not shared with `memory-core` or other plugins.

- A publication receipt's `indexed: false` means indexing is pending until the
  next search, not a failed save.
- `index.state: "ready"` with `lag: false` means the projection matches this
  query's snapshot. Compare `snapshot` across pages and restart if it changes.
- `index.state: "unavailable"` with `total: null` is a failed retrieval. Retry;
  exact lookup and `knowledge_records` do not depend on FTS5.
- Authority, identity, publication-conflict, and scan-limit failures reject the
  operation instead of returning an empty or partial search.
- Validation issues set `coverage.complete: false`.

There is no background indexing worker.

### What is rebuildable

The `keyword_fts_v1_*` tables, `keyword_state_v1`, and the temporal tables are
projections. Missing tables or changed fingerprints are rebuilt on the next
query.

Do not drop `state.sqlite` to rebuild search. It also holds store identity,
receipts, history, Git checkpoints, session activity, and withdrawal and
supersession safeguards (`keyword_withdrawals_v1`, `lifecycle_guards_v1`). Those
safeguards stop a stale active file from resurrecting a withdrawn or superseded
record, and cannot be rebuilt from Markdown or Git.

## Dates and Chronicle

Knowledge projects validated structured dates and entity associations into
scoped SQLite tables. Each date query reconciles its authorized snapshot first.
Dates written only in page prose, such as older written Timeline bullets, do
not create structured records.

| Date field    | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `occurred_at` | When the event or statement happened. Meetings use `fields.occurred_at` |
| `recorded_at` | When the record was created in Knowledge                                |
| `updated_at`  | Authored modification time                                              |
| `due_at`      | Commitment deadline; never a scheduled action                           |

Unknown dates stay absent; recording time never stands in for occurrence. Bounds
accept a real `YYYY-MM-DD` or an ISO timestamp with seconds and an explicit time
zone. The host resolves relative dates. Bounds are inclusive, and a date-only
upper bound includes the whole UTC day. Date-only records match overlapping
ranges without claiming an exact instant.

| Tool                            | Use                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `knowledge_timeline`            | Dated records, optionally by entity, kind, `timeField`, range, order, eligibility, and `includeSources` |
| `knowledge_chronicle_day`       | One day, or its Monday–Sunday week. Timestamps use the requested IANA time zone (UTC default)           |
| `knowledge_chronicle_since`     | Occurrence-time range, oldest first. Not "recently imported"                                            |
| `knowledge_chronicle_last_seen` | Latest dated context for an entity at or before `occurredOnOrBefore` (default now)                      |

- To find recently recorded or updated records, query `knowledge_timeline` with
  `timeField: "recorded_at"` or `"updated_at"`. This is a current-record query,
  not a change cursor; use history for audit.
- `group: "source"` with an `entity` returns that entity's Timeline: one row per
  dated source connected to it by a relationship or a sourced claim, dated by
  the source. The row's `summary` is the body of the relationship between them
  (`noteRecord`), else the source's event claim, and `claims` counts the
  entity's claims from that source, and `links` lists the summary's links
  that resolve to a record in the same scope. Claims with no dated source, or dated
  outside their source's date, keep their own rows. It takes occurrence time only and no `kind` filter.
- A shared event claim with `source_event: true` represents its source meeting.
  On occurrence timelines it replaces the meeting page row; a `kind: "meeting"`
  query still returns the page.
- Entity filters use explicit `entities`, `owner`, endpoints, and source
  associations, not co-mentions.
- A mention does not prove attendance or contact. No match does not prove
  absence.
- `eligibility: "include_inactive"` adds superseded and expired assertions, never
  withdrawn ones. It is not a snapshot of what Knowledge knew at a past time.
- `includeSources: true` adds deduplicated source summaries within the same
  24 KiB response budget.
- Follow `nextOffset` with unchanged filters and the returned `snapshot`.

Query responses report `freshness.queriedAt`, `freshness.scannedAt`, and, for
keyword queries, `freshness.indexedAt`. An older `scannedAt` means the scan was
reused while files were unchanged, not that results are stale.
