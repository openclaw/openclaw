# Claude-Context MCP — Validation Report (2026-05-20)

**Validator:** general-purpose subagent  
**Plan executed:** `docs/superpowers/plans/claude-context-MCP-openclaw/claude-context-openclaw-validation.md`  
**Rollout under test:** Phases 1–3 of `claude-context-openclaw-implementation.md`  
**Overall verdict:** FAIL

## Summary table

| Phase | Check | Result | One-line note |
|---|---|---|---|
| V1 | V1.1 binary spawn | FAIL | Raw stdin probe started the server but never emitted JSON-RPC on stdout. |
| V1 | V1.2 milvus | PASS | `milvus-standalone:9091/healthz` returned `OK` from the gateway container. |
| V1 | V1.3 ollama | PASS | In-container Ollama exposed `nomic-embed-text:latest` with the expected digest. |
| V1 | V1.4 gateway logs clean | PASS | No `claude-context`/MCP error lines in the log error scan. |
| V2 | V2.1 read tools exposed | FAIL | Raw claude-context MCP lists read tools, but live OpenClaw runtime rejects them as unavailable. |
| V2 | V2.2 write tools denied | PASS | Denylist entries are present and write tools are unavailable through the gateway runtime. |
| V2 | V2.3 denied tool rejected | PASS | Direct runtime invocation of `mcp__claude-context__index_codebase` returned `Tool not available`. |
| V3 | V3.1 get_indexing_status | FAIL | Live agent called the tool, but the host path does not exist inside the container. |
| V3 | V3.2 search_code query 1 | FAIL | Live agent called `search_code`, but the same host-path existence check failed. |
| V3 | V3.3 search_code query 2 | FAIL | Live agent called `search_code`, but the same host-path existence check failed. |
| V4 | V4.1 qmd corpus | FAIL | Live agent returned `No results found` for the requested lexical query. |
| V4 | V4.2 qdrant corpus | FAIL | Live agent returned hits, but the top result did not include reconciler-owned `managed_by` proof. |
| V4 | V4.3 control UI serves | FAIL | Gateway root returned `503` because Control UI assets are missing. |
| V4 | V4.4 discord unchanged | PASS | Gateway health shows Discord `configured: true`, `running: true`, `connected: true`. |
| V4 | V4.5 reconciler points intact | PASS | Qdrant reports `points_count: 940` and returns a `workspace-reconciler` sample point. |
| V4 | V4.6 restart idempotency | FAIL | Gateway restarted cleanly, but claude-context read tool remained unavailable afterward. |

## Failure details

### V1.1 — binary spawn

- **Command run:** `docker exec -i -u node openclaw-openclaw-gateway-1 env MILVUS_ADDRESS=milvus-standalone:19530 EMBEDDING_PROVIDER=Ollama OLLAMA_HOST=http://ollama:11434 OLLAMA_MODEL=nomic-embed-text node /usr/lib/node_modules/@zilliz/claude-context-mcp/dist/index.js <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"validate","version":"0"}}}' | head -c 2000`
- **Output:** `MCP server started and listening on stdio.` with no JSON-RPC response on stdout.
- **Root-cause hypothesis:** The plan's raw one-shot stdin probe does not match how this MCP server expects framed stdio traffic, even though the server itself does start successfully.
- **Classification:** environment quirk
- **Recommended rollback step (do not apply):** none, this is unrelated

### V2.1 — read tools exposed

- **Command run:** `docker exec -u node -w /app openclaw-openclaw-gateway-1 node openclaw.mjs gateway call tools.invoke --json --params '{"sessionKey":"agent:main:main","name":"mcp__claude-context__get_indexing_status","args":{"path":"/home/ubuntu/godwind-team-docker/openclaw"}}'`
- **Output:** `{"ok":false,"toolName":"mcp__claude-context__get_indexing_status","error":{"code":"not_found","message":"Tool not available: mcp__claude-context__get_indexing_status"}}`
- **Root-cause hypothesis:** The claude-context server is registered, but the live OpenClaw runtime is not exposing claude-context MCP tools into the effective tool inventory.
- **Classification:** rollout-caused
- **Recommended rollback step (do not apply):** restore `/home/node/.openclaw/openclaw.json` from `openclaw.json.bak.pre-claude-context-20260519T222038Z` and restart `openclaw-openclaw-gateway-1`

