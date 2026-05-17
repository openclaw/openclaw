# Qdrant Workspace Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed the approved markdown memory corpus into the live `agent-memory` Qdrant collection, keep it reconciled over time, and install an automated host timer that reruns reconciliation safely without routing bulk writes through agent turns.

**Architecture:** Ship a built OpenClaw CLI command that runs inside the gateway container: `openclaw qdrant workspace reconcile`. Put deterministic scan/chunk/id logic in the package-owned memory host SDK, keep Qdrant HTTP + reconciliation orchestration in a command module, and reuse the mounted uv-managed `mcp-server-qdrant` Python environment only as an embedding bridge so vectors match the live FastEmbed MiniLM stack. Install a user-level `systemd` timer on the host that calls `docker exec openclaw-openclaw-gateway-1 node dist/index.js qdrant workspace reconcile --apply`.

**Tech Stack:** TypeScript ESM, Commander CLI, built OpenClaw `dist/` runtime, Qdrant HTTP API, Docker Compose, user-level `systemd`, mounted uv toolchain at `/home/node/.openclaw/vendor/uv-tools/data/uv/tools/mcp-server-qdrant/bin/python`, FastEmbed `all-MiniLM-L6-v2`, Vitest.

**Reference design:** `docs/superpowers/specs/2026-05-17-qdrant-workspace-reconciliation-design.md`

---

### Task 1: Add package-owned workspace reconciliation primitives

**Files:**
- Create: `packages/memory-host-sdk/src/host/workspace-reconcile.ts`
- Create: `packages/memory-host-sdk/src/host/workspace-reconcile.test.ts`
- Modify: `packages/memory-host-sdk/src/engine-storage.ts`
- Create: `src/memory-host-sdk/host/workspace-reconcile.ts`
- Modify: `src/memory-host-sdk/host/mirror.test.ts`

- [ ] **Step 1: Write failing tests for stable chunking, ids, and managed-scope inventory**

Add tests that prove:
- only these roots are included: `MEMORY.md`, `memory/`, `rules-vault/`, `projects/`
- heading-first chunking keeps unrelated sections stable when one section changes
- chunk ids are `workspace:<relative_path>#<chunk_index>`
- `managed_by` is always `workspace-reconciler`
- delete candidates are computed only from managed ids, never the rollout canary

Suggested test shape:
```ts
expect(plan.points.map((point) => point.id)).toEqual([
  "workspace:MEMORY.md#0",
  "workspace:projects/demo.md#0",
]);

expect(plan.points[0]?.payload).toMatchObject({
  managed_by: "workspace-reconciler",
  path: "MEMORY.md",
  root: "MEMORY.md",
  chunk_index: 0,
});
```

Run:
```bash
pnpm test packages/memory-host-sdk/src/host/workspace-reconcile.test.ts src/memory-host-sdk/host/mirror.test.ts
```
Expected output:
```text
FAIL  ... workspace-reconcile.test.ts
```

- [ ] **Step 2: Implement deterministic file discovery + heading-first chunking**

In `packages/memory-host-sdk/src/host/workspace-reconcile.ts`, add package-owned helpers and types:
- `WORKSPACE_RECONCILER_ID = "workspace-reconciler"`
- `WORKSPACE_RECONCILER_ROOTS = ["MEMORY.md", "memory", "rules-vault", "projects"]`
- `collectWorkspaceReconcileFiles(workspaceDir)`
- `chunkWorkspaceMarkdownByHeading(content)`
- `buildWorkspaceReconcilePlan(workspaceDir, nowIso)`

Implementation rules:
- reuse existing `hashText` and low-level file helpers where possible
- do not mutate `listMemoryFiles()` semantics for the rest of the app
- treat `MEMORY.md` as a root singleton and the other three as recursive markdown trees
- split by headings first, then size-cap oversized sections by paragraph groups
- include payload fields:
  - `managed_by`
  - `path`
  - `root`
  - `chunk_index`
  - `content_hash`
  - `text_preview`
  - `synced_at`
  - `title` when derivable

