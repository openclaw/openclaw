---
name: knowledge-source-ingest
description: Incrementally ingest enumerable external sources into Knowledge with canonical source identity, retained snapshot manifests, overlap-aware diffing, and reconciliation of changed or deleted items. Includes a generic manifest tool and a read-only Discrawl adapter.
---

# Source Ingest Skill

Use this for bounded collections such as chat channels, issue streams, feeds, or
mailboxes where later runs can overlap prior coverage. Read
[shared conventions](references/conventions.md),
[publication](references/publication.md), and the
[manifest protocol](references/source-manifest.md). After acquisition, route
documents and conversations through `knowledge-ingest`, which uses
`knowledge-entities` for entity enrichment. Route meetings through
`knowledge-meeting-ingest`. This skill owns source identity and coverage; the
ingestion workflows turn the retained content into useful connected knowledge.
For creating recurring ingestion jobs, use `knowledge-automation` first.

## Contract

- Resolve a stable provider/source key before reading content. Display names are labels, never identity.
- Maintain one canonical `source` page with `source_role: canonical`, `provider`, and `source_key`. Reuse it on every run.
- For each bounded observation, preserve the generated manifest as an attachment on a `source` page with `source_role: snapshot`, exact coverage, observation time, manifest hash, count, completeness, watermark, and dependency on the canonical source page.
- Manifests retain stable item IDs and content hashes, not source text. Preserve original/exported content separately as evidence where authorized.
- Query prior snapshot pages for the same provider/source key before planning. Download their manifests, verify attachment hashes, and pass all overlapping snapshots to the planner. Do not rely on conversation memory.
- Reuse unchanged source bytes and existing records. Continue previously omitted enrichment from those retained sources when requested; an unchanged manifest does not mean entity enrichment already happened. Ingest added items. Reconcile changed items against existing pages/claims. Treat deletion as observed source state, not permission to erase Knowledge; correct or withdraw only when the evidence warrants it.
- A complete snapshot can establish absence inside its exact coverage. Partial or unknown snapshots cannot; unresolved missing IDs remain unresolved.

## Procedure

1. Inspect `knowledge_status` and `knowledge_ontology` for the intended vault scope and the `source` fields, then search Knowledge for the canonical source and prior snapshots by provider/source key. If an owner-private ingestion unexpectedly resolves to a conversation scope or an empty vault after a restart, stop before writing and restore the intended authorized scope; never infer that prior coverage is absent from the wrong scope.
2. Acquire a bounded export with an approved reader. For Discrawl, run `scripts/discrawl-normalize.mjs` with its configured read-only archive, exact channel ID when known, and `[since,before)` RFC3339 bounds. The normalized payload includes stable author IDs plus archive-observed display fields. Preserve the raw JSONL, and create a separate line-stable readable transcript when human review or line citations are needed.
3. Generate a deterministic manifest with `scripts/source-manifest.mjs snapshot`. Attach it before publishing the snapshot page; record the returned SHA-256.
4. Download all overlapping prior manifests and run `scripts/source-manifest.mjs plan`. Inspect covered/uncovered intervals and the added/changed/deleted/unchanged/unresolved lists.
5. Test 3–5 substantive items or discussions, then ingest through `knowledge-ingest` (or `knowledge-meeting-ingest` for meetings). For chat, group related messages with their reply context; use `knowledge-entities` to enrich relevant people, companies, projects and concepts from their contributions. Carry supported developments into State, dated claims and source notes, not only a channel digest. Use stable external IDs in source citations and the retained snapshot as a dependency. Reuse its originals rather than uploading one copy per discussion.
6. Publish or update derived records, then publish the snapshot page. A snapshot is `complete` only when acquisition and manifest creation covered the declared interval; derived extraction may still be partial and must be reported as such.
7. Read back the canonical page, snapshot page, attachment, derived records, and source-dependent connections. Verify hashes and exact coverage.

## Discrawl example

    node scripts/discrawl-normalize.mjs --config /approved/discrawl.yaml \
      --channel 1234567890 --since 2026-09-21T00:00:00-07:00 \
      --before 2026-09-28T00:00:00-07:00 --output messages.jsonl
    node scripts/source-manifest.mjs snapshot --provider discord \
      --source-key discord:GUILD_ID:1234567890 \
      --coverage-start 2026-09-21T00:00:00-07:00 \
      --coverage-end 2026-09-28T00:00:00-07:00 \
      --input messages.jsonl --output manifest.jsonl.gz --summary snapshot.json
    node scripts/source-manifest.mjs plan --current manifest.jsonl.gz \
      --previous prior-1.jsonl.gz --previous prior-2.jsonl.gz --output plan.json

Do not include credentials, archive paths, or raw private content in Knowledge page prose. No scheduler, connector daemon, or plugin-owned ingestion job is created; the skill and scripts support an authorized agent-run workflow.
