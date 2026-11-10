---
summary: "Knowledge agent tools: inputs, defaults, pagination, response limits, remembering, structured authoring, and attachments"
read_when:
  - You are calling knowledge_* tools directly or writing a skill that uses them
  - You need the pagination, limit, or response-budget rules for Knowledge reads
  - You are authoring claims, relationships, or page edits through tools
title: "Knowledge tools"
sidebarTitle: "Tools"
---

Reference for the `knowledge_*` agent tools. Part of the
[Knowledge plugin](/plugins/knowledge) guide.

Every tool acts on the calling agent's effective store and authorized partition.
Tools take no store, agent, path, or scope argument. The Control UI and the tools
use the same typed service and access checks.
When Knowledge is enabled, its declared tools are included in the built-in
`coding` and `full` tool profiles. This does not enable other plugins or
override explicit tool denies, narrower policies, or Knowledge store access.

## Agent response shapes

Agent tool calls return what an agent needs most of the time. The Control UI,
operator inspection, and commands always receive the complete response.

- **List rows** (connections, records, search, lookup, timeline) carry the
  record ID, revision, and the first 16 characters of its hash. Pages add title
  and type; claims add kind, one day (occurrence, else recorded), their text
  without HTML comments (`truncated: true` past 4,000 characters), linked page
  titles, and source page; relationships add
  `from` and `to`. `lifecycle` and `assertionOrigin` appear only when not
  `active` or `source`.
- **Single records** (`knowledge_record`) return the full hash, the body or claim
  text, aliases, non-empty domain fields, and linked pages. `maxChars` bounds
  the whole response by shortening the text window; follow `nextOffset`.
- **Write receipts** return the record `id`, new `revision` and full `hash`,
  and the `ontologyFingerprint` the next write needs. `state` and `message`
  appear only when the receipt is not `published`; changed `items`, `impact`,
  and a page `budget` appear when present. `knowledge_mutation` returns the
  complete receipt.
- `nextOffset` appears only while another page remains, and `snapshot` only
  when paging (including the last page); coverage appears only when incomplete.

Ask for the complete response with `detail: "full"` on `knowledge_record`,
`knowledge_grep`, `knowledge_lookup`, `knowledge_records`,
`knowledge_timeline`, the `knowledge_chronicle_*` tools, `knowledge_ontology`,
`knowledge_status`, and `knowledge_verify`, and with `view: "full"` on
`knowledge_connections`. On `knowledge_record`, `metadataView: "full"`,
`includeEvidence`, `includeReferences`, and `view: "raw"` add only the
metadata, evidence, connected rows and links, or raw Markdown they name.

Every write fence (`expectedHash`) accepts the full hash or a lowercase prefix of
at least 16 characters, so a list row's hash fences a write directly; the
revision must still match. Shorter prefixes are rejected. The fence protects
against concurrent and external edits to one record selected by ID, not against
forged content, so 64 bits of the content hash are enough.

## Ontology

`knowledge_ontology` inspects the vocabulary of the effective store.

| Task                 | Input                                                           | Output                                                                      |
| -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Discover vocabulary  | `{}`                                                            | Catalog: names, kinds, descriptions, and the fingerprint writes need        |
| Prepare a page write | `{"view":"definitions","name":"project"}`                       | Structured fields, allowed values, filing, endpoint constraints, provenance |
| Browse a kind        | `{"kind":"page","limit":20}`                                    | Filtered catalog with `nextOffset`                                          |
| See examples         | `{"view":"definitions","name":"project","includeRecords":true}` | Up to 20 record summaries per type with `recordsTruncated`                  |
| List source files    | `{"view":"sources"}`                                            | Authorized source paths, validity, and size                                 |
| Read one manifest    | `{"view":"sources","sourcePath":"ontology.yaml"}`               | The selected YAML, 12,000 characters by default                             |
| Diagnose activation  | `{"view":"diagnostics"}`                                        | Paginated issues and inheritance chain                                      |

Definitions default to 10 per page; other views to 50. `limit` accepts 1–100.
Follow `nextOffset` with unchanged view and filters, and compare fingerprints
across definition pages. Source text offsets count UTF-16 code units (`maxChars`
256–65,536). Pages preserve surrogate pairs and may stop one unit before the cap;
use the returned `nextOffset`. An offset inside a surrogate pair is refused.
Raw YAML is for debugging a manifest; normal authoring uses `definitions`.
See [Records and ontology](/plugins/knowledge/records-and-ontology).

## Reading records

