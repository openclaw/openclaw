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

## Ontology

`knowledge_ontology` inspects the vocabulary of the effective store.

| Task                 | Input                                                           | Output                                                                      |
| -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Discover vocabulary  | `{}`                                                            | Catalog: names, labels, kinds, descriptions, aliases, record counts         |
| Prepare a page write | `{"view":"definitions","name":"project"}`                       | Structured fields, allowed values, filing, endpoint constraints, provenance |
| Browse a kind        | `{"kind":"page","limit":20}`                                    | Filtered catalog with `nextOffset`                                          |
| See examples         | `{"view":"definitions","name":"project","includeRecords":true}` | Up to 20 record summaries per type with `recordsTruncated`                  |
| List source files    | `{"view":"sources"}`                                            | Authorized source paths, validity, and size                                 |
| Read one manifest    | `{"view":"sources","sourcePath":"ontology.yaml"}`               | The selected YAML, 12,000 characters by default                             |
| Diagnose activation  | `{"view":"diagnostics"}`                                        | Paginated issues and inheritance chain                                      |

Definitions default to 10 per page; other views to 50. `limit` accepts 1–100.
Follow `nextOffset` with unchanged view and filters, and compare fingerprints
across definition pages. Source text offsets count characters (`maxChars`
256–65,536). Raw YAML is for debugging a manifest; normal authoring uses
`definitions`. See [Records and ontology](/plugins/knowledge/records-and-ontology).

## Reading records

`knowledge_record({id})` returns body text, identity, revision and hash,
lifecycle, attribution, validation issues, and compact structured metadata. It
does not return raw Markdown, full frontmatter, evidence, or connected records
unless asked.

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

`knowledge_evidence_read({id, path, sha256})` reads a retained source passage as
UTF-8 text, with optional `startLine`/`endLine`. It returns a verified source
hash and range plus `nextCursor`; continue with the same id, path, and hash until
`nextCursor` is `null`. `maxChars` is 256–3,000 (default 3,000). Each call
re-authorizes and re-verifies the source. Binary sources use
`knowledge_attachment`. A source aggregated from a related claim must be read
through that claim's ID.

## Listing and connections

`knowledge_records` is the exhaustive, paginated inventory. It filters by kind,
ontology type or alias, and ID/title/alias substring. Default listing covers
current eligible records; `lifecycle: "all"` requests historical and invalid
records too. `includeCards` adds bounded claim text; `includeEndpoints` adds
relationship endpoint summaries.

`knowledge_connections({id})` returns compact identities, directions, typed
endpoints, and uncertainty. `view: "full"` adds record details and up to three
evidence references; `includeCards: true` with full view adds claim prose.

| Direction              | Meaning                                              |
| ---------------------- | ---------------------------------------------------- |
| `incoming`, `outgoing` | Typed, evidenced relationships                       |
| `dependents`           | Records that declare this record as a dependency     |
| `claims`               | Claims that name this page as an entity or owner     |
| `links`                | Markdown links authored in this record               |
| `backlinks`            | Derived reverse links; not proof of an authored link |

Connections return 20 rows by default, at most 100, within a 24 KiB response.
Follow `nextOffset` with unchanged filters and compare `snapshot`.
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
default 20), `offset`, and `lifecycle` (`active`, `superseded`, or `all`).
`index.state: "unavailable"` with `total: null` is a failed retrieval, not zero
matches. See [Retrieval and dates](/plugins/knowledge/retrieval).

For bodies over 64 KiB, search previews are opening excerpts rather than located
matches (`snippet.matchLocated: false`). Open the record to inspect content.

## Remembering claims

`knowledge_remember` is the cheap path for discrete claims from a conversation.
One call takes a short `attribution`, the supporting conversation `excerpt` (at
most 16 KiB), and 1–20 `items`. Each item has `text`, a claim `kind`, an
optional `subject`, an optional `about`, an `origin` of `source` (default) or
`user_belief`, and optional dates. Agent inference is rejected.

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
can grow to 5,000,000 UTF-8 bytes.

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

- `knowledge_save_page` and `knowledge_resume` return publication status
  separately from `git: {state, commit?, message}`. A `published` receipt is a
  successful save even when Git is `pending` or `unavailable`.
- A receipt's `indexed: false` means keyword indexing is pending until the next
  search.
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