- [ ] **Step 3: Export and bridge the new package surface**

Update:
- `packages/memory-host-sdk/src/engine-storage.ts`
- `src/memory-host-sdk/host/workspace-reconcile.ts`
- `src/memory-host-sdk/host/mirror.test.ts`

Bridge file should stay thin:
```ts
export * from "../../../packages/memory-host-sdk/src/host/workspace-reconcile.js";
```

- [ ] **Step 4: Re-run targeted tests and formatter**

Run:
```bash
pnpm test packages/memory-host-sdk/src/host/workspace-reconcile.test.ts src/memory-host-sdk/host/mirror.test.ts
pnpm exec oxfmt --check --threads=1 packages/memory-host-sdk/src/host/workspace-reconcile.ts packages/memory-host-sdk/src/host/workspace-reconcile.test.ts src/memory-host-sdk/host/workspace-reconcile.ts src/memory-host-sdk/host/mirror.test.ts
```
Expected output:
```text
PASS  ... workspace-reconcile.test.ts
PASS  ... mirror.test.ts
```

---

### Task 2: Add the built Qdrant reconciliation command

**Files:**
- Create: `src/commands/qdrant-workspace-reconcile.ts`
- Create: `src/commands/qdrant-workspace-reconcile.test.ts`
- Create: `src/cli/qdrant-cli.ts`
- Modify: `src/cli/program/register.subclis-core.ts`

- [ ] **Step 1: Write failing command tests for dry-run/apply behavior**

Test cases should cover:
- dry-run prints counts and never calls delete/upsert
- apply upserts only new/changed points
- delete phase only runs after a successful full inventory build
- command defaults to `agent-memory`
- command reads the mounted uv Python path from a constant or overridable env var

Suggested command shape:
```bash
node dist/index.js qdrant workspace reconcile --dry-run --json
node dist/index.js qdrant workspace reconcile --apply --json
```

Suggested JSON envelope:
```json
{
  "ok": true,
  "mode": "dry-run",
  "collection": "agent-memory",
  "filesScanned": 0,
  "chunksBuilt": 0,
  "newPoints": 0,
  "updatedPoints": 0,
  "unchangedPoints": 0,
  "deletedPoints": 0
}
```

Run:
```bash
pnpm test src/commands/qdrant-workspace-reconcile.test.ts
```
Expected output:
```text
FAIL  ... qdrant-workspace-reconcile.test.ts
```

- [ ] **Step 2: Implement Qdrant HTTP inventory, diffing, and safe apply**

In `src/commands/qdrant-workspace-reconcile.ts`, implement:
- `runQdrantWorkspaceReconcileCommand(opts, runtime)`
- Qdrant HTTP helpers for:
  - collection info
  - scroll managed points (`managed_by == workspace-reconciler`)
  - upsert points
  - delete stale managed ids
- reconciliation phases:
  - build expected manifest
  - fetch managed live inventory
  - classify unchanged/new/updated/deleted
  - if `--apply`, embed changed/new, upsert, then delete stale
  - if any earlier phase fails, skip delete entirely

Use defaults aligned to the live host:
- Qdrant URL: `http://qdrant:6333` when running in container, overrideable
- collection: `agent-memory`
- workspace dir: `/home/node/.openclaw/workspace`

- [ ] **Step 3: Reuse the live FastEmbed runtime through the mounted uv toolchain**

Do not add a new repo dependency for embeddings.

Inside `src/commands/qdrant-workspace-reconcile.ts`, shell out to:
```text
/home/node/.openclaw/vendor/uv-tools/data/uv/tools/mcp-server-qdrant/bin/python
```

Use it as a narrow JSON bridge:
- stdin: `{ "texts": ["...", "..."] }`
- stdout: `{ "vectors": [[...], [...]] }`

The embedded Python snippet should:
- `from fastembed import TextEmbedding`
- initialize `TextEmbedding("sentence-transformers/all-MiniLM-L6-v2")`
- embed documents in batch
- emit JSON only

