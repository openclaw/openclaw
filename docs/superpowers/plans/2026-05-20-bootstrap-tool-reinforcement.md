# Bootstrap Tool Reinforcement Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax. This is OpenClaw deployment config/docs work — there is no compilable code and no unit-test suite; each task ends in a concrete structural or behavioral verification instead of a TDD cycle.

**Goal:** Make the OpenClaw agent automatically and correctly use its three retrieval/search MCP tools (QMD, Qdrant, claude-context) every session, by fixing wrong tool names and adding a scoped, always-injected retrieval policy.

**Architecture:** A new hook-injected `retrieval/AGENTS.md` is the canonical imperative policy (scoped triggers). The already-auto-injected `MEMORY.md`/`AGENTS.md` carry compact pointers, `MEMORY-ARCHITECTURE.md` stays the deep reference, and the `bootstrap-extra-files` hook guarantees the policy file is loaded every session. All workspace/config edits go through the gateway container.

**Tech Stack:** OpenClaw bootstrap (`src/agents/bootstrap-files.ts`), the `bootstrap-extra-files` hook (`hooks.internal.entries`), JSON config, workspace markdown, Docker.

**Spec:** `docs/superpowers/specs/2026-05-20-bootstrap-tool-reinforcement-design.md`

**Standing constraints:**
- All workspace + `openclaw.json` writes via `docker exec -u node openclaw-openclaw-gateway-1` (structured edits = Python script `docker cp`'d to `/tmp/` then run). Never host sudo.
- Never print `.env`/credential/auth values; verify config shape (keys only).
- No Docker image rebuilds.
- Bootstrap edits stay compact (budget).
- Correct tool names on this install have **no `mcp__` prefix**: `qmd__query`/`qmd__get`/`qmd__multi_get`/`qmd__status`, `qdrant__qdrant-find`/`qdrant__qdrant-store`, `claude-context__search_code`/`claude-context__get_indexing_status`.

**Note on commits:** the workspace and `openclaw.json` are NOT in this git repo (the workspace is a separate repo pushed by `backup.sh`). Do not `git commit` workspace/config edits here. Only this repo's spec/plan are committed. Optionally run `backup.sh` at the end to snapshot + push the workspace.

---

## Phase 1 — Doc correctness (fix the `mcp__` prefix bug)

**Designated sub-agent:** `general-purpose`
**Scope:** correct every wrong `mcp__claude-context__*` name and add brief Qdrant notes, with no behavior/hook changes yet. Phase ends when no workspace doc contains the `mcp__` prefix.

### Task 1.1 — Fix TOOLS.md

**Files:**
- Modify: `/home/node/.openclaw/workspace/TOOLS.md` (via container)

- [ ] **Step 1: Write the edit script locally** as `t11.py`:

```python
from pathlib import Path
p = Path("/home/node/.openclaw/workspace/TOOLS.md")
t = p.read_text()
t = t.replace("mcp__claude-context__search_code", "claude-context__search_code")
t = t.replace("mcp__claude-context__get_indexing_status", "claude-context__get_indexing_status")
# Correct the decision-table memory cell to exact tool names
t = t.replace("`qdrant-find` (semantic) or `qmd` (lexical)",
              "`qdrant__qdrant-find` (semantic) or `qmd__query` (lexical)")
# Add a brief Qdrant companion note right after the QMD status bullet, once
anchor = "  - `qmd__status` for health only\n"
qnote = anchor + ("- Qdrant MCP is the semantic companion to QMD for memory: "
                  "`qdrant__qdrant-find` (search), `qdrant__qdrant-store` (persist). "
                  "Use it as a fallback when QMD lexical recall is thin. "
                  "Full tool reference: MEMORY-ARCHITECTURE.md.\n")
if "qdrant__qdrant-find` (search), `qdrant__qdrant-store" not in t:
    t = t.replace(anchor, qnote, 1)
p.write_text(t)
print("ok: TOOLS.md updated")
```

- [ ] **Step 2: Apply it in the container**

```bash
docker cp t11.py openclaw-openclaw-gateway-1:/tmp/t11.py
docker exec -u node openclaw-openclaw-gateway-1 python3 /tmp/t11.py
```
Expected stdout: `ok: TOOLS.md updated`

- [ ] **Step 3: Verify — no `mcp__` left, Qdrant note present**

```bash
docker exec -u node openclaw-openclaw-gateway-1 sh -c 'grep -c "mcp__claude-context" /home/node/.openclaw/workspace/TOOLS.md; grep -c "qdrant__qdrant-find" /home/node/.openclaw/workspace/TOOLS.md'
```
Expected: first line `0`, second line `>=1`.

### Task 1.2 — Fix AGENTS.md (root) prefix

**Files:**
- Modify: `/home/node/.openclaw/workspace/AGENTS.md` (via container)

- [ ] **Step 1: Write `t12.py`:**

```python
from pathlib import Path
p = Path("/home/node/.openclaw/workspace/AGENTS.md")
t = p.read_text()
t = t.replace("mcp__claude-context__search_code", "claude-context__search_code")
t = t.replace("mcp__claude-context__get_indexing_status", "claude-context__get_indexing_status")
# Tighten the existing codebase line's memory-tool names to exact form
t = t.replace("Memory tools (`qdrant-find`, `qmd`) are for notes/decisions, not code.",
              "Memory tools (`qmd__query`, `qdrant__qdrant-find`) are for notes/decisions, not code.")
p.write_text(t)
print("ok: AGENTS.md updated")
```

- [ ] **Step 2: Apply**

```bash
docker cp t12.py openclaw-openclaw-gateway-1:/tmp/t12.py
docker exec -u node openclaw-openclaw-gateway-1 python3 /tmp/t12.py
```
Expected: `ok: AGENTS.md updated`

- [ ] **Step 3: Verify**

```bash
docker exec -u node openclaw-openclaw-gateway-1 grep -c "mcp__claude-context" /home/node/.openclaw/workspace/AGENTS.md
```
Expected: `0`

### Task 1.3 — Fix + align MEMORY-ARCHITECTURE.md

**Files:**
- Modify: `/home/node/.openclaw/workspace/MEMORY-ARCHITECTURE.md` (via container)

- [ ] **Step 1: Write `t13.py`:**

```python
from pathlib import Path
p = Path("/home/node/.openclaw/workspace/MEMORY-ARCHITECTURE.md")
t = p.read_text()
t = t.replace("mcp__claude-context__search_code", "claude-context__search_code")
t = t.replace("mcp__claude-context__get_indexing_status", "claude-context__get_indexing_status")
# Add the companion read tool + scoped-trigger note to the codebase lane, once
anchor = "- **Tool:** `claude-context__search_code` (read-only — write tools are blocked at the gateway).\n"
addition = anchor + ("- **Companion:** `claude-context__get_indexing_status` — confirm a path is indexed before searching.\n"
                     "- **Trigger:** use for code/repo questions (\"where is X implemented\", \"find functions that do Y\"); "
                     "memory questions go to `qmd__query` then `qdrant__qdrant-find`.\n")
if "Companion:** `claude-context__get_indexing_status`" not in t:
    t = t.replace(anchor, addition, 1)
p.write_text(t)
print("ok: MEMORY-ARCHITECTURE.md updated")
```

- [ ] **Step 2: Apply**

```bash
docker cp t13.py openclaw-openclaw-gateway-1:/tmp/t13.py
docker exec -u node openclaw-openclaw-gateway-1 python3 /tmp/t13.py
```
Expected: `ok: MEMORY-ARCHITECTURE.md updated`

- [ ] **Step 3: Verify whole workspace is clean of the bad prefix**

```bash
docker exec -u node openclaw-openclaw-gateway-1 sh -c 'cd /home/node/.openclaw/workspace && grep -rl "mcp__claude-context" . 2>/dev/null || echo "CLEAN: no mcp__ prefix anywhere"'
```
Expected: `CLEAN: no mcp__ prefix anywhere`

---

## Phase 2 — Canonical policy file + MEMORY.md pointer

**Designated sub-agent:** `general-purpose`
**Scope:** create the canonical scoped policy and make MEMORY.md point to it. Phase ends when `retrieval/AGENTS.md` exists in the workspace and MEMORY.md's retrieval section covers all three tools.

### Task 2.1 — Create the canonical policy file `retrieval/AGENTS.md`

**Files:**
- Create: `/home/node/.openclaw/workspace/retrieval/AGENTS.md` (via container)

- [ ] **Step 1: Write the file locally** as `retrieval-AGENTS.md`:

```markdown
# Retrieval & Search Policy

Route by question type before answering. Use the tool — don't answer from memory alone.

## Memory questions (notes, decisions, history, config, "what did we say/do about X")
- `qmd__query`           — lexical/BM25, PRIMARY, try first
- `qdrant__qdrant-find`  — semantic fallback when lexical is thin or wording is fuzzy
- `qdrant__qdrant-store` — persist a durable semantic note when asked to remember
- `qmd__get` / `qmd__multi_get` — full docs by path/id;  `qmd__status` — only if retrieval looks broken

## Code questions ("where is X implemented", "find functions that do Y", repo behavior)
- `claude-context__search_code`         — semantic codebase search (read-only)
- `claude-context__get_indexing_status` — confirm a path is indexed (default: /home/ubuntu/godwind-team-docker/openclaw)

## Scope (scoped triggers)
- MANDATORY for: prior decisions/notes/history/config/continuation questions, and any code/repo question.
- SKIP for: greetings, chitchat, anything fully answerable from the current conversation.
- If retrieval is unavailable, say so explicitly — never bluff from stale prompt memory.

Tool names are exact: there is NO `mcp__` prefix on this install. Full reference: MEMORY-ARCHITECTURE.md.
```

- [ ] **Step 2: Create the subdir, copy the file in, fix ownership**

```bash
docker exec -u node openclaw-openclaw-gateway-1 mkdir -p /home/node/.openclaw/workspace/retrieval
docker cp retrieval-AGENTS.md openclaw-openclaw-gateway-1:/home/node/.openclaw/workspace/retrieval/AGENTS.md
docker exec -u node openclaw-openclaw-gateway-1 chown node:node /home/node/.openclaw/workspace/retrieval/AGENTS.md
```

- [ ] **Step 3: Verify it exists and reads back**

```bash
docker exec -u node openclaw-openclaw-gateway-1 sh -c 'head -1 /home/node/.openclaw/workspace/retrieval/AGENTS.md; wc -l /home/node/.openclaw/workspace/retrieval/AGENTS.md'
```
Expected: first line `# Retrieval & Search Policy`, line count ~20.

### Task 2.2 — Update MEMORY.md retrieval policy

**Files:**
- Modify: `/home/node/.openclaw/workspace/MEMORY.md` (via container)

**Context:** MEMORY.md's current "Retrieval policy" section lists only `qmd__*`. Replace the primary-tools bullet list with a compact 3-tool summary + pointer, keeping the "query before answering" and "don't bluff" lines.

- [ ] **Step 1: Write `t22.py`** (anchored, idempotent replace of the QMD-only block):

```python
from pathlib import Path
p = Path("/home/node/.openclaw/workspace/MEMORY.md")
t = p.read_text()
old = """- Primary tools:
  - `qmd__query` for retrieval, starting with lexical search first.
  - `qmd__get` for a single document by path or doc id.
  - `qmd__multi_get` for grouped follow-up reads.
  - `qmd__status` only when retrieval itself looks broken.
- The legacy tools `memory_search` and `memory_get` are retired on this install."""
new = """- Route retrieval by question type (canonical policy: `retrieval/AGENTS.md`, auto-injected each session):
  - Memory/notes/decisions/history/config -> `qmd__query` (lexical, first), then `qdrant__qdrant-find` (semantic fallback); `qdrant__qdrant-store` to persist when asked to remember.
  - Code/repo questions -> `claude-context__search_code` (read-only); `claude-context__get_indexing_status` to confirm a path is indexed.
  - `qmd__get` / `qmd__multi_get` for full docs; `qmd__status` only if retrieval looks broken.
- The legacy tools `memory_search` and `memory_get` are retired on this install."""
if old not in t:
    raise SystemExit("ANCHOR NOT FOUND — re-read MEMORY.md and adjust the old-block before running")
t = t.replace(old, new, 1)
p.write_text(t)
print("ok: MEMORY.md retrieval policy updated")
```

- [ ] **Step 2: Apply**

```bash
docker cp t22.py openclaw-openclaw-gateway-1:/tmp/t22.py
docker exec -u node openclaw-openclaw-gateway-1 python3 /tmp/t22.py
```
Expected: `ok: MEMORY.md retrieval policy updated`. If it raises `ANCHOR NOT FOUND`, `cat` MEMORY.md, copy the exact current block into `old`, and retry.

- [ ] **Step 3: Verify all three tool families present in the section**

```bash
docker exec -u node openclaw-openclaw-gateway-1 sh -c 'cd /home/node/.openclaw/workspace && grep -c "qdrant__qdrant-find" MEMORY.md; grep -c "claude-context__search_code" MEMORY.md; grep -c "retrieval/AGENTS.md" MEMORY.md'
```
Expected: each line `>=1`.

---

## Phase 3 — Hook wiring, restart, verification

**Designated sub-agent:** `general-purpose`
**Scope:** enable the `bootstrap-extra-files` hook to inject `retrieval/AGENTS.md`, restart, and prove the agent actually uses the tools. Phase ends when the live agent reaches for the correct tools unprompted.

### Task 3.1 — Add the hook config to openclaw.json

**Files:**
- Modify: `/home/node/.openclaw/openclaw.json` (via container)

- [ ] **Step 1: Back up config (timestamped, prior-session convention)**

```bash
docker exec -u node openclaw-openclaw-gateway-1 cp /home/node/.openclaw/openclaw.json /home/node/.openclaw/openclaw.json.bak.pre-hook-$(date -u +%Y%m%dT%H%M%SZ)
```

- [ ] **Step 2: Inspect the current `hooks` value (so the merge doesn't clobber)**

```bash
docker exec -u node openclaw-openclaw-gateway-1 python3 -c "import json; d=json.load(open('/home/node/.openclaw/openclaw.json')); print('hooks type:', type(d.get('hooks')).__name__); print('hooks value:', d.get('hooks'))"
```
Expected: confirms `hooks` is absent or an empty object. If it is a non-empty object with existing `internal.entries`, preserve them in Step 3.

- [ ] **Step 3: Write `t31.py`** (merge, preserving any existing hooks):

```python
import json
from pathlib import Path
p = Path("/home/node/.openclaw/openclaw.json")
d = json.loads(p.read_text())
hooks = d.get("hooks")
if not isinstance(hooks, dict):
    hooks = {}
internal = hooks.get("internal")
if not isinstance(internal, dict):
    internal = {}
internal["enabled"] = True
entries = internal.get("entries")
if not isinstance(entries, dict):
    entries = {}
entries["bootstrap-extra-files"] = {"enabled": True, "paths": ["retrieval/AGENTS.md"]}
internal["entries"] = entries
hooks["internal"] = internal
d["hooks"] = hooks
p.write_text(json.dumps(d, indent=2) + "\n")
print("ok: bootstrap-extra-files hook configured ->", entries["bootstrap-extra-files"])
```

- [ ] **Step 4: Apply + verify shape**

```bash
docker cp t31.py openclaw-openclaw-gateway-1:/tmp/t31.py
docker exec -u node openclaw-openclaw-gateway-1 python3 /tmp/t31.py
docker exec -u node openclaw-openclaw-gateway-1 python3 -c "import json; d=json.load(open('/home/node/.openclaw/openclaw.json')); print(d['hooks']['internal']['entries']['bootstrap-extra-files'])"
```
Expected: `ok: ...` then `{'enabled': True, 'paths': ['retrieval/AGENTS.md']}`.

### Task 3.2 — Restart and structurally verify injection (watch for basename collision)

**Files:** none (verification)

**Context:** Hooks are not known to hot-reload, so restart. Critical risk: the injected file's basename is `AGENTS.md`, same as the root `AGENTS.md`. Confirm BOTH are present in the bootstrap context and the dedup logic did not drop one. If collision drops it, fall back (Step 4).

- [ ] **Step 1: Restart the gateway**

```bash
docker restart openclaw-openclaw-gateway-1
```

- [ ] **Step 2: Confirm clean boot + the hook fired**

```bash
docker logs --since 90s openclaw-openclaw-gateway-1 2>&1 | grep -iE "bootstrap-extra-files|extra bootstrap|hook" | head -20
docker logs --since 90s openclaw-openclaw-gateway-1 2>&1 | grep -iE "error|fail" | grep -iE "hook|bootstrap" | head -10
```
Expected: a line indicating the hook ran / loaded an extra file; no hook/bootstrap errors. (Absence of a positive log line is not proof — Step 3 is the real check.)

- [ ] **Step 3: Prove the policy content reaches the agent context.** In a live agent session (Discord), prompt:

> What does your retrieval policy say to use for code questions vs memory questions? Quote the exact tool names.

Expected: the agent quotes `claude-context__search_code` for code and `qmd__query` / `qdrant__qdrant-find` for memory — i.e. it can see the policy file's content, and BOTH root AGENTS.md behavior and the retrieval policy are present.

- [ ] **Step 4: If Step 3 shows the policy is missing (basename collision dropped it):** fall back to a non-colliding recognized basename. Re-run Task 2.1 writing the same content to `retrieval/TOOLS.md` instead, update the hook path to `["retrieval/TOOLS.md"]` (re-run Task 3.1 Step 3 with that path), restart, and re-verify. Record which basename worked.

### Task 3.3 — Live behavioral verification

**Files:** none (verification)

**Context:** Prove the reinforcement actually changes behavior, and measure the hook's reach.

- [ ] **Step 1: Main-session memory question.** In Discord, ask something answerable only from memory, e.g.:

> What did we decide about the Blacksmith CI workflows?

Expected: the agent calls `qmd__query` (and `qdrant__qdrant-find` if lexical is thin) with correct names, then answers from the hit — not from stale prompt memory.

- [ ] **Step 2: Main-session code question.** Ask:

> Where in the openclaw codebase are MCP tool names constructed?

Expected: the agent calls `claude-context__search_code` (path `/home/ubuntu/godwind-team-docker/openclaw`) and surfaces `src/agents/pi-bundle-mcp-names.ts`.

- [ ] **Step 3: Worker-reach check (the hook rationale).** Trigger a delegated/worker sub-session (e.g. ask the agent to delegate a small lookup to a worker) and confirm whether the worker also has the retrieval policy. Record the result honestly:
  - If yes: the hook reaches workers — rationale confirmed.
  - If no: document that reach is main-session only; the policy is still guaranteed for the main agent via the hook + MEMORY.md/AGENTS.md. No further change required unless the user wants worker coverage.

- [ ] **Step 4: Regression sanity.** Confirm the gateway is healthy and a normal non-retrieval reply still works (ask a trivial question; expect a normal answer with no spurious tool calls — validates the "SKIP for chitchat" scope).

---

## Optional closing step — snapshot the workspace

- [ ] Run the backup to snapshot config + push the workspace repo (captures the new `retrieval/AGENTS.md` and edited bootstrap files):

```bash
sudo bash /home/ubuntu/.openclaw/scripts/backup.sh
```
(Only if the user wants a snapshot now; the script also pushes the workspace repo to GitHub.)

---

## Self-review (against the spec)

- **Component 1 (canonical `retrieval/AGENTS.md`)** → Task 2.1. ✓
- **Component 2 (hook wiring)** → Task 3.1 + 3.2. ✓
- **Component 3 (`mcp__` prefix fix in TOOLS/AGENTS/MEMORY-ARCHITECTURE)** → Tasks 1.1, 1.2, 1.3. ✓
- **Component 4 (MEMORY.md + AGENTS.md compact pointers)** → Task 2.2 (MEMORY.md) + Task 1.2 (AGENTS.md line). ✓
- **Component 5 (MEMORY-ARCHITECTURE.md alignment)** → Task 1.3. ✓
- **Verification (hook loaded, main behavior, worker reach, no regression)** → Tasks 3.2 + 3.3. ✓
- **Basename-collision risk** (AGENTS.md injected alongside root AGENTS.md) → explicitly handled with a fallback in Task 3.2 Step 4.
- Tool names are consistent across all tasks (no `mcp__`; `qmd__query`, `qdrant__qdrant-find/store`, `claude-context__search_code/get_indexing_status`).
- No host-sudo workspace writes; all via container. No image rebuild. Compact edits.
