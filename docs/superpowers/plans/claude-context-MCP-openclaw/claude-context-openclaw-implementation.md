# Claude-Context MCP → OpenClaw Implementation Plan

> **For agentic workers:** Each phase is a self-contained handoff with its own sub-agent. Phases are sequential (later phases depend on earlier ones). Steps inside a task use checkbox (`- [ ]`) syntax. **No testing is included here** — post-implementation validation lives in the sibling file `claude-context-openclaw-validation.md`.

**Goal:** Wire the host-installed `claude-context` MCP server into OpenClaw's gateway agent in read-only mode, so the agent can semantically search any codebase indexed by `claude-context` (Milvus + Ollama on the host) without duplicating any indexing infrastructure.

**Architecture:**
- claude-context-mcp (`@zilliz/claude-context-mcp@0.1.7`) already runs on the host for Claude Code, backed by Milvus at `127.0.0.1:19530` and Ollama (`nomic-embed-text`) at `127.0.0.1:11434`.
- The gateway container shares the `openclaw_default` Docker network with `milvus-standalone` (at `milvus-standalone:19530`) **and** with a Compose `ollama` service (at `ollama:11434`) that hosts an identical-digest `nomic-embed-text:latest` model. The container reaches Ollama via the in-network service name, not via `host.docker.internal` — the host's Ollama binds to `127.0.0.1` only and is unreachable from inside the container. Embeddings produced by the in-network Ollama match the indexed corpus on Milvus because the model digest is identical.
- We bind-mount the host's `@zilliz/claude-context-mcp` package into the gateway container, register it as a stdio MCP server in OpenClaw's `~/.openclaw/openclaw.json`, and use `gateway.tools.deny` to block the two write tools (`index_codebase`, `clear_index`) so the agent only consumes the index, never mutates it.
- The agent will reach for `search_code` against codebase paths the user has indexed (canonical: `/home/ubuntu/godwind-team-docker/openclaw`). The recommendation is to document those paths in `TOOLS.md` so the agent doesn't guess.

**Tech Stack:** Docker Compose (bind-mount only, no image rebuild), Node 22 (already in gateway image), JSON5 config, OpenClaw's MCP runtime, Milvus, Ollama.

**Constraints (standing project rules):**
- Bind-mount, never rebuild images.
- Workspace writes go through `docker exec -u node openclaw-openclaw-gateway-1 ...`.
- Never dump `.env` / credential file contents.

**Parked TODO (out of scope for this rollout, do not attempt here):**
- Session-transcript indexing collection is currently inactive after disabling certain OpenClaw defaults. A future rollout will rewrite the transcript collection script to feed clean, lean, readable daily logs into QMD/Qdrant. Tracked here only to keep it visible — not part of this plan.

---

## Phase 1 — Container plumbing (mount the host binary into the gateway)

**Designated sub-agent:** `general-purpose`
**Handoff scope:** make `claude-context-mcp`'s entrypoint executable from inside the gateway container without rebuilding the image. Phase 1 ends when the binary spawns cleanly from inside the container.

### Task 1.1 — Add bind-mounts for the claude-context-mcp package

**Files:**
- Modify: `/home/ubuntu/godwind-team-docker/openclaw/docker-compose.yml` (gateway service `volumes:` block — find the block that already contains workspace bind-mounts; this is the standing edit point per project rules)

**Context:** The host symlink `/usr/bin/claude-context-mcp` → `/usr/lib/node_modules/@zilliz/claude-context-mcp/dist/index.js` is an ESM Node script. The package's own `node_modules` live under `/usr/lib/node_modules/@zilliz/claude-context-mcp/node_modules/`. We mount the whole `@zilliz` scope at the same path so Node module resolution works unchanged, and the container's existing `/usr/local/bin/node` runs the entrypoint directly.

- [ ] **Step 1: Append two read-only bind-mount entries to the gateway service's `volumes:` list**

```yaml
      - /usr/lib/node_modules/@zilliz:/usr/lib/node_modules/@zilliz:ro
      - /usr/bin/claude-context-mcp:/usr/local/bin/claude-context-mcp:ro
```

The first mount is the package source + its `node_modules`. The second mount is a convenience shim so `claude-context-mcp` resolves on `PATH`; it follows the host symlink at mount time so the in-container path is a real file pointing at the entrypoint.

- [ ] **Step 2: Recreate the gateway container so the mounts take effect**

```bash
cd /home/ubuntu/godwind-team-docker/openclaw
docker compose up -d --no-build openclaw-gateway
```