Reason for this design:
- exact model family and dimension match with the live Qdrant MCP stack
- no new host dependency tree
- no loose repo `scripts/` dependency at container runtime

- [ ] **Step 4: Register the CLI surface**

Create `src/cli/qdrant-cli.ts` with a new group:
```ts
qdrant workspace reconcile [--dry-run|--apply] [--json]
```

Wire it in `src/cli/program/register.subclis-core.ts`.

Expected help text:
```text
openclaw qdrant workspace reconcile --dry-run --json
```

- [ ] **Step 5: Re-run targeted tests**

Run:
```bash
pnpm test src/commands/qdrant-workspace-reconcile.test.ts
pnpm test src/cli/qdrant-cli.test.ts
```

If no dedicated CLI test exists yet, add one that proves the new command is registered and invokes the command handler.

Expected output:
```text
PASS  ... qdrant-workspace-reconcile.test.ts
PASS  ... qdrant-cli.test.ts
```

---

### Task 3: Add host automation templates

**Files:**
- Create: `scripts/systemd/openclaw-qdrant-workspace-reconcile.service`
- Create: `scripts/systemd/openclaw-qdrant-workspace-reconcile.timer`
- Create: `scripts/setup-qdrant-workspace-reconcile-system.sh`

- [ ] **Step 1: Add a user-level oneshot service template**

Service command should follow the existing QMD host pattern and execute inside the running gateway container:
```ini
[Unit]
Description=OpenClaw Qdrant workspace reconciliation
After=network.target docker.service

[Service]
Type=oneshot
ExecStart=/bin/bash -lc 'cd /home/ubuntu/godwind-team-docker/openclaw && /usr/bin/docker exec openclaw-openclaw-gateway-1 node dist/index.js qdrant workspace reconcile --apply >>$HOME/.openclaw-qdrant-workspace-reconcile.log 2>&1'
```

Rules:
- do not reference local repo paths in Mintlify docs; templates are fine here
- log to a dedicated host file
- keep the command non-interactive

- [ ] **Step 2: Add the timer template**

Timer target:
```ini
[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
Persistent=true
```

- [ ] **Step 3: Add a small install helper**

In `scripts/setup-qdrant-workspace-reconcile-system.sh`, follow the auth-monitor setup pattern:
- copy the two unit files into `~/.config/systemd/user/`
- run `systemctl --user daemon-reload`
- run `systemctl --user enable --now openclaw-qdrant-workspace-reconcile.timer`
- print `systemctl --user status` guidance

- [ ] **Step 4: Verify formatting / shell sanity**

Run:
```bash
pnpm exec oxfmt --check --threads=1 src/commands/qdrant-workspace-reconcile.ts src/commands/qdrant-workspace-reconcile.test.ts src/cli/qdrant-cli.ts
bash -n scripts/setup-qdrant-workspace-reconcile-system.sh
```
Expected output:
```text
[no output]
```

---

### Task 4: Build the image and prove the command in-container

**Files:** no source additions in this task; uses built artifacts from Tasks 1–3.

- [ ] **Step 1: Build the local image**

Run:
```bash
pnpm build
cd /home/ubuntu/godwind-team-docker/openclaw
docker compose build openclaw-gateway openclaw-cli
docker compose up -d openclaw-gateway openclaw-cli
```

Expected output:
```text
... Successfully tagged openclaw:local
... openclaw-openclaw-gateway-1  Started
```

- [ ] **Step 2: Smoke the new command in dry-run mode**

Run:
```bash
docker exec openclaw-openclaw-gateway-1 node dist/index.js qdrant workspace reconcile --dry-run --json
```

Expected output:
```json
{
  "ok": true,
  "mode": "dry-run",
  "collection": "agent-memory",
  "filesScanned": 1,
  "chunksBuilt": 1
}
```

Counts will be larger on the real host. The important proof is:
- `ok: true`
- `mode: "dry-run"`
- non-zero `filesScanned`