### V3.1 — get_indexing_status

- **Command run:** Live Discord prompt: `Call get_indexing_status for path /home/ubuntu/godwind-team-docker/openclaw and report the raw result only.`
- **Output:** `Error: Path '/home/ubuntu/godwind-team-docker/openclaw' does not exist. Original input: '/home/ubuntu/godwind-team-docker/openclaw'`
- **Root-cause hypothesis:** The validation plan assumes the host path is a pure index key, but the live claude-context tool first checks path existence inside the gateway container, where the repo is mounted at `/app`.
- **Classification:** rollout-caused
- **Recommended rollback step (do not apply):** restore `/home/node/.openclaw/openclaw.json` from `openclaw.json.bak.pre-claude-context-20260519T222038Z` and restart `openclaw-openclaw-gateway-1`

### V3.2 — search_code query 1

- **Command run:** Live Discord prompt: `Call search_code with path /home/ubuntu/godwind-team-docker/openclaw and query "workspace reconciler payload schema". Show the top three hits with file paths only.`
- **Output:** `Error: Path '/home/ubuntu/godwind-team-docker/openclaw' does not exist. Original input: '/home/ubuntu/godwind-team-docker/openclaw'`
- **Root-cause hypothesis:** The same host-path versus in-container-path mismatch from V3.1 blocks semantic search before retrieval starts.
- **Classification:** rollout-caused
- **Recommended rollback step (do not apply):** restore `/home/node/.openclaw/openclaw.json` from `openclaw.json.bak.pre-claude-context-20260519T222038Z` and restart `openclaw-openclaw-gateway-1`

### V3.3 — search_code query 2

- **Command run:** Live Discord prompt: `Call search_code with path /home/ubuntu/godwind-team-docker/openclaw and query "FastEmbed bridge". Show the top three hits with file paths only.`
- **Output:** `Error: Path '/home/ubuntu/godwind-team-docker/openclaw' does not exist. Original input: '/home/ubuntu/godwind-team-docker/openclaw'`
- **Root-cause hypothesis:** The same host-path versus in-container-path mismatch from V3.1 blocks semantic search before retrieval starts.
- **Classification:** rollout-caused
- **Recommended rollback step (do not apply):** restore `/home/node/.openclaw/openclaw.json` from `openclaw.json.bak.pre-claude-context-20260519T222038Z` and restart `openclaw-openclaw-gateway-1`

### V4.1 — qmd corpus

- **Command run:** Live Discord prompt: `Use qmd search to find notes mentioning "qdrant reconciliation". Show the top result only.`
- **Output:** `No results found for ""qdrant reconciliation""`
- **Root-cause hypothesis:** Either the exact lexical phrase is absent from the indexed QMD corpus the agent sees, or the live QMD tool path is not returning the intended corpus slice for this query.
- **Classification:** unknown
- **Recommended rollback step (do not apply):** none, this is unrelated

### V4.2 — qdrant corpus

- **Command run:** Live Discord prompt: `Use qdrant-find to find notes mentioning "qdrant reconciliation". Show the top result only, including the payload field managed_by if present.`
- **Output:** `<entry><content>## QMD status mismatch</content><metadata></metadata></entry>`
- **Root-cause hypothesis:** Qdrant semantic retrieval is working, but the top returned result is not one of the reconciler-owned points needed to satisfy the plan's ownership proof.
- **Classification:** unknown
- **Recommended rollback step (do not apply):** none, this is unrelated

### V4.3 — control UI serves

