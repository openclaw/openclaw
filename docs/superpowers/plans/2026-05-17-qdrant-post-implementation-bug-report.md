# Qdrant Workspace Reconciliation — Post-Implementation Bug Report

**Date:** 2026-05-17 (evening, UTC)
**Author:** Claude (Opus 4.7) during live preliminary agent testing of the Qdrant + MCP integration
**Related plan:** `docs/superpowers/plans/2026-05-17-qdrant-workspace-reconciliation.md`
**Trigger:** OpenClaw agent reported `Error calling tool 'qdrant-find': 'document'` after the workspace-reconciler rollout

This document tracks the **5 open issues** uncovered during the post-rollout verification session. Five earlier issues are now worked off: the two initial P1 bugs (`qdrant-find` missing `document` key and reconciler EPIPE on first upsert) plus the Sprint 1 cleanup items (`pnpm build` bind-mount orphan, the stale local `web-tree-sitter` install that broke the dts step, and the Qdrant server/client version mismatch). See Appendix B for the fix record.

Severity legend:

- **P1** — blocks user-visible feature, must fix
- **P2** — degrades reliability or developer workflow, should fix soon
- **P3** — latent risk or hygiene; pick up when in the area

---

## Status Index

| #   | Title                                                                                             | Severity           |
| --- | ------------------------------------------------------------------------------------------------- | ------------------ |
| 1   | Reconciler vs MCP `agent-memory` ownership invariant is implicit                                  | P2                 |
| 2   | `classifyWorkspacePoints` ignores payload-schema changes, so schema migrations need manual delete | P2                 |
| 3   | FastEmbed Python bridge re-loads the ONNX model on every spawn                                    | P2                 |
| 4   | `indexed_vectors_count` is 0 because HNSW indexing threshold is 20000                             | Informational / P3 |
| 5   | Stale `agents/main/sessions/sessions.json` and large session history may bloat search corpora     | Informational / P3 |

---

## 1. `pnpm build` orphans the Docker bind-mount (`dist//deleted`)

### Symptom

After running `pnpm build` on the host, the container could not see the updated `dist/`:

```
$ docker exec openclaw-openclaw-gateway-1 ls /app/dist/
total 0                        # empty
$ docker exec openclaw-openclaw-gateway-1 findmnt /app/dist
TARGET    SOURCE                                                             FSTYPE
/app/dist /dev/sda1[/home/ubuntu/godwind-team-docker/openclaw/dist//deleted] ext4
```

The trailing `//deleted` marker is Linux kernel shorthand for "the original inode for this bind-mount source no longer exists." `docker compose restart openclaw-gateway` was required to refresh the mount.

### Root cause

`pnpm build` (via Rolldown / postbuild scripts) deletes and recreates the `dist/` directory. Docker bind-mounts capture the source inode at mount time; replacing the source directory leaves the mount pointing at the now-deleted inode.

Inode evidence captured during the session:

```
host  dist/ inode: 1134705   (post-build, fresh contents)
container /app/dist inode:    869988   (the deleted original)
```

### Impact

This collides directly with the project rule in `AGENTS.md`: _"Bind-mount, never rebuild images."_ The build pipeline produces JS files that look correct on the host but are invisible inside the gateway container. Code changes silently fail to deploy with no error indication — a developer-experience footgun that can also waste hours of debugging.

### Suggested fix

Pick one:

1. Modify the build to operate in-place — `rm -rf dist/*` rather than `rm -rf dist && mkdir dist` — so the source inode survives.
2. Add `docker compose restart openclaw-gateway` as a post-build hook (or a `pnpm build:deploy` wrapper) when running on the deployment host.
3. Mount the bind at a stable parent (e.g. `./build:/app/build`) and have the build atomic-rename a subdirectory inside it.

Option 1 is the smallest behavior change. Option 3 is the most robust.

### Diagnosis recipe (for future occurrences)

```bash
docker exec openclaw-openclaw-gateway-1 findmnt /app/dist
# look for "//deleted" suffix
stat -c '%i' /home/ubuntu/godwind-team-docker/openclaw/dist
docker exec openclaw-openclaw-gateway-1 stat -c '%i' /app/dist
# different inodes ⇒ mount is stale
```

---

## 2. `pnpm build` dts step fails on missing `web-tree-sitter` types

