# Qdrant Workspace Reconciliation Implementation Record

Date: 2026-05-17
Status: implemented, repaired, and partially live-verified

This file is the single source of truth for the Qdrant workspace reconciliation rollout. It replaces the earlier design draft and task checklist. Only behavior that is implemented or directly verified is recorded here.

## Scope

The rollout adds a workspace-managed semantic memory sync for the approved markdown corpus:

- `MEMORY.md`
- `memory/`
- `rules-vault/`
- `projects/`

The managed Qdrant target is the live `agent-memory` collection. Managed records are namespaced with `managed_by = "workspace-reconciler"`.

Operational invariant for this project:

- gateway/runtime updates are bind-mount based
- do not rebuild images for this rollout

## Implemented Architecture

### Reconciliation primitives

Implemented in:

- `packages/memory-host-sdk/src/host/workspace-reconcile.ts`
- `src/memory-host-sdk/host/workspace-reconcile.ts`

Current behavior:

- discovers only the approved markdown roots
- normalizes workspace-relative paths
- chunks markdown heading-first, then splits oversized sections by paragraph groups
- assigns deterministic ids as `workspace:<relative_path>#<chunk_index>`
- stores payload fields:
  - `managed_by`
  - `path`
  - `root`
  - `chunk_index`
  - `content_hash`
  - `document` (full chunk text — required so the `mcp-server-qdrant` `qdrant-find` tool can read content from the shared `agent-memory` collection)
  - `text_preview`
  - `synced_at`
  - optional `title`

### Qdrant reconcile command

Implemented in:

- `src/commands/qdrant-workspace-reconcile.ts`
- `src/cli/qdrant-cli.ts`
- `src/cli/program/register.subclis-core.ts`

Current CLI surface:

```bash
openclaw qdrant workspace reconcile --dry-run --json
openclaw qdrant workspace reconcile --apply --json
```

Current behavior:

- builds the expected managed workspace manifest
- reads existing managed points from Qdrant by `managed_by = "workspace-reconciler"`
- classifies points as unchanged, new, updated, or stale
- skips delete unless inventory build succeeded
- writes directly to Qdrant HTTP, not through agent turns

### Embedding bridge

The command reuses the mounted `mcp-server-qdrant` Python environment and FastEmbed MiniLM model through a narrow JSON bridge.

Current defaults in code:

- container Qdrant URL: `http://qdrant:6333`
- host fallback Qdrant URL: `http://127.0.0.1:6333`
- collection: `agent-memory`
- workspace dir: the mounted OpenClaw workspace inside the gateway container, with host fallback support

### Host automation templates

Implemented in:

- `scripts/systemd/openclaw-qdrant-workspace-reconcile.service`
- `scripts/systemd/openclaw-qdrant-workspace-reconcile.timer`
- `scripts/setup-qdrant-workspace-reconcile-system.sh`

Current shape:

- user-level `systemd` timer
- boot delay: `2min`
- recurring interval: `10min`
- runtime command executes inside the running gateway container with `docker exec`

## Corrections Applied After The Broken Rollout

The original rollout history included bad follow-up changes that are not part of the valid implementation record.

The repaired state keeps these corrections:

- `docker-compose.yml`
  - restore `OPENCLAW_PLUGIN_STAGE_DIR` for the mounted plugin runtime dependency directory
  - preserve the bind-mount runtime path
- `extensions/memory-core/index.ts`
  - remove stray follow-up wiring that referenced non-committed maintenance code
- `extensions/memory-core/openclaw.plugin.json`
  - remove the extra `localMemoryEmbedding` runtime dependency contract added outside scope
- `src/infra/outbound/channel-bootstrap.runtime.ts`
  - remove the unrelated outbound bootstrap experiment

These corrections were required to restore the bind-mounted dashboard and bundled plugin runtime behavior after the bad push sequence.

### Post-Rollout Corrections (2026-05-17 evening)

Two follow-up bugs were caught during the first live agent test of `qdrant-find` and fixed in the same session:

1. **`qdrant-find` always returned `KeyError: 'document'`.** The reconciler payload schema was missing the `document` key that `mcp-server-qdrant`'s `qdrant.py:search()` reads via `result.payload["document"]`. With 899 reconciler-owned points and 2 MCP-stored points sharing the `agent-memory` collection, every semantic query hit a reconciler point first and crashed inside the MCP server's response handler. Fixed by adding `document: chunk.text` to `WorkspaceReconcilePayload` and to the payload builder in `packages/memory-host-sdk/src/host/workspace-reconcile.ts`, with a TDD test pinning the contract.
2. **Reconcile `--apply` failed with `write EPIPE` on the first upsert.** The Python embedding bridge re-loads the FastEmbed ONNX model on every spawn; 18 spawns for 899 chunks left the keep-alive socket to Qdrant idle long enough that Qdrant closed it. Undici did not retry. Fixed by retrying once on `EPIPE` / `ECONNRESET` / `UND_ERR_SOCKET` inside `fetchQdrantJson` in `src/commands/qdrant-workspace-reconcile.ts`, with a TDD test that throws an EPIPE-shaped error on the first PUT and asserts a successful retry.

Live proof after both fixes:

- `openclaw qdrant workspace reconcile --apply --json` → `{"ok":true,"newPoints":899}`
- All 901 points in `agent-memory` carry the `document` payload key (was 2/901)
- `QdrantConnector.search()` (the exact call path the MCP server uses) returned real hits for unrelated queries (`memory rework decision`, `QMD`, `qdrant reconciliation plan`) with no `KeyError`

Outstanding issues uncovered during this session are tracked in `docs/superpowers/plans/2026-05-17-qdrant-post-implementation-bug-report.md`.

## Verified Working

### Live runtime proof

Verified on the validation host without rebuilding images:

- gateway Control UI root served valid HTML again
- gateway runtime loaded without bundled runtime dependency errors
- Discord channel reached `configured: true`, `running: true`, `connected: true`
- `qdrant workspace reconcile --dry-run --json` succeeded against the live stack

Dry-run counts at validation time:

- `filesScanned: 92`
- `chunksBuilt: 899`
- `newPoints: 0`
- `updatedPoints: 0`
- `unchangedPoints: 899`
- `deletedPoints: 0`

### Automated proof

Passed targeted tests:

- `packages/memory-host-sdk/src/host/workspace-reconcile.test.ts`
- `src/memory-host-sdk/host/mirror.test.ts`
- `src/commands/qdrant-workspace-reconcile.test.ts`
- `src/cli/qdrant-cli.test.ts`
- `src/plugins/bundled-plugin-metadata.test.ts`

Passed touched-file verification:

- `oxfmt` on the touched files
- direct `oxlint` on the touched files

## Not Yet Proven

The following are not recorded as complete proof yet and should not be treated as done:

- ~~first full `--apply` workspace backfill with durable point-count growth evidence~~ — done 2026-05-17 evening after the EPIPE fix; 899 new points landed and `qdrant-find` verified
- end-to-end edit/update reconciliation proof
- end-to-end delete reconciliation proof
- post-restart proof for reconciled workspace points
- clean-worktree broad gate proof free of unrelated local dirty-worktree noise
- root-cause and fix for the later `Docs` workflow failure on commit `69b244c`
- systemd timer end-to-end proof (the 20:51:50 UTC timer run on 2026-05-17 failed with EPIPE before the fix; first post-fix timer fire needs to be observed green)

## Files That Currently Define The Rollout

- `docker-compose.yml`
- `packages/memory-host-sdk/src/host/workspace-reconcile.ts`
- `packages/memory-host-sdk/src/host/workspace-reconcile.test.ts`
- `src/memory-host-sdk/host/workspace-reconcile.ts`
- `src/memory-host-sdk/host/mirror.test.ts`
- `src/commands/qdrant-workspace-reconcile.ts`
- `src/commands/qdrant-workspace-reconcile.test.ts`
- `src/cli/qdrant-cli.ts`
- `src/cli/program/register.subclis-core.ts`
- `scripts/systemd/openclaw-qdrant-workspace-reconcile.service`
- `scripts/systemd/openclaw-qdrant-workspace-reconcile.timer`
- `scripts/setup-qdrant-workspace-reconcile-system.sh`

## Summary

The valid rollout state is:

- workspace markdown reconciliation is implemented in code
- the CLI surface exists and dry-run works against the live stack
- the bind-mounted gateway/runtime repair is applied
- the dashboard and Discord runtime recovered without rebuilding images

Anything outside that verified set is intentionally omitted from the canonical record until it is re-proved.