- **Command run:** `curl -sS -m 5 -o /tmp/v43.out -w '%{http_code}\n' http://127.0.0.1:18789/; echo BODY; head -c 300 /tmp/v43.out`
- **Output:** `503` and `Control UI assets not found. Build them with \`pnpm ui:build\`...`
- **Root-cause hypothesis:** The gateway root is unhealthy in this environment because Control UI build artifacts are missing from `/app/dist/control-ui`.
- **Classification:** pre-existing
- **Recommended rollback step (do not apply):** none, this is unrelated

### V4.6 — restart idempotency

- **Command run:** `docker exec -u node -w /app openclaw-openclaw-gateway-1 node openclaw.mjs gateway call tools.invoke --json --params '{"sessionKey":"agent:main:main","name":"mcp__claude-context__get_indexing_status","args":{"path":"/home/ubuntu/godwind-team-docker/openclaw"}}'`
- **Output:** `{"ok":false,"toolName":"mcp__claude-context__get_indexing_status","error":{"code":"not_found","message":"Tool not available: mcp__claude-context__get_indexing_status"}}`
- **Root-cause hypothesis:** Restart preserved the same underlying runtime exposure failure from V2.1; the claude-context read tools still do not materialize in the live tool inventory.
- **Classification:** rollout-caused
- **Recommended rollback step (do not apply):** restore `/home/node/.openclaw/openclaw.json` from `openclaw.json.bak.pre-claude-context-20260519T222038Z` and restart `openclaw-openclaw-gateway-1`

## PASS details (terse)

- `V1.2` Milvus is reachable from the gateway container.
- `V1.3` In-container Ollama exposes the expected `nomic-embed-text:latest` model digest.
- `V1.4` Gateway logs showed no `claude-context`/MCP error lines during the scan window.
- `V2.2` Denylist entries for `index_codebase` and `clear_index` are present in the live config.
- `V2.3` Direct runtime invocation of the denied write tool is rejected.
- `V4.4` Discord remains configured, running, and connected according to live gateway health.
- `V4.5` Qdrant `agent-memory` still contains reconciler-owned points and reports `points_count: 940`.

## Notes for triage

- The internal HTTP endpoints in the validation plan do not exist in this build. Validation used the documented stdio fallback, stored session history, and live gateway RPC instead.
- The gateway is published on host port `18789`, not `23119`. The gateway root and health checks were evaluated against the live published port.
- The no-reply symptom in Discord was a delivery problem, not an agent-run failure. The agent completed all prompted runs and stored final replies in session history. Before restart, gateway logs showed `Outbound not configured for channel: discord`; after restart, delivery recovery replayed the five pending Discord replies successfully.
- Direct MCP proof showed `/app` exists inside the gateway container but is not indexed, while the validation plan's canonical host path `/home/ubuntu/godwind-team-docker/openclaw` fails the tool's path-existence check in-container. That path semantics mismatch blocks all V3 claude-context proofs.
- The live gateway runtime behavior is inconsistent across validation surfaces: the agent session did call `claude-context__*`, `qmd__query`, and `qdrant__qdrant-find`, but direct `tools.invoke` RPC by MCP-prefixed name returned `Tool not available`. That ordering matters: V2 red is about direct runtime exposure, while V3/V4 live prompts prove the agent-path surface can still resolve some MCP tools.
- `V4.3` is environment-specific Control UI artifact drift and does not appear causally tied to the claude-context rollout.

## Sign-off checklist

- [ ] V1.1 — V1.4 all PASS
- [ ] V2.1 — V2.3 all PASS
- [ ] V3.1 — V3.3 all PASS
- [ ] V4.1 — V4.6 all PASS
- [x] No leaked secret-bearing config dumps in conversation, logs, or screenshots during validation
- [ ] Implementation plan file (`claude-context-openclaw-implementation.md`) updated to mark each phase as complete, OR a short "Validation log" section appended to that file capturing date + who ran it