### Symptom

`pnpm build` exits non-zero with:

```
src/infra/command-explainer/extract.ts(1,45): error TS2307: Cannot find module 'web-tree-sitter' or its corresponding type declarations.
src/infra/command-explainer/tree-sitter-runtime.ts(4,29): error TS2307: Cannot find module 'web-tree-sitter' or its corresponding type declarations.
 ELIFECYCLE  Command failed with exit code 1.
```

The JS bundles do still emit (Rolldown runs before tsgo); only the plugin-SDK `.d.ts` generation step (`pnpm build:plugin-sdk:dts`) fails.

### Impact

- `pnpm build` always reports a non-zero exit even when the JS output is healthy, masking real failures.
- Anyone using `pnpm build && do-next-thing` chains needs to manually inspect the failure to decide whether the JS is usable.

### Suggested fix

- Add the missing `web-tree-sitter` dependency or its `@types` package to the workspace (whichever applies).
- Or, if `command-explainer` is meant to be an optional / runtime-loaded module, mark it as such in `tsconfig.plugin-sdk.dts.json` so it's excluded from the dts gate.

### Pre-existing?

Yes — this error pre-dates the qdrant rollout. Verified by checking out the change and running `pnpm build` on a clean tree; same error.

---

## 3. qdrant-client v1.18 vs server v1.12.4 minor version mismatch warning

### Symptom

When invoking `QdrantConnector.search()` via the vendored `mcp-server-qdrant` Python:

```
UserWarning: Qdrant client version 1.18.0 is incompatible with server version 1.12.4.
Major versions should match and minor version difference must not exceed 1.
Set check_compatibility=False to skip version check.
```

Reads/writes still functioned during testing, but the upstream client explicitly states this configuration is unsupported.

### Impact

- Risk that future client SDK calls use APIs not present in 1.12.4 — silent runtime failures or wire-protocol mismatches.
- Compose stack pins server to `qdrant/qdrant:v1.12.4` (`docker-compose.yml:216-218`); the Python venv was installed via `uv tool install mcp-server-qdrant` and resolved `qdrant-client>=1.18`.

### Suggested fix

Pick one:

1. Bump server image to `qdrant/qdrant:v1.18.x` (newest compatible with current data files; verify HNSW segment compatibility before bumping).
2. Pin `qdrant-client<1.13` in the `mcp-server-qdrant` venv via `uv tool install mcp-server-qdrant --with 'qdrant-client<1.13'`.

Option 1 is the longer-term direction; option 2 is the immediate compatibility patch.

---

## 1. Reconciler vs MCP `agent-memory` ownership invariant is implicit

### Symptom

The `agent-memory` collection is written by two independent producers:

- the workspace-reconciler (project code, `managed_by="workspace-reconciler"`)
- `mcp-server-qdrant` invoked by agents via `qdrant-store` (no `managed_by` field; `payload = {document, metadata}`)

`classifyWorkspacePoints` in `packages/memory-host-sdk/src/host/workspace-reconcile.ts:411` filters its deletion sweep on `payload?.managed_by === WORKSPACE_RECONCILER_ID`, so MCP-stored points are correctly preserved. But this invariant is enforced only by that single line of code; it is **not** documented in the plan, in `AGENTS.md`, or as a runtime contract test.

### Risk scenarios

- A future refactor of `classifyWorkspacePoints` (e.g. "tighten cleanup to remove all stale points") silently deletes every agent-stored memory.
- A new writer added to `agent-memory` without a `managed_by` field would be indistinguishable from `mcp-server-qdrant` points, so the reconciler would not garbage-collect them even if it should.
- The MCP payload also lacks `path`/`root`/`chunk_index`, so any future code that assumes all `agent-memory` points have a workspace anchor will trip on MCP data.

### Suggested fix

- Document the ownership contract in the plan and in `packages/memory-host-sdk/src/host/workspace-reconcile.ts` near the deletion filter.
- Add a regression test that asserts non-`workspace-reconciler` points survive a full reconcile cycle.
- Optionally, require `mcp-server-qdrant` writes to carry `managed_by="mcp-store"` so the schema is fully self-describing (would require either patching the vendored Python or wrapping the MCP server).

---

## 2. `classifyWorkspacePoints` ignores payload-schema changes

### Symptom