`knowledge_record({id})` returns the ID, revision, full hash, and lifecycle when
not active. Pages add title, type, aliases, non-empty domain fields, and the
body; claims add kind, date, text, linked pages, source, owner, and attribution.
Validation issues, partial identity, supersession, and merge redirects appear
when present. `maxChars` (default 12,000) bounds the whole response; follow
`nextOffset` with `offset`. The options below add only what they name;
`detail: "full"` returns the complete response, where `content.nextOffset`
continues the body window.

| Option                              | Effect                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `view: "summary"`                   | Omit body text; inspect identity and state.                                                   |
| `view: "raw"`                       | Original Markdown instead of the body.                                                        |
| `metadataView: "compact"` (default) | Associations, dates, endpoints, aliases, domain fields, uncertainty; no evidence descriptors. |
| `metadataView: "full"`              | Complete frontmatter as an object.                                                            |
| `metadataView: "none"`              | No structured metadata.                                                                       |
| `includeEvidence: true`             | Verified citation locators and excerpts. `maxEvidenceChars` 0–20,000 (default 4,000).         |
| `evidenceOffset`, `evidenceLimit`   | Page citations: 20 by default, up to 100 per response. Follow `nextEvidenceOffset`.           |
| `includeReferences: true`           | Connected summaries, 20 per page (`referenceLimit` 1–100). Follow `nextReferenceOffset`.      |
| `offset`, `maxChars`                | Page body or raw text, 12,000 characters by default. Follow `content.nextOffset`.             |

Complete record responses are limited to 24 KiB of JSON. Pages may be shorter
than requested; always use the returned continuation offsets. Material excluded
to fit is named in `omitted`. Compare hashes across chunks and restart if the
record changes. Never replace a page from an incomplete body. Missing or
duplicate IDs return `record: null`. The legacy `includeMetadata` selector
cannot be combined with `metadataView`.

Timeline summaries, claim cards, related statements, and evidence excerpts preserve
UTF-16 surrogate pairs. A preview may stop one unit before its cap; later source
lines do not fill that gap.

`knowledge_evidence_read({id, path, sha256})` reads a retained source passage as
UTF-8 text, with optional `startLine`/`endLine`. It returns the passage text and
its line range, plus `nextCursor` while more remains; continue with the same id,
path, and hash until no `nextCursor` is returned. `maxChars` is 256–3,000 (default 3,000). Each call
re-authorizes and re-verifies the source. Binary sources use
`knowledge_attachment`. A source aggregated from a related claim must be read
through that claim's ID.

## Listing and connections

`knowledge_records` is the exhaustive, paginated inventory. It filters by kind,
ontology type or alias, and ID/title/alias substring. Default listing covers
current eligible records; `lifecycle: "all"` requests historical and invalid
records too. Claims list their title as text; `includeCards` adds their bounded
card text, linked pages, and source. `includeEndpoints` adds relationship
endpoints.