- [ ] **Step 3: Confirm the embedding bridge is using the mounted uv runtime**

Run:
```bash
docker exec openclaw-openclaw-gateway-1 sh -lc '/home/node/.openclaw/vendor/uv-tools/data/uv/tools/mcp-server-qdrant/bin/python - <<'"'"'PY'"'"'
from fastembed import TextEmbedding
model = TextEmbedding("sentence-transformers/all-MiniLM-L6-v2")
vec = next(model.embed(["workspace reconcile probe"]))
print(len(vec))
PY'
```

Expected output:
```text
384
```

---

### Task 5: Run the initial backfill and verify reconciliation semantics

**Files:**
- Temporary host probe file created under the approved corpus during verification

- [ ] **Step 1: Apply the initial reconciliation**

Run:
```bash
docker exec openclaw-openclaw-gateway-1 node dist/index.js qdrant workspace reconcile --apply --json
```

Expected output:
```json
{
  "ok": true,
  "mode": "apply",
  "newPoints": 1,
  "updatedPoints": 0,
  "deletedPoints": 0
}
```

The real backfill should raise `newPoints` well above `1`.

- [ ] **Step 2: Confirm collection growth**

Run:
```bash
curl -s http://127.0.0.1:6333/collections/agent-memory | jq '.result.points_count'
```

Expected output:
```text
<number greater than 1>
```

- [ ] **Step 3: Verify update behavior with a disposable managed file**

Create a disposable probe file in the approved corpus:
```bash
cat > /home/ubuntu/.openclaw/workspace/projects/qdrant-reconcile-smoke.md <<'EOF'
# Qdrant Reconcile Smoke

Version one marker.
EOF
```

Run:
```bash
docker exec openclaw-openclaw-gateway-1 node dist/index.js qdrant workspace reconcile --apply --json
curl -s http://127.0.0.1:6333/collections/agent-memory/scroll \
  -H 'Content-Type: application/json' \
  -d '{"limit":10,"with_payload":true,"filter":{"must":[{"key":"path","match":{"value":"projects/qdrant-reconcile-smoke.md"}}]}}' | jq '.result.points[0].payload.content_hash'
```

Then update the file:
```bash
cat > /home/ubuntu/.openclaw/workspace/projects/qdrant-reconcile-smoke.md <<'EOF'
# Qdrant Reconcile Smoke

Version two marker.
EOF
docker exec openclaw-openclaw-gateway-1 node dist/index.js qdrant workspace reconcile --apply --json
```

Expected result:
- the same `path` remains
- the stored `content_hash` changes
- `updatedPoints` increments by at least `1`

- [ ] **Step 4: Verify delete behavior**

Run:
```bash
rm /home/ubuntu/.openclaw/workspace/projects/qdrant-reconcile-smoke.md
docker exec openclaw-openclaw-gateway-1 node dist/index.js qdrant workspace reconcile --apply --json
curl -s http://127.0.0.1:6333/collections/agent-memory/scroll \
  -H 'Content-Type: application/json' \
  -d '{"limit":10,"with_payload":true,"filter":{"must":[{"key":"path","match":{"value":"projects/qdrant-reconcile-smoke.md"}}]}}' | jq '.result.points | length'
```

Expected output:
```text
0
```

- [ ] **Step 5: Verify persistence across Qdrant restart**

Run:
```bash
docker restart qdrant
sleep 5
curl -s http://127.0.0.1:6333/collections/agent-memory | jq '.result.points_count'
```

Expected output:
```text
<same or larger count than before restart>
```

---

### Task 6: Install and verify the automated timer

**Files:**
- Host copies of the systemd unit files under `~/.config/systemd/user/`

- [ ] **Step 1: Install the units**

Run:
```bash
cd /home/ubuntu/godwind-team-docker/openclaw
bash scripts/setup-qdrant-workspace-reconcile-system.sh
```

Expected output:
```text
Installed systemd timer...
Enabled and started openclaw-qdrant-workspace-reconcile.timer
```

