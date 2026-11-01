---
name: knowledge-recall
description: Find and answer from saved Knowledge vault pages with source citations. Use for questions about stored documents, meetings, people, or projects; not for recalling conversation history or searching the web.
---

# Recall saved knowledge

Read [shared conventions](references/conventions.md). This workflow is read-only.

1. Search with `knowledge_grep({query})`, including for named people, projects
   and pages whose exact stored identity is not already known: literal words, `all` by
   default; try a concise variant, `any`, or `phrase` when useful. No embeddings,
   regex, graph traversal or server-side synthesis is available. Narrow by
   ontology type/kind when appropriate; use `knowledge_records` and pagination
   for an inventory, not a ranked search pretending to be exhaustive.
2. Use `knowledge_lookup({query})` only for an already-known exact record ID,
   full title or declared alias. It does not perform keyword search. If it returns
   `missing`, fall back to `knowledge_grep` before concluding no relevant record
   exists. Preserve `ambiguous` as ambiguity and inspect candidates rather than
   choosing one.
3. Inspect relevant hits with `knowledge_record`. Read enough context to support
   the answer. Compact metadata is included by default; request
   `includeEvidence: true` for source locators, excerpts and attribution support,
   and `metadataView: "full"` for arbitrary domain fields. Connections default
   to compact identities/endpoints/uncertainty; request `view: "full"` only for
   richer metadata/evidence, and `includeCards: true` with full view for prose.
   Follow body/evidence/connection pagination as needed. Compare the hit's
   citation hash/revision to the readback. Restart on changes rather than combine
   incompatible revisions. Use `includeReferences` only for declared structured
   connections; prose links do not populate that list automatically.
4. Answer from the retrieved passages. In Control UI chat, cite readable titles
   linked to the dedicated Knowledge record page using the shared conventions'
   chat-link contract. Retain relevant source locators and propagate original
   evidence, not only the generated summary. Label
   synthesis and disagreements. Use lifecycle history filters explicitly for
   historical questions; do not present superseded material as current.
5. Distinguish no matches from inaccessible, invalid, incomplete or failed reads.
   Follow result offsets with unchanged filters and, for keyword search, compare
   `index.snapshot`. If an API pagination bound prevents exhausting results,
   narrow the query or state the coverage limit. Do not claim the vault lacks
   something solely because a short ranked list did not contain it.

Recall itself is read-only. If the selected Knowledge memory policy calls for
remembering genuinely new durable information, use `knowledge-capture` separately.
Do not re-save retrieved summaries as new evidence or enrich entities merely
because they appeared in an answer.

## Temporal questions

Use knowledge_chronicle_day for a day/week, knowledge_chronicle_since for an
occurrence range, knowledge_timeline for an entity's dated records or a chosen
timeField (group: "source" gives the entity's Timeline: one row per dated
source with its note, filtered by the source's date; claims dated apart from
their source keep their own rows), and knowledge_chronicle_last_seen for latest dated context. Resolve
an entity to a stable page ID first. Dated mentions do not prove attendance.
For keyword/inventory queries add since/until and timeField to knowledge_grep
or knowledge_records. occurred_at answers when something happened; recorded_at
and updated_at answer when records were created/changed. Never substitute one
for the other. Resolve relative query dates with the user's timezone, preserving
explicit offsets; day queries accept an IANA timezone. Source date-only values
stay date-only. Follow nextOffset with unchanged filters and returned snapshot.
Temporal eligibility="include_inactive" includes superseded/expired material,
never withdrawn records or a reconstruction of past system state. Last-seen uses
occurredOnOrBefore for the occurrence cutoff; do not pass asOf or historical.
Use includeSources=true for deduplicated source identities on temporal pages. Markdown-only timelines and undated records
are not inferred, and no matches do not prove absence.

## Focused source reading

Use knowledge_evidence_read with the record id and observed path/sha256 to read
an exact retained UTF-8 passage. Supply inclusive startLine/endLine when known.
Follow nextCursor with unchanged id/path/hash and omit or repeat line bounds.
A null nextCursor completes the passage. In contrast, record.nextEvidenceOffset
only completes the citation list; excerptTruncated still requires source reading.
The tool verifies bytes and line bounds, not the truth of an interpretation.
Use knowledge_attachment for binary originals. Never infer complete review from
an excerpt or a successful structural verifier.

Query freshness distinguishes queriedAt from scannedAt; keyword results also
have indexedAt. A reused scan retains its observation time. Compare snapshot
values only across pages with unchanged query filters and eligibility.