## Diagnosis appendix (post-debug)

### Direct RPC vs embedded-run tool-surface split

- `tools.invoke` is not a valid proxy for live bundle-MCP availability in this build.
- Direct gateway RPC resolves tools from the gateway-scoped inventory in `src/gateway/tools-invoke-shared.ts` and `src/gateway/tool-resolution.ts`.
- Live Discord/embedded runs separately materialize bundle-MCP tools through the session MCP runtime in `src/agents/pi-embedded-runner/run/attempt.ts` and `src/agents/pi-bundle-mcp-materialize.ts`.
- Practical consequence: the earlier `tools.invoke(... mcp__claude-context__...)` `not_found` result was a surface mismatch, not proof that live `claude-context__*` names were absent.

### QMD anomaly classification

- Direct post-debug CLI probes showed no QMD collections and `0 files indexed`, so the earlier `qmd__query` miss is not a claude-context rollout regression.
- The first direct probe used `-c memory-dir-main`, but that collection does not exist in the current local QMD state.
- Classification: pre-existing / separate memory-stack issue.

### qdrant-find rendering anomaly classification

- The installed `mcp-server-qdrant` code formats hits as `<entry><content>...</content><metadata>...</metadata></entry>`.
- Empty `<metadata></metadata>` in the live reply is expected when the returned entry does not carry metadata, so that specific output shape is not itself a bug.
- The remaining issue is result selection: the top semantic hit was not one of the reconciler-owned points needed by the original validation check.

### Control UI 503 exclusion

- The `503` on the gateway root remains an environment-specific Control UI artifact issue (`/app/dist/control-ui` missing), not a claude-context regression.
- It stays excluded from rollout-causality.

## Re-validation log v2 (2026-05-20)

| Area | Result | Note |
|---|---|---|
| Runtime surface diagnosis | PASS | Source and transcript evidence confirmed that direct RPC and live embedded runs do not share the same effective MCP tool inventory. |
| Live write-tool deny enforcement | FAIL | After correcting `gateway.tools.deny` to `claude-context__index_codebase` / `claude-context__clear_index`, the live Discord run still executed `claude-context__index_codebase`. |
| Host-path mirror bind-mount | PASS | `docker-compose.yml` now mirrors `/home/ubuntu/godwind-team-docker/openclaw` into the container at the same absolute path. |
| Live `get_indexing_status` before restart | FAIL | First re-run returned `Codebase '/home/ubuntu/godwind-team-docker/openclaw' is not indexed.` |
| Live `search_code` query 1 | PASS | Returned `packages/memory-host-sdk/src/host/workspace-reconcile.ts` for `workspace reconciler payload schema`. |
| Live `search_code` query 2 | PASS | Returned `src/commands/qdrant-workspace-reconcile.ts` for `FastEmbed bridge` (with one noisy `AGENTS.md` hit ranked first). |
| Gateway restart health | PASS | Gateway health recovered after restart; Discord reconnected after a short settling window. |
| Live `get_indexing_status` after restart | PASS | Post-restart re-run reported the host path fully indexed with `171933 files, 171933 chunks`. |

**Final overall verdict after debug:** `FAIL`

Why it remains red:

- The primary claude-context read path is now working on the live Discord surface.
- The remaining rollout-caused blocker is safety-critical: `gateway.tools.deny` is still not enforced for live bundle-MCP claude-context write tools in embedded runs.

## Updated sign-off checklist (post-debug)

- [ ] V1.1 — V1.4 all PASS
- [ ] V2.1 — V2.3 all PASS
- [x] V3.1 — V3.3 all PASS on the live embedded-run surface after the host-path mirror fix
- [ ] V4.1 — V4.6 all PASS
- [x] No leaked secret-bearing config dumps in conversation, logs, or screenshots during validation
- [x] Implementation plan file (`claude-context-openclaw-implementation.md`) updated with a short validation-complete note