`--no-build` is critical: standing rule is bind-mount, never rebuild.

- [ ] **Step 3: Confirm the package is visible inside the container**

```bash
docker exec -u node openclaw-openclaw-gateway-1 ls /usr/lib/node_modules/@zilliz/claude-context-mcp/dist/index.js
docker exec -u node openclaw-openclaw-gateway-1 ls -la /usr/local/bin/claude-context-mcp
```

Expected: both paths resolve. The first is a regular file in the mount; the second is a regular file (because the host symlink target was followed at mount time).

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/godwind-team-docker/openclaw
git add docker-compose.yml
git commit -m "infra(gateway): bind-mount @zilliz/claude-context-mcp into container"
```

---

### Task 1.2 — Confirm the entrypoint spawns and the MCP handshake works over stdio

**Files:** none (smoke-only)

**Context:** Before wiring OpenClaw at it, prove the binary actually starts inside the container, can reach Milvus and Ollama, and speaks MCP over stdio.

- [ ] **Step 1: Send a one-line MCP `initialize` request over stdio and verify a JSON response**

```bash
docker exec -i -u node openclaw-openclaw-gateway-1 \
  env MILVUS_ADDRESS=milvus-standalone:19530 \
      EMBEDDING_PROVIDER=Ollama \
      OLLAMA_HOST=http://ollama:11434 \
      OLLAMA_MODEL=nomic-embed-text \
  node /usr/lib/node_modules/@zilliz/claude-context-mcp/dist/index.js \
  <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | head -c 2000
```

Expected: a JSON-RPC response containing `"serverInfo"` and `"capabilities"`. Anything that fails here (missing module, can't reach Milvus, Ollama unreachable) blocks Phase 2 — fix before continuing.

- [ ] **Step 2: Confirm reachability of both backends from inside the container (sanity)**

```bash
docker exec -u node openclaw-openclaw-gateway-1 \
  sh -c 'curl -s -m 3 http://milvus-standalone:9091/healthz && echo " milvus OK"; \
         curl -s -m 3 http://ollama:11434/api/tags >/dev/null && echo "ollama OK"'
```

Expected: `OK milvus OK` and `ollama OK`. If either fails, abort phase — no point wiring OpenClaw at an unreachable backend.

- [ ] **Step 3: No commit (smoke-only)**

---

## Phase 2 — Register MCP server + lock down to read-only

**Designated sub-agent:** `general-purpose`
**Handoff scope:** add the MCP server entry to OpenClaw's agent config and deny the two write tools at the gateway level. Phase 2 ends when the gateway restarts cleanly and the four expected tool names appear with the two write tools blocked.

### Task 2.1 — Add `claude-context` to `mcp.servers` in `~/.openclaw/openclaw.json`

**Files:**
- Modify: `~/.openclaw/openclaw.json` (the live agent config — same file that already contains `mcp.servers.qmd` and `mcp.servers.qdrant`)

**Context:** OpenClaw's `McpServerConfig` type (`src/config/types.mcp.ts`) accepts `command`, `args`, `env`, `cwd`. Existing entries (`qmd`, `qdrant`) use absolute binary paths and pass env vars for backend wiring — we follow the same pattern. The command runs `node` directly against the entrypoint so we don't depend on `PATH` resolution semantics differing between host and container.

- [ ] **Step 1: Take a timestamped backup of the live config (it has a long history of `.bak` / `.clobbered` snapshots — keep the discipline)**

```bash
docker exec -u node openclaw-openclaw-gateway-1 \
  cp /home/node/.openclaw/openclaw.json \
     /home/node/.openclaw/openclaw.json.bak.pre-claude-context-$(date -u +%Y%m%dT%H%M%SZ)
```

- [ ] **Step 2: Write a one-off Python edit script and run it inside the container**

Write the script locally first (workspace-edits rule: structured edits go via a Python script `docker cp`'d into `/tmp/` and executed inside the container).

Local file `claude-context-mcp-add.py`:

```python
import json
from pathlib import Path

CONFIG_PATH = Path("/home/node/.openclaw/openclaw.json")
data = json.loads(CONFIG_PATH.read_text())

data.setdefault("mcp", {}).setdefault("servers", {})
data["mcp"]["servers"]["claude-context"] = {
    "command": "node",
    "args": ["/usr/lib/node_modules/@zilliz/claude-context-mcp/dist/index.js"],
    "env": {
        "MILVUS_ADDRESS": "milvus-standalone:19530",
        "EMBEDDING_PROVIDER": "Ollama",
        "OLLAMA_HOST": "http://ollama:11434",
        "OLLAMA_MODEL": "nomic-embed-text",
    },
}

