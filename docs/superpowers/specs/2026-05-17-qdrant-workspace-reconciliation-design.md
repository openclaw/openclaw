# Qdrant Workspace Reconciliation Design

Date: 2026-05-17
Scope: seed and continuously reconcile the markdown memory corpus into the live `agent-memory` Qdrant collection on this host.

## Goal

Make the Qdrant semantic tier useful for real workspace recall by:

- bulk-indexing the approved markdown memory corpus now
- keeping Qdrant synchronized with future markdown adds, edits, renames, and deletes
- preserving the existing OpenClaw agent retrieval surface (`qmd__query`, `qdrant__qdrant-find`) without routing bulk sync through agent turns

## In-Scope Corpus

Only these workspace sources are managed by this reconciler:

- `MEMORY.md`
- `memory/`
- `rules-vault/`
- `projects/`

Out of scope:

- the full repo checkout
- arbitrary config/state trees
- binary assets
- non-approved file families unless explicitly added later

## Recommended Architecture

Implement a host-side reconciliation script that talks directly to Qdrant HTTP and is scheduled by user-level `systemd`.

Why this approach:

- deterministic bulk sync is easier outside the agent loop
- deletes and replacements are straightforward
- failures are easier to log and audit
- it reuses the same host-automation pattern already used for QMD refresh

This is intentionally separate from the current agent-facing MCP tool calls. Agents continue to query Qdrant through MCP; maintenance writes go directly to Qdrant.

## Data Flow

### Initial backfill

1. Walk the four approved roots.
2. Normalize each file to a workspace-relative path.
3. Parse markdown into stable chunks.
4. Compute a deterministic id per chunk.
5. Compute a content hash per chunk.
6. Embed the chunk text with the same local model family already used by the live Qdrant stack.
7. Upsert vectors and payload into `agent-memory`.

### Recurring reconciliation

1. Rebuild the complete expected chunk set from the same four roots.
2. Skip unchanged chunks when the stored `content_hash` matches.
3. Re-embed and upsert changed chunks.
4. Insert new chunks.
5. Delete managed Qdrant records that are no longer present locally.

### Retrieval

No retrieval API change:

- `qmd__query` stays the lexical first pass
- `qdrant__qdrant-find` stays the semantic companion

## Chunking Strategy

Chunking must be stable enough that small edits do not reshuffle unrelated ids.

Recommended strategy:

- split by markdown headings first
- for oversized sections, split by paragraph groups with a size cap
- avoid line-based chunking
- keep each chunk semantically meaningful rather than mechanically tiny

Target property:

- moving or editing one section should only affect the chunks in that section, not the whole file

## Deterministic IDs

Managed chunk ids should be:

- `workspace:<relative_path>#<chunk_index>`

Rules:

- `relative_path` is rooted from the workspace root
- `chunk_index` is assigned after deterministic chunking
- the reconciler only manages ids in this namespace

This keeps deletes safe and lets future non-workspace Qdrant content coexist in the same collection.

## Payload Schema

Each managed point should store at least:

- `managed_by = "workspace-reconciler"`
- `path`
- `root`
- `chunk_index`
- `content_hash`
- `text_preview`
- `synced_at`
- `title` or nearest heading when derivable

Optional future fields:

- `workspace`
- `tags`
- `source_type`

## Reconciliation Rules

### Add

If a chunk id is not present in Qdrant, embed and insert it.

### Update

If a chunk id exists but `content_hash` changed, replace that point with a fresh embedding and updated payload.

### Delete

If a managed Qdrant id is absent from the newly built expected set after a successful full scan, delete it.

### Rename

Treat as delete old ids plus add new ids unless a future path-independent identity scheme is introduced.

## Failure Semantics

The reconciler must prefer staleness over accidental destructive loss.

Rules:

- never run the delete phase after a partial or failed scan
- only delete after a successful full inventory build
- log counts for scanned files, emitted chunks, inserted chunks, updated chunks, unchanged chunks, deleted chunks, and failures
- fail the run clearly if Qdrant is unreachable or embedding generation fails beyond tolerance

## Scheduling

Use user-level `systemd`, following the existing `openclaw-qmd-update.service` / `.timer` pattern.

Recommended shape:

- one oneshot service that runs the reconciler
- one timer that runs on boot and every N minutes afterward

Default recommendation:

- boot delay: a couple of minutes
- steady-state cadence: 10 minutes

This keeps the host behavior aligned with the current QMD maintenance setup and avoids putting recurring bulk sync into ad hoc agent cron jobs.

## Collection Ownership

`agent-memory` already contains rollout canary content, so the reconciler should not assume exclusive collection ownership. It should only reconcile points marked with `managed_by = "workspace-reconciler"` and only delete within that managed subset.

This avoids deleting manual canaries or future unrelated Qdrant records.

## Verification Plan

Before calling the work complete, prove all of the following:

1. Initial backfill increases `points_count` substantially above the current canary-only baseline.
2. A semantic query over a known workspace concept returns a real workspace document.
3. Editing one managed markdown file updates its stored Qdrant chunk on the next sync.
4. Deleting or temporarily moving one managed markdown file removes its managed Qdrant records on the next successful sync.
5. A restart of Qdrant preserves the reconciled points.

## Risks

### Unstable chunk ids

Mitigation:

- heading-first chunking
- deterministic normalization
- narrow update scope

### Over-indexing noise

Mitigation:

- keep the corpus limited to the four approved roots

### Slow first backfill

Mitigation:

- run as an explicit bulk job
- log progress and counts
- allow follow-up optimization later if throughput is poor

### Accidental deletes

Mitigation:

- namespace managed ids
- delete only after successful full scan

## Recommendation

Proceed in two stages:

1. build and run the full reconciliation backfill now
2. install the recurring timer using the same reconciler

This gives immediate semantic utility and a durable sync path without forcing bulk maintenance through the agent runtime.