- [ ] **Step 2: Confirm timer state**

Run:
```bash
systemctl --user status openclaw-qdrant-workspace-reconcile.timer --no-pager
systemctl --user list-timers --all | grep openclaw-qdrant-workspace-reconcile
```

Expected output:
- timer is `active (waiting)`
- next run is scheduled roughly 10 minutes out

- [ ] **Step 3: Trigger one manual run through systemd**

Run:
```bash
systemctl --user start openclaw-qdrant-workspace-reconcile.service
sleep 2
tail -50 ~/.openclaw-qdrant-workspace-reconcile.log
```

Expected output:
- a successful reconcile summary
- no Python import errors
- no Qdrant connectivity errors

---

### Task 7: Final verification and handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-05-17-qdrant-workspace-reconciliation.md` only if you need to check off items locally during execution
- Optionally update host-runbook files outside the repo after live rollout:
  - `~/.codex/HOST-STACK.md`
  - `~/.openclaw/workspace/MEMORY-ARCHITECTURE.md`
  - the active workspace project log for this rollout

- [ ] **Step 1: Run the narrow proof set one more time**

Run:
```bash
pnpm test packages/memory-host-sdk/src/host/workspace-reconcile.test.ts src/memory-host-sdk/host/mirror.test.ts src/commands/qdrant-workspace-reconcile.test.ts src/cli/qdrant-cli.test.ts
pnpm build
docker exec openclaw-openclaw-gateway-1 node dist/index.js qdrant workspace reconcile --dry-run --json
```

Expected output:
```text
PASS ...
```

- [ ] **Step 2: Summarize operational outcomes**

Capture:
- final `points_count`
- latest dry-run/apply counts
- timer status
- whether semantic recall now returns real workspace docs rather than only the rollout canary

- [ ] **Step 3: Commit repo changes intentionally**

Run:
```bash
scripts/committer "feat(memory): reconcile workspace markdown into qdrant" \
  packages/memory-host-sdk/src/host/workspace-reconcile.ts \
  packages/memory-host-sdk/src/host/workspace-reconcile.test.ts \
  packages/memory-host-sdk/src/engine-storage.ts \
  src/memory-host-sdk/host/workspace-reconcile.ts \
  src/memory-host-sdk/host/mirror.test.ts \
  src/commands/qdrant-workspace-reconcile.ts \
  src/commands/qdrant-workspace-reconcile.test.ts \
  src/cli/qdrant-cli.ts \
  src/cli/program/register.subclis-core.ts \
  scripts/systemd/openclaw-qdrant-workspace-reconcile.service \
  scripts/systemd/openclaw-qdrant-workspace-reconcile.timer \
  scripts/setup-qdrant-workspace-reconcile-system.sh \
  docs/superpowers/plans/2026-05-17-qdrant-workspace-reconciliation.md
```

Only include files actually created or modified by the final implementation.

---

## Continuation session — 2026-05-17 (Claude session)

Codex completed Tasks 1–3 (primitives, command module, CLI registration, systemd templates) and partially completed Task 4 (build and dry-run). The `--apply` path was failing with `TypeError: fetch failed` on the full 92-file/899-chunk workspace while a 1-file test workspace succeeded. Manual batch upsert of all 899 points outside the CLI framework also worked. Codex hit its usage limit while debugging this.

### Root cause: CLI container missing dist bind-mount

The gateway container (`openclaw-openclaw-gateway-1`) had `./dist:/app/dist` in `docker-compose.yml`, but the CLI container (`openclaw-openclaw-cli-1`) did not. The CLI container was running from the image's stale built-in dist (no UUID conversion for Qdrant point IDs, no named-vector format detection). The `--apply` path hit Qdrant with unnamed vectors, Qdrant rejected them, and undici's error message ("TypeError: fetch failed") was opaque.

**Fix:** Added `- ./dist:/app/dist` to the CLI container's volumes in `docker-compose.yml`, then recreated the container with `docker compose up -d openclaw-cli`.