CONFIG_PATH.write_text(json.dumps(data, indent=2) + "\n")
print("ok: mcp.servers.claude-context registered")
```

Then copy + run:

```bash
docker cp claude-context-mcp-add.py openclaw-openclaw-gateway-1:/tmp/claude-context-mcp-add.py
docker exec -u node openclaw-openclaw-gateway-1 python3 /tmp/claude-context-mcp-add.py
```

Expected stdout: `ok: mcp.servers.claude-context registered`.

- [ ] **Step 3: Verify only the shape is present (no secret-bearing dump — name + command + env-key list only)**

```bash
docker exec -u node openclaw-openclaw-gateway-1 python3 - <<'PY'
import json
d = json.load(open("/home/node/.openclaw/openclaw.json"))
s = d["mcp"]["servers"]["claude-context"]
print("command:", s["command"])
print("args:", s["args"])
print("env keys:", list(s["env"].keys()))
PY
```

Expected: `command: node`, `args` is the entrypoint, `env keys: ['MILVUS_ADDRESS', 'EMBEDDING_PROVIDER', 'OLLAMA_HOST', 'OLLAMA_MODEL']`.

- [ ] **Step 4: No git commit (workspace-side config, not repo-tracked)**

---

### Task 2.2 — Deny the two write tools via `gateway.tools.deny`

**Files:**
- Modify: `~/.openclaw/openclaw.json` (top-level `gateway.tools.deny` array)

**Context:** OpenClaw's read-only gate for inbound MCP tools is the gateway-level denylist (`src/config/types.gateway.ts:404`, `src/config/schema.help.ts:97`). The denylist applies after MCP tool discovery and supports glob matching against the MCP-prefixed tool names. claude-context-mcp exposes four tools; we want only `search_code` and `get_indexing_status` reachable.

- [ ] **Step 1: Append the two denylist entries**

Local file `claude-context-mcp-readonly.py`:

```python
import json
from pathlib import Path

CONFIG_PATH = Path("/home/node/.openclaw/openclaw.json")
data = json.loads(CONFIG_PATH.read_text())

deny = data.setdefault("gateway", {}).setdefault("tools", {}).setdefault("deny", [])
for name in ("mcp__claude-context__index_codebase", "mcp__claude-context__clear_index"):
    if name not in deny:
        deny.append(name)

CONFIG_PATH.write_text(json.dumps(data, indent=2) + "\n")
print("ok: gateway.tools.deny extended:", deny)
```

```bash
docker cp claude-context-mcp-readonly.py openclaw-openclaw-gateway-1:/tmp/claude-context-mcp-readonly.py
docker exec -u node openclaw-openclaw-gateway-1 python3 /tmp/claude-context-mcp-readonly.py
```

Expected stdout: a list that includes both `mcp__claude-context__index_codebase` and `mcp__claude-context__clear_index` (alongside any pre-existing deny entries).

- [ ] **Step 2: Restart the gateway container so config reloads**

```bash
docker restart openclaw-openclaw-gateway-1
```

- [ ] **Step 3: Confirm the gateway booted without MCP errors**

```bash
docker logs --since 60s openclaw-openclaw-gateway-1 2>&1 | grep -iE "claude-context|mcp.*error|denylist" | head -20
```

Expected: a log line showing the `claude-context` MCP server registering (start/handshake), and no `error` lines tied to it.

- [ ] **Step 4: No git commit (workspace-side config)**

---

### Task 2.3 — Sanity-check the live tool surface

**Files:** none (read-only verification)

**Context:** Phase-end gate. Confirms exactly the read tools are reachable and the write tools are filtered. Detailed agent-side functional testing belongs to the validation plan; this step only proves the gateway sees what it should see.

- [ ] **Step 1: Query the gateway's MCP tool registry for `claude-context` entries**

```bash
docker exec -u node openclaw-openclaw-gateway-1 \
  bash -c 'curl -s -m 5 http://127.0.0.1:23119/internal/mcp/tools 2>/dev/null \
           | python3 -c "import json,sys; d=json.load(sys.stdin); names=[t[\"name\"] for t in d.get(\"tools\",[]) if \"claude-context\" in t[\"name\"]]; print(sorted(names))"'