`knowledge_connections({id})` returns one row per connection: its direction
plus the [list row](#agent-response-shapes) of the connected record. Claim rows
include their text, so a page's claims need no extra options. `view: "full"`
returns complete record summaries and up to three evidence references;
`includeCards: true` with full view adds claim card metadata.

| Direction              | Meaning                                              |
| ---------------------- | ---------------------------------------------------- |
| `incoming`, `outgoing` | Typed, evidenced relationships                       |
| `dependents`           | Records that declare this record as a dependency     |
| `claims`               | Claims that name this page as an entity or owner     |
| `links`                | Markdown links authored in this record               |
| `backlinks`            | Derived reverse links; not proof of an authored link |

Connections return 20 rows by default, at most 100, within a 24 KiB response.
Follow `nextOffset` with unchanged filters and compare `snapshot`, which is
returned while more pages remain.
`historical: true` includes superseded records, never withdrawn ones.

Browse and Recent bound responses by bytes and nested values, not just row count.
Oversized cards come back as navigable summaries; read them with
`knowledge_record`.

## Search and lookup

- `knowledge_grep({query})` ranks titles, aliases, and bodies with SQLite FTS5.
  Modes are `all` (default), `any`, and `phrase`; there is no regex or raw FTS
  syntax.
- `knowledge_lookup({query})` resolves an exact ID, full title, or alias and
  returns `found`, `ambiguous`, or `missing`. Never treat the first ambiguous hit
  as the identity.

Both default to active records and accept `kind`, `type`, `tag`, `limit` (1–50,
default 10 for agents and 20 otherwise), `offset`, and `lifecycle` (`active`,
`superseded`, or `all`). Agent search hits are list rows with a short snippet
(claims omit the title their text repeats); lookup hits are list rows without a
snippet. `index.state: "unavailable"` with `total: null` is a failed retrieval,
not zero matches. An active `knowledge_grep` also returns the current
replacement of a matching superseded record, after direct matches, with `via`
naming the earlier record (`detail: "full"` adds `matches: ["superseded"]`). See
[Retrieval and dates](/plugins/knowledge/retrieval#superseded-wording).

For bodies over 64 KiB, search previews are opening excerpts rather than located
matches (`snippet.matchLocated: false`). Open the record to inspect content.

## Remembering claims

`knowledge_remember` is the cheap path for discrete claims from a conversation.
One call takes a short `attribution`, the supporting conversation `excerpt` (at
most 16 KiB), and 1–20 `items`. Each item has `text`, a claim `kind`, an
optional `subject`, an optional `about`, an `origin` of `source` (default) or
`user_belief`, and optional dates. Agent inference is rejected.

Retry an interrupted remember with the same request ID and identical input. If
an identical retry reports a payload mismatch after an upgrade, inspect its
mutation receipt and use `knowledge_resume` for the accepted request's original
ID. Do not create a replacement request.

`about` is the saver's own description of what the claim concerns, such as
`"bundled plugin hot reload, PR #180466"`. It needs no lookup and does not have
to match a page. It is stored on the claim as `subject_hint`.

```json
{
  "requestId": "00000000-0000-4000-8000-000000000020",
  "attribution": "user in openclaw session 8f3a, 2026-10-19",
  "excerpt": "User: use option B, it ships sooner.",
  "items": [
    {
      "text": "Chose option B because it ships sooner.",
      "kind": "decision",
      "subject": "Garden Pilot"
    }
  ]
}
```

The server:

1. Resolves each subject by exact lookup (page ID, title, or alias; active pages;
   merge redirects followed). A unique match links the claim. An ambiguous or
   missing subject saves it unlinked and reports `ambiguous` or `missing`.
2. Infers an omitted subject from `about`, then the text: the whole hint or one of
   its comma- or semicolon-separated parts may name the page exactly. Otherwise
   the hint or the text must name exactly one entity page (person,
   company, concept, project, or deal) and no other name competes. Sentence
   openers, role terms, and bare first names are not guessed. `infer_subject:
   false` turns this off for one item.
3. Returns `duplicate` with the existing ID for an exact repeat: same normalized
   text, kind, and linked subjects.
4. Retains the excerpt as `artifacts/<requestId>/excerpt.txt` and cites it from
   every inserted claim.
5. Publishes the inserted claims as one batch with one receipt.

It never creates a page or rewrites page prose. Claims saved unlinked can be
linked later by [maintenance](/plugins/knowledge/maintenance).

## Pages and body edits

`knowledge_save_page` creates or edits a page. Edits need the existing `id`,
`expectedRevision`, and `expectedHash`. `aliases`, `tags`, and `dependencies`
(at most 100 each) and `fields` replace their collections when supplied; an empty
collection clears, and omission preserves. Unknown authored frontmatter survives.

`knowledge_edit_body` changes one range of an active page body without
resending it:

- Read the relevant content windows with a consistent hash first.
- Supply `expectedVaultId`, `expectedRevision`, `expectedHash`,
  `expectedOntologyFingerprint`, the record ID, a new request UUID, and a reason.
- `start` is inclusive and `end` exclusive, in UTF-16 offsets over the full body
  (not frontmatter). Equal offsets insert; an empty replacement deletes. There is
  no fuzzy matching or rebasing.
- Each call publishes a complete revision. Incremental appends are not a cheap
  bulk upload; use attachments for long originals.

A single body or replacement is limited to 48,000 characters. A complete record
can grow to 5,000,000 UTF-8 bytes, but page bodies have a smaller
[budget](#page-budgets).

## Page budgets

A page is read in full whenever an agent works on something connected to it, so
page prose is budgeted by read cost. Sizes count body characters (UTF-16 code
units, as `knowledge_record` windows do), not frontmatter.

| Page      | Budget                                                      |
| --------- | ----------------------------------------------------------- |
| Hub       | 12,000 characters: one default `knowledge_record` body read |
| Any other | 24,000 characters: two default reads                        |

A page's **degree** is the number of distinct current pages it links to or that
link to it with wikilinks or Markdown links. Typed relationships and claims do
not count: a hub is a page other prose routes through, not one with many facts.
A page is a hub when all of these hold within its store partition:

- Its degree is at or above `pageBudgets.hubPercentile` (default 90, the top
  tenth) among current pages, measured as the share of pages with a lower degree.
- The partition has at least 20 current pages. Below that, one page spans five or
  more percentile points.
- Its degree is at least 10, so a small or sparsely linked vault has no hubs.

The rule is the same for every page-body write: `knowledge_save_page` creates and
edits, `knowledge_edit_body`, `knowledge_publish_batch` page items,
`knowledge_merge` with a combined `body`, and the destination of
`knowledge_extract_section`. It is checked once, against the same vault snapshot
the publication is fenced on:

- A write that makes a body **larger than before and larger than its budget** is
  rejected. Nothing is saved and no receipt is stored.
- A write that keeps a body the same size or smaller always succeeds, even on a
  page already over budget. Oversized pages can be cleaned up and corrected, but
  never grow; no migration is needed.
- Claims, relationships, `knowledge_remember`, corrections, annotations,
  withdrawals, `knowledge_unmerge`, recall approval and evidence reconciliation
  are never limited: none of them grows a page body. A fact can always be saved as
  a claim when page prose is rejected.
- Markdown edited directly on disk is observed, not gated; the next tool write
  to that page follows the rule above.

A rejection is a normal result with `state: "rejected"`. Its `id`, `path`,
`revision` and `hash` describe the unchanged target (empty for a page that
would have been created), `message` says what to do, and `budget.pages` lists
each page that would exceed its budget:

| Field                            | Meaning                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `currentChars`, `attemptedChars` | Body size before and after the rejected write                                                                             |
| `budgetChars`                    | The page's budget                                                                                                         |
| `hub`                            | `hub`, `degree`, `percentile`, and the `hubPercentile`, `minPages` and `minDegree` used                                   |
| `sections`                       | Up to six largest heading sections: `heading`, `level`, `start`/`end` offsets, size, subsection count                     |
| `sections[].candidates`          | Up to three existing pages connected to this one that the section links to or names, with their remaining `headroomChars` |

Sections come from the current body (`sectionsOf: "current"`), or from the
attempted body for a create. Reduce the page by moving content, not by deleting
it: extract a section to a listed candidate it is about, or to a new page, and
retry with fresh fences. Replaying a rejected request ID evaluates it again.

### Extract a section

`knowledge_extract_section` moves one heading section to another page in a
single revision-fenced publication:

```json
{
  "requestId": "<new UUID>",
  "expectedVaultId": "<observed vault UUID>",
  "expectedOntologyFingerprint": "<ontology fingerprint>",
  "source": { "id": "<page ID>", "expectedRevision": 89, "expectedHash": "<hash>" },
  "sectionStart": 41230,
  "destination": { "title": "OpenClaw release process", "type": "project" },
  "summary": "Releases are cut weekly from main; details moved to their own page.",
  "reason": "OpenClaw is over its page budget."
}
```

- `sectionStart` is the UTF-16 offset of the heading line, from a rejection's
  `sections` or a fresh full read. The section runs to the next heading of the
  same or a higher level.
- `destination` is either `{title, type, aliases?}` for a new page, or the
  `{id, expectedRevision, expectedHash}` of an existing page connected to the
  source by a body link (either way) or a typed relationship. The section is
  appended to an existing page's body.
- The section moves verbatim. Links are read in the complete source and
  destination pages. Relative inline Markdown links are rewritten for the
  destination's directory, and only inside the parsed link: code, escaped text
  and every other byte stay as written. Any link that would lead elsewhere in the
  complete destination rejects the request: for example a reference-style link
  whose definition stays on the source, or a destination that ends inside an open
  code block. Write such links as inline or `[[id|label]]` links first. Source-page evidence whose quote, retained path or filename
  appears in the section is copied to the destination; add more with
  `evidence`. The source keeps all of its evidence.
- The source keeps the heading line, followed by `summary` and a link to the
  destination (`[[<id>|<title>]]`).
- Claims the section links to that name the source page as an entity get the
  destination as their first entity and keep all their existing entities,
  including the source. Whether the source is still a subject is your call:
  remove it explicitly with `knowledge_annotate` `entities` when it is not.
  Claim text, evidence and lifecycle are unchanged.
- Every changed record is validated together, and the destination is checked to
  contain the section with the same link targets, before the publication is
  accepted. Any failure leaves every file unchanged. The destination's own budget
  applies. Previous revisions stay in history.

The receipt has `operation: "extract"`, `targetId` set to the source page, and
`items` for the destination and the source.

## Claims and relationships

Before authoring:

1. Read `knowledge_status` and `knowledge_ontology`; keep the vault ID and the
   ontology `fingerprint`. Resolve existing pages.
2. Retain source bytes with `knowledge_attach`, or reuse evidence from an
   authorized record. Use only locators and quotes verified against the source.
3. Publish with a new UUID per genuinely new write. Replay the exact request
   and payload after an uncertain outcome.

```json
{
  "requestId": "<new UUID>",
  "expectedVaultId": "<observed vault UUID>",
  "expectedOntologyFingerprint": "<ontology fingerprint>",
  "title": "Release commitment",
  "body": "Alex committed to delivering the release on Friday.",
  "claim_kind": "commitment",
  "assertion_origin": "source",
  "attribution": "Alex, meeting transcript line 12",
  "entities": ["<project page ID>"],
  "dependencies": ["<meeting page ID>"],
  "owner": "<resolved person page ID>",
  "due_at": "2026-09-25",
  "evidence": [
    {
      "path": "<retained artifact path>",
      "sha256": "<observed hash>",
      "start_line": 12,
      "end_line": 12
    }
  ]
}
```

- Claim kinds: `fact`, `preference`, `decision`, `commitment`, `event`, `belief`.
  Origins: `source`, `user_belief`, `agent_inference`. Omit unknown owners and
  dates.
- `knowledge_create_relationship` uses the same controls plus `from`, `to`, an
  ontology `label`, and optional ontology `fields`. The backend enforces endpoint
  constraints. The same endpoint pair can carry several independently evidenced
  relationships.
- `knowledge_annotate` adds revision-fenced metadata (source page, identity
  uncertainty, attribution confidence, continuity links, fixture classification,
  or extra evidence) without changing assertion text or lifecycle.
- Creates never overwrite an assertion. Use
  [corrections](/plugins/knowledge/corrections) for lifecycle changes.

A reused request ID with a changed payload or operation is rejected.
Publication is not semantic truth, extraction completeness, deduplication, or
task scheduling.

## Attachments

`knowledge_attach` retains original source bytes. Send sequential base64 chunks
of at most 48 KiB decoded, with a stable request UUID, filename, media type,
attribution, byte offset, and `final` flag. The chunk size bounds each call, not
the file. Retry identical chunks after an interruption. The completed receipt
returns `evidence`; append it with `knowledge_save_page` `attachments`.

`knowledge_attachment({id, path, sha256, offset})` downloads an original
referenced by an authorized record, in chunks of at most 32 KiB decoded. Follow
`nextOffset` until it is `null`. No tool accepts an arbitrary host path. See
[Evidence files](/plugins/knowledge/evidence).

## Receipts, history, and recovery

An accepted publication has durable intent and recovery material. A request
rejected before acceptance, including a stale revision or hash, creates no draft
or receipt; read the current record, reconcile, and submit a new request.

- Agent write receipts omit `state` when it is `published` and include
  `git: {state, message}` only when the local Git checkpoint is `pending` or
  `unavailable`. A `published` receipt is a successful save even then.
- A complete receipt (`knowledge_mutation`, `knowledge_history`) also has
  `requestId`, `path`, `at`, the Git commit, and `indexed: false`, which
  means keyword indexing is pending until the next search.
- `knowledge_history` lists scoped receipts and revisions with a
  `git: {state, pending, message}` summary.
- `knowledge_revision` returns a bounded window of a retained revision; continue
  with the same sequence and returned offset.
- `knowledge_mutation` inspects recovery material. Use `includeFiles: false` for
  receipt-only checks. Files page 3 at a time; use `contentField` (`before`,
  `proposed`, or `displaced`) and `charOffset` to continue one text field.
- `knowledge_resume` resumes an interrupted publication or retries its Git
  checkpoint with the original request ID. It never overwrites a conflict.

## Ingestion and dates

- `knowledge_publish_batch`, `knowledge_verify`, and `knowledge_source_check`:
  see [Ingestion workflows](/plugins/knowledge/ingestion).
- `knowledge_timeline` and the `knowledge_chronicle_*` tools: see
  [Retrieval and dates](/plugins/knowledge/retrieval#dates-and-chronicle).

## Live state

The Control UI subscribes to change events that contain no record data or
paths. Filesystem watches coalesce hints; authorized scans do the reconciliation
and Git checkpointing. Reconnect, manual refresh, and a 30-second fallback on a
visible page request fresh snapshots. Open views coalesce hints into one
refresh per 750 ms quiet period, at most 3 seconds after the first hint.
Status reports the private-partition watcher as `live`: `watching`,
`unavailable`, or `stopped`. Conversation partitions reconcile on demand.