**Why the dry-run worked but apply failed:** Dry-run calls `getQdrantCollectionInfo` (simple GET) and `scrollManagedWorkspacePoints` (POST with filter). These don't send vectors, so the old code succeeded on those calls. Apply additionally calls `upsertWorkspacePoints` which sends named vectors — the old code sent unnamed arrays, Qdrant rejected them, and the error propagated through `runCommandWithRuntime` → `runtime.error` → `runtime.exit`.

### Enhanced fetch error handling

Replaced the bare `await fetch(url, ...)` in `fetchQdrantJson` with a try/catch that extracts `code`, `syscall`, and `cause` from the undici error and produces a diagnostic message:

```
Qdrant fetch failed: http://qdrant:6333/collections/agent-memory/points?wait=true code=ECONNRESET syscall=read
```

This is in `src/commands/qdrant-workspace-reconcile.ts:160-186`.

### Stale-point deletion bug

`classifyWorkspacePoints` was returning workspace IDs (e.g. `workspace:test.md#0`) for deletion, and `deleteManagedWorkspacePointIds` was converting them to UUIDs via `workspaceIdToUuid()`. If multiple stale points share the same workspace ID but have different Qdrant point UUIDs (e.g. from repeated manual tests), only one UUID would be sent to the delete endpoint, and the others would remain. These points kept appearing as "3 stale" on every run without being removed.

**Fix (3 changes):**
1. `ManagedWorkspacePoint` type gained a `qdrantId: string` field to carry the actual Qdrant point UUID from scroll results
2. `scrollManagedWorkspacePoints` stores `String(point.id)` as `qdrantId`
3. `classifyWorkspacePoints` maps `toDelete` from `point.qdrantId` (real UUID) instead of `point.id` (workspace ID)
4. `deleteManagedWorkspacePointIds` passes Qdrant UUIDs directly to the delete endpoint without re-hashing

After fix: 3 stale points deleted on first run, 0 on second run (truly idempotent).

### Progress logging

Added operator-facing progress messages during apply:
- `Embedding N chunks...` (only when there's work to do)
- `Upserting N points...` (only when there's work to do)
- `Removing N stale points...` (only when there's work to do)

No output when the plan is already reconciled (idempotent runs are silent except for the summary).

### Systemd timer installed

Enabled user lingering (`sudo loginctl enable-linger ubuntu`), then ran `scripts/setup-qdrant-workspace-reconcile-system.sh`. Timer is active, triggered manually and verified:
- Service completes in ~3 seconds when idempotent (no embedding work)
- Log output written to `~/.openclaw-qdrant-workspace-reconcile.log`
- Timer fires every 10 minutes, 2-minute boot delay, persistent catch-up enabled

### Bootstrap and memory updates

1. `~/.codex/BOOTSTRAP.md` — added meta-obedience rule at top
2. Project memory `project_deployment.md` — added dist bind-mount requirement for both containers, CLI container info
3. `~/.codex/HOST-STACK.md` — (pending update: Qdrant caveat is now stale; agent-memory holds 899 real workspace chunks)

### Operational outcomes at handoff

```
pnpm test (4 test files, 3 shards): 18 passed, 0 failed
pnpm build: clean
docker-compose.yml: both containers have ./dist:/app/dist bind-mount

Dry-run:  {"ok":true,"mode":"dry-run","filesScanned":92,"chunksBuilt":899,"newPoints":0,"updatedPoints":0,"unchangedPoints":899,"deletedPoints":0}
Apply:    {"ok":true,"mode":"apply",  "filesScanned":92,"chunksBuilt":899,"newPoints":0,"updatedPoints":0,"unchangedPoints":899,"deletedPoints":0}

Qdrant collection: agent-memory
Points in collection: 899 managed + rollout canary data
Vector: fast-all-minilm-l6-v2 (384-dim, Cosine)
Timer: active, next fire ~10 min, logs: ~/.openclaw-qdrant-workspace-reconcile.log
```