When the `document` key was added to the payload schema, running `openclaw qdrant workspace reconcile --apply --json` reported:

```json
{ "newPoints": 0, "updatedPoints": 0, "unchangedPoints": 899, "deletedPoints": 0 }
```

i.e. the reconciler classified all 899 existing points as unchanged because `content_hash` matched, even though their payloads were missing the new required `document` field. Backfill required a manual `POST /points/delete` filtered by `managed_by="workspace-reconciler"` before the reconcile could repopulate them.

### Root cause

`classifyWorkspacePoints` (`packages/memory-host-sdk/src/host/workspace-reconcile.ts:411`) uses only the content hash to detect change:

```typescript
if (existing?.payload?.content_hash === point.payload.content_hash) {
  unchanged.push(point);
  continue;
}
```

There is no concept of a payload schema version, so any change to the payload shape requires either a manual data wipe or rolling the `content_hash` algorithm.

### Suggested fix

Add a `payload_schema_version` integer to `WorkspaceReconcilePayload`. The classifier compares both `content_hash` AND `payload_schema_version` and re-upserts whenever either differs. Bumping the version on a future schema change becomes a 1-line, no-data-loss migration.

```typescript
const PAYLOAD_SCHEMA_VERSION = 2; // bumped when adding `document`
// ...
const sameHash = existing?.payload?.content_hash === point.payload.content_hash;
const sameSchema =
  existing?.payload?.payload_schema_version === point.payload.payload_schema_version;
if (sameHash && sameSchema) {
  unchanged.push(point);
  continue;
}
```

---

## 3. FastEmbed Python bridge re-loads the ONNX model on every spawn

### Symptom

Per-spawn embedding latency is dominated by model load. For 899 chunks at `EMBED_BATCH_SIZE=50`, the reconciler invokes Python 18 times, and each invocation does:

```python
model = TextEmbedding("sentence-transformers/all-MiniLM-L6-v2")  # ~3-5s load
vectors = [list(v) for v in model.embed(texts)]                  # ~0.05s for 50 chunks
```

Wall time: ~60-90 s of model loading vs ~1 s of actual embedding. This is what stretched the idle gap that triggered the now-fixed reconciler EPIPE bug (see Appendix B).

### Source

`src/commands/qdrant-workspace-reconcile.ts:81-89` defines `FASTEMBED_BRIDGE_SCRIPT` and `embedWorkspaceTexts` at `:365`.

### Impact

- Reconcile wall time scales with model-load overhead, not actual work
- Idle keep-alive time grows with chunk count, increasing exposure to stale-socket races (the EPIPE class of bug from Appendix B can re-emerge at extreme scale even with the one-shot retry already in place)
- CPU/RSS spikes from repeated ONNX initialization

### Suggested fix

Spawn the Python embedder **once** as a long-lived subprocess with line-delimited stdin/stdout JSON, OR run all chunks in a single spawn:

```typescript
// Single spawn with the entire input
const result = spawnSync(pythonPath, ["-c", FASTEMBED_BRIDGE_SCRIPT], {
  encoding: "utf8",
  input: JSON.stringify({ texts: allChunks }),
  stdio: ["pipe", "pipe", "pipe"],
  maxBuffer: 256 * 1024 * 1024,
});
```

899 chunks × ~700 bytes avg = ~630 KB input, well under any reasonable maxBuffer. Loading the model once cuts wall time from ~90 s to ~10 s and eliminates the keep-alive race entirely.

For workspaces that grow beyond a few thousand chunks, switch to a persistent embedder service (FastEmbed-server, ONNX Runtime as a sidecar container) and call it over HTTP.

---

## 4. `indexed_vectors_count: 0` because HNSW threshold is 20000

### Observation

```
$ curl -s http://127.0.0.1:6333/collections/agent-memory | jq .result
{
  "points_count": 901,
  "indexed_vectors_count": 0,
  "config.optimizer_config.indexing_threshold": 20000
}
```

All 901 points are searched by brute-force scan, not via HNSW. Per-query latency is still ~5-15 ms in testing, but this scales linearly with collection size.

### Action

Not a bug today. Re-evaluate when point count crosses ~5 000-10 000 or query latency exceeds a budget. The Qdrant default of 20 000 is suitable for static collections; for incrementally-grown collections, lower it to 1 000-5 000 to start building the index sooner. To change:

```yaml
# When (re-)creating the collection
optimizer_config:
  indexing_threshold: 2000
```

---

## 5. Stale `agents/main/sessions/sessions.json` and large session corpora

### Observation

`/home/node/.openclaw/agents/main/sessions/sessions.json` is multiple megabytes and includes tool-call records from the user's exploratory testing earlier today. Conversation transcripts (`*.jsonl`) include `qdrant__qdrant-find` calls with their results.

If/when a future memory feature ingests session corpora into Qdrant, these files will dominate the embedding corpus and could leak secrets (the `qdrant-find` results may quote `document` payloads which include workspace markdown that may contain non-public references).

### Action

- Decide whether session files are in scope for the workspace reconciler. Today the reconciler only walks `MEMORY.md`, `memory`, `rules-vault`, `projects` — sessions are excluded. Make that exclusion an explicit, tested invariant.
- If session ingestion is planned, add redaction passes (PII, API keys, file paths under `~/.openclaw/credentials`) before any vectorization.

---

## Appendix A — Diagnosis recipes useful for the open items

1. **Live state inspection of the `agent-memory` collection:**

   ```bash
   curl -s http://127.0.0.1:6333/collections/agent-memory | jq .result
   curl -s -X POST http://127.0.0.1:6333/collections/agent-memory/points/scroll \
     -H 'Content-Type: application/json' \
     -d '{"limit":1000,"with_payload":true,"with_vector":false}' | jq
   ```

   Use this to audit the writers issue #1 talks about — the `managed_by` distribution tells you who owns each point.

2. **Undici tracing for reconciler HTTP behavior:**

   ```bash
   docker exec -u node openclaw-openclaw-gateway-1 sh -c \
     'NODE_DEBUG=undici openclaw qdrant workspace reconcile --apply --json > /tmp/recon.out 2>/tmp/recon.err'
   ```

   Useful for catching socket-lifecycle issues like the EPIPE class of bugs.

3. **Source archaeology pointers for ownership/schema work (issues #1, #2):**
   - Deletion filter: `packages/memory-host-sdk/src/host/workspace-reconcile.ts:411`
   - Classification logic: `packages/memory-host-sdk/src/host/workspace-reconcile.ts` (`classifyWorkspacePoints`)
   - Embed bridge: `src/commands/qdrant-workspace-reconcile.ts:81-89` and `:365` (`embedWorkspaceTexts`)
   - MCP-side payload contract: `/home/node/.openclaw/vendor/uv-tools/data/uv/tools/mcp-server-qdrant/lib/python3.11/site-packages/mcp_server_qdrant/qdrant.py:79,117`

## Appendix B — Already-fixed bugs from the same session (for cross-reference)

The initial P1 bugs and Sprint 1 cleanup items were resolved before Sprint 2 work started. They are recorded in:

- `docs/superpowers/plans/2026-05-17-qdrant-workspace-reconciliation.md` § _Post-Rollout Corrections_
- Commit `be224c265c` — `fix(memory): add document payload key and retry EPIPE in qdrant reconciler`
- Commit `e27ac4cab7` — `docs: qdrant post-implementation bug report and plan corrections`
- Commit `65bc177037` — `fix(build): preserve dist bind mounts and add deploy wrapper`
- Host stack change on 2026-05-18 — upgraded `/home/ubuntu/.qdrant/docker-compose.yml` from `qdrant/qdrant:v1.12.4` to `qdrant/qdrant:v1.18.0` via consecutive minor hops after taking a volume snapshot and re-verifying `qdrant-find`
- Local environment repair on 2026-05-18 — `pnpm install` restored the already-declared `web-tree-sitter@0.26.8`, after which `pnpm build:plugin-sdk:dts` passed cleanly with no manifest delta

Files touched by those fixes:

```
packages/memory-host-sdk/src/host/workspace-reconcile.ts
packages/memory-host-sdk/src/host/workspace-reconcile.test.ts
src/commands/qdrant-workspace-reconcile.ts
src/commands/qdrant-workspace-reconcile.test.ts
docs/superpowers/plans/2026-05-17-qdrant-workspace-reconciliation.md
docs/superpowers/plans/2026-05-17-qdrant-post-implementation-bug-report.md (this file)
```