```

Expected: a list containing `mcp__claude-context__search_code` and `mcp__claude-context__get_indexing_status` and **not** containing the two `*_codebase`/`clear_*` names.

(If the internal MCP tool endpoint name differs in this gateway build, fall back to grepping the gateway log for tool-registration lines — the goal is binary proof that the two write tools were filtered.)

- [ ] **Step 2: No commit**

---

## Phase 3 — Document the new tool in the agent's bootstrap files

**Designated sub-agent:** `general-purpose`
**Handoff scope:** make the agent aware of when to use claude-context vs the memory tools, and document the canonical indexed-codebase paths so the agent doesn't have to guess. All writes go via `docker exec -u node` per the workspace-write rule. Phase 3 ends when the three bootstrap files include the new tool documentation.

### Task 3.1 — Document `search_code` and canonical paths in `TOOLS.md`

**Files:**
- Modify: `workspace/TOOLS.md` (in-container path: `/home/node/.openclaw/workspace/TOOLS.md`)

**Context:** The user explicitly asked that the canonical indexed-codebase paths be documented in the plan and in the agent's tool reference so the agent doesn't guess. claude-context keys collections by absolute path string at index time; the OpenClaw agent does not need filesystem access to those paths, it only needs to pass them as the `path` argument.

- [ ] **Step 1: Append a "Codebase semantic search" section to `TOOLS.md`**

Write the patch locally as `tools-md-claude-context.py`:

```python
from pathlib import Path

target = "/home/node/.openclaw/workspace/TOOLS.md"
text = Path(target).read_text()

section = """

## Codebase semantic search (claude-context MCP)

Use `mcp__claude-context__search_code` for semantic queries over any codebase indexed by the host's claude-context plugin. The backing store is Milvus, embeddings are local Ollama `nomic-embed-text`. This is read-only from the agent's side — `index_codebase` and `clear_index` are blocked at the gateway and must not be attempted.

**Companion read tool:** `mcp__claude-context__get_indexing_status` — returns whether a given codebase path is indexed and how fresh it is.

**Canonical indexed codebase paths (recommendation):**

- `/home/ubuntu/godwind-team-docker/openclaw` — the live openclaw checkout used by Claude Code on the host. Default target for repo-level code questions.

Additional codebases the user has indexed via claude-context on the host are also reachable — pass the absolute host path as the `path` argument. If unsure whether a path is indexed, call `get_indexing_status` first.

**When to use this vs memory tools:**

| Question shape | Tool |
|---|---|
| "Where is X implemented in code?" / "Find functions that do Y" | `mcp__claude-context__search_code` |
| "What did we decide / learn / write down about Z?" | `qdrant-find` (semantic) or `qmd` (lexical) |
| "Exact symbol / file by name" | `rtk grep` / `rtk find` directly |
"""

if "Codebase semantic search (claude-context MCP)" not in text:
    Path(target).write_text(text.rstrip() + section + "\n")
    print("ok: appended")
else:
    print("ok: already present")
```

```bash
docker cp tools-md-claude-context.py openclaw-openclaw-gateway-1:/tmp/tools-md-claude-context.py
docker exec -u node openclaw-openclaw-gateway-1 python3 /tmp/tools-md-claude-context.py
```

Expected stdout: `ok: appended` (or `ok: already present` on a re-run).

- [ ] **Step 2: No git commit (workspace file is not in this repo)**

---

### Task 3.2 — Add the codebase search lane to `MEMORY-ARCHITECTURE.md`

**Files:**
- Modify: `workspace/MEMORY-ARCHITECTURE.md` (in-container path: `/home/node/.openclaw/workspace/MEMORY-ARCHITECTURE.md`)

**Context:** The agent's mental model of its own memory stack lives in this file. The user wants a clean separation: main memory corpus stays clean, codebase queries route to claude-context. Document the triad explicitly.

- [ ] **Step 1: Append a "Codebase search lane" section**

Local `memory-arch-claude-context.py`:

```python
from pathlib import Path

target = "/home/node/.openclaw/workspace/MEMORY-ARCHITECTURE.md"
text = Path(target).read_text()

