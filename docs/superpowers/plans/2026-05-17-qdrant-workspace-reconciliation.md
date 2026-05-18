# Qdrant Workspace Reconciliation Implementation Record

Date: 2026-05-17
Status: implemented, repaired, and live-verified with follow-up fixes through 2026-05-18

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
- explicitly excludes `agents/*/sessions/**` by walked-root contract test
- normalizes workspace-relative paths
- chunks markdown heading-first, then splits oversized sections by paragraph groups
- assigns deterministic ids as `workspace:<relative_path>#<chunk_index>`
- stores payload fields:
  - `managed_by`
  - `path`
  - `root`
  - `chunk_index`
  - `content_hash`
  - `payload_schema_version`
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
- classifies points as unchanged only when both `content_hash` and `payload_schema_version` match
- preserves points written by other producers in the shared `agent-memory` collection
- skips delete unless inventory build succeeded
- writes directly to Qdrant HTTP, not through agent turns

### Embedding bridge

The command reuses the mounted `mcp-server-qdrant` Python environment and FastEmbed MiniLM model through a narrow JSON bridge.

Current defaults in code:

- container Qdrant URL: `http://qdrant:6333`
- host fallback Qdrant URL: `http://127.0.0.1:6333`
- collection: `agent-memory`
- workspace dir: the mounted OpenClaw workspace inside the gateway container, with host fallback support
- embed all reconcile chunks in a single Python spawn with a `256 * 1024 * 1024` max buffer

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

### Sprint 1 Follow-Up Fixes (2026-05-18)

Three cleanup items from the post-implementation bug report were resolved in the next maintenance pass:

1. **Host `pnpm build` no longer orphans the `./dist:/app/dist` bind-mount.** `scripts/tsdown-build.mjs` now clears `dist/` and `dist-runtime/` in place instead of deleting the root directories, so the source inode survives a plain build. A `scripts/deploy.mjs` wrapper was also added and exposed as `pnpm run deploy` for the host build + gateway restart flow. Recorded in commit `65bc177037`.
2. **The `web-tree-sitter` dts failure was an install-state problem, not a manifest bug.** The dependency was already declared in `package.json`; a fresh `pnpm install` restored the missing package in `node_modules`, after which `pnpm build:plugin-sdk:dts` passed cleanly with no source change required.
3. **The live Qdrant server was upgraded from `qdrant/qdrant:v1.12.4` to `qdrant/qdrant:v1.18.0`.** A direct jump was not storage-compatible; the live volume had to move through consecutive minor versions (`1.12.6 -> 1.13.6 -> 1.14.1 -> 1.15.5 -> 1.16.3 -> 1.17.1 -> 1.18.0`) after taking a snapshot at `~/qdrant-snapshot-2026-05-18.tgz`. This was a host-stack change in `/home/ubuntu/.qdrant/docker-compose.yml`, not a tracked repo file.

### Sprint 2 Reconciler Hardening (2026-05-18)

Three reconciler bugs from the post-implementation bug report were resolved in the next code pass:

1. **FastEmbed bridge spawn collapse.** `embedWorkspaceTexts` now embeds all reconcile chunks in one Python spawn instead of reloading the ONNX model every 50 texts. This removed the dominant wall-time cost from the reconcile loop and largely dissolved the stale-keep-alive timing window behind the earlier EPIPE class of failures.
2. **Payload schema migrations now self-migrate.** `WorkspaceReconcilePayload` now includes `payload_schema_version = 2`, and classification re-upserts whenever either the content hash or the schema version differs. The first post-change run correctly re-upserted every managed point once; subsequent unchanged runs become no-ops again.
3. **Shared-collection ownership is now documented and tested.** The delete filter is now explicitly scoped to `managed_by === "workspace-reconciler"`, with regression coverage proving that non-reconciler points survive apply runs. Recorded in commit `17ec1927de`.

### Sprint 3 Session-Corpus Invariant (2026-05-18)

The last low-risk follow-up from the bug report was handled as a test-only invariant:

1. **Session transcript exclusion is now pinned in tests.** `collectWorkspaceReconcileFiles` already excluded `agents/*/sessions/**` by only walking the approved roots. `packages/memory-host-sdk/src/host/workspace-reconcile.test.ts` now asserts that markdown files under `agents/main/sessions/` are not included in the reconcile corpus. Recorded in commit `b49c190d28`.

## Verified Working

### Live runtime proof

Verified on the validation host without rebuilding images:

- gateway Control UI root served valid HTML again
- gateway runtime loaded without bundled runtime dependency errors
- Discord channel reached `configured: true`, `running: true`, `connected: true`
- `qdrant workspace reconcile --dry-run --json` succeeded against the live stack
- `qdrant workspace reconcile --apply --json` succeeded after the schema-version rollout and re-upserted all managed points once
- live semantic search through the installed `mcp-server-qdrant` Python path returned real hits after the Qdrant `v1.18.0` upgrade

Dry-run/apply counts after the Sprint 2 schema migration:

- `filesScanned: 94`
- `chunksBuilt: 935`
- `newPoints: 0`
- `updatedPoints: 935`
- `unchangedPoints: 0`
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
- `pnpm build`
- `pnpm build:plugin-sdk:dts`

## Not Yet Proven

The following are not recorded as complete proof yet and should not be treated as done:

- ~~first full `--apply` workspace backfill with durable point-count growth evidence~~ — done 2026-05-17 evening after the EPIPE fix; 899 new points landed and `qdrant-find` verified
- ~~payload-schema migration proof~~ — done 2026-05-18; first post-version run re-upserted 935 managed points and restored no-error `qdrant-find` behavior on Qdrant `v1.18.0`
- end-to-end edit/update reconciliation proof
- end-to-end delete reconciliation proof
- post-restart proof for reconciled workspace points
- clean-worktree broad gate proof free of unrelated local dirty-worktree noise
- root-cause and fix for the later `Docs` workflow failure on commit `69b244c`
- systemd timer end-to-end proof (the 20:51:50 UTC timer run on 2026-05-17 failed with EPIPE before the fix; first post-fix timer fire needs to be observed green)

## Files That Currently Define The Rollout

- `docker-compose.yml`
- `/home/ubuntu/.qdrant/docker-compose.yml` (host-stack sidecar state; not tracked in this repo)
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
- the CLI surface exists and both dry-run and apply work against the live stack
- the bind-mounted gateway/runtime repair is applied
- the managed payload schema is versioned and self-migrating
- the shared `agent-memory` ownership contract is documented and tested
- the dashboard and Discord runtime recovered without rebuilding images
- the live Qdrant sidecar is running on `qdrant/qdrant:v1.18.0`

Anything outside that verified set is intentionally omitted from the canonical record until it is re-proved.