section = """

## Codebase search lane (separate from main memory)

The main memory corpus (workspace markdown indexed by QMD lexical + Qdrant semantic into `agent-memory`) deliberately excludes vendored/upstream code clones. Codebase queries go to a third lane:

- **Tool:** `mcp__claude-context__search_code` (read-only — write tools are blocked at the gateway).
- **Backing store:** Milvus on the host, populated by the user's Claude Code claude-context plugin.
- **Embeddings:** local Ollama `nomic-embed-text` (same vector space across all claude-context queries).
- **Scope:** any codebase path the user has indexed on the host. Canonical default: `/home/ubuntu/godwind-team-docker/openclaw`.

Why it lives outside `agent-memory`:

- Codebase content (often 100k+ chunks) would dominate semantic memory and dilute recall on real notes/decisions.
- Code reindex cadence is owned by Claude Code on the host, not by the OpenClaw reconciler.
- Vector spaces match across all claude-context queries (`nomic-embed-text`); `agent-memory` uses FastEmbed MiniLM. Keeping them separate avoids cross-space ranking issues.

What stays in the **main memory corpus** (do not migrate into the codebase lane):

- `MEMORY.md`, `memory/`, `rules-vault/`, `projects/`, top-level bootstrap markdown (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, etc.), and any small operational subdirs (`plans/`, `reports/`, `debug/`, `tasks/`, `worker/`).

What stays in the **codebase lane** (do not duplicate into main memory):

- The host's openclaw checkout (`/home/ubuntu/godwind-team-docker/openclaw`).
- The vendored upstream clone (`workspace/reference/openclaw-upstream/`) — query it via claude-context if the user has indexed it on the host; otherwise leave it unindexed.
- The vendored superpowers tree (`workspace/.superpowers/`) — same rule.
"""

if "Codebase search lane (separate from main memory)" not in text:
    Path(target).write_text(text.rstrip() + section + "\n")
    print("ok: appended")
else:
    print("ok: already present")
```

```bash
docker cp memory-arch-claude-context.py openclaw-openclaw-gateway-1:/tmp/memory-arch-claude-context.py
docker exec -u node openclaw-openclaw-gateway-1 python3 /tmp/memory-arch-claude-context.py
```

Expected: `ok: appended`.

- [ ] **Step 2: No git commit (workspace file is not in this repo)**

---

### Task 3.3 — Add a "Codebase search" line to `AGENTS.md`

**Files:**
- Modify: `workspace/AGENTS.md` (in-container path: `/home/node/.openclaw/workspace/AGENTS.md`)

**Context:** `AGENTS.md` is the agent's terse bootstrap rules. Add a one-line pointer so the agent reaches for the right tool without re-discovering it.

- [ ] **Step 1: Append a single line under whatever "Tools" or "Search" section already exists**

Local `agents-md-claude-context.py`:

```python
from pathlib import Path

target = "/home/node/.openclaw/workspace/AGENTS.md"
text = Path(target).read_text()

marker = "claude-context"
line = "- Codebase search: use `mcp__claude-context__search_code` for semantic queries over indexed code (default path: `/home/ubuntu/godwind-team-docker/openclaw`). Memory tools (`qdrant-find`, `qmd`) are for notes/decisions, not code.\n"

if marker not in text:
    Path(target).write_text(text.rstrip() + "\n\n" + line)
    print("ok: appended")
else:
    print("ok: already present")
```

```bash
docker cp agents-md-claude-context.py openclaw-openclaw-gateway-1:/tmp/agents-md-claude-context.py
docker exec -u node openclaw-openclaw-gateway-1 python3 /tmp/agents-md-claude-context.py
```

Expected: `ok: appended`.

- [ ] **Step 2: No git commit (workspace file is not in this repo)**

---

## Phase-end summary (after Phase 3)

After Phase 3 completes, the gateway will be running with:

- `claude-context-mcp` bind-mounted from the host (no image rebuild).
- `mcp.servers.claude-context` registered alongside `qmd` and `qdrant`.
- `gateway.tools.deny` blocking the two write tools.
- Three bootstrap files updated so the agent knows when and how to use the new lane.

Hand off to the post-implementation validation plan at `docs/superpowers/plans/claude-context-openclaw-validation.md` before declaring the rollout done.

## Validation complete (2026-05-20)

- Post-rollout validation and follow-up debug were run from the companion validation plan and debug plan v2.
- Compose fix committed: `adc920740066572d9f4552cd200656610ccab57a` — `infra(gateway): mirror host repo path into container`.
- Embedded-run deny fix committed separately after validation showed the live bundle-MCP policy gap.
- Outcome: live claude-context reads work against `/home/ubuntu/godwind-team-docker/openclaw` on the Discord embedded-run surface, and live embedded runs now block `claude-context__index_codebase` via `gateway.tools.deny`.
- Control UI assets were rebuilt locally (`pnpm ui:build`) and the gateway root now serves successfully again on this host.
- Final status: rollout is green on the target host after the deny-enforcement patch and final re-validation.
- See `docs/superpowers/plans/claude-context-MCP-openclaw/validation-report-2026-05-20.md` for the full validation record and post-debug appendix.
