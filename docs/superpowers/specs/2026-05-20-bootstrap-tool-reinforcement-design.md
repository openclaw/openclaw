# Bootstrap Tool Reinforcement — Design Spec

Date: 2026-05-20
Status: approved (design), pending implementation plan
Scope: OpenClaw agent bootstrap configuration on the running deployment. Not product code.

## Context

The OpenClaw agent has three retrieval/search MCP tools, but it does not reliably reach for them by default, and the bootstrap docs that describe them are wrong or incomplete:

- **QMD MCP** — local lexical/BM25 search over the workspace memory corpus (`MEMORY.md`, `memory/`, `rules-vault/`, `projects/`). Primary memory retrieval. Tools: `qmd__query`, `qmd__get`, `qmd__multi_get`, `qmd__status`.
- **Qdrant MCP** — local semantic/vector search over the same corpus (`agent-memory` collection). Tools: `qdrant__qdrant-find`, `qdrant__qdrant-store`.
- **claude-context MCP** — semantic codebase search over Milvus (Ollama `nomic-embed-text` embeddings), read-only for the agent. Tools: `claude-context__search_code`, `claude-context__get_indexing_status`. Canonical indexed path: `/home/ubuntu/godwind-team-docker/openclaw`.

The goal: make correct use of these three tools an automatic, default behavior every session — close the documentation gaps **and** add durable reinforcement so the agent does not have to remember.

## Findings that shaped the design

1. **Bootstrap files are auto-injected.** OpenClaw renders the *content* of `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, and `MEMORY.md` (MEMORY.md main-session-scoped) into the system context at the `agent:bootstrap` event (`src/agents/bootstrap-files.ts`, `src/agents/bootstrap-budget.ts`). Presence in context is therefore already guaranteed for the main session — the gap is *content correctness*, not presence.
2. **The `mcp__claude-context__*` prefix is wrong and pervasive.** The agent's real tool name is `claude-context__search_code` (server key `claude-context` + separator `__`, per `src/agents/pi-bundle-mcp-names.ts`; confirmed live by the working denylist entry `claude-context__index_codebase`). The wrong `mcp__`-prefixed name appears in `TOOLS.md`, `AGENTS.md`, and `MEMORY-ARCHITECTURE.md`. `MEMORY-ARCHITECTURE.md` already documents `qdrant__qdrant-find/store` correctly, so the docs are internally inconsistent.
3. **The retrieval policy is QMD-only.** `MEMORY.md`'s always-loaded "Retrieval policy" names only `qmd__*`. Qdrant and claude-context are absent or only mentioned in passing.
4. **A native always-load hook exists but is unused.** `bootstrap-extra-files` (`src/hooks/bundled/bootstrap-extra-files/`) injects additional workspace files into the bootstrap context every session via config patterns. Config path: `hooks.internal.entries.bootstrap-extra-files`. The live `hooks` config is currently empty.
5. **The hook only accepts recognized bootstrap basenames** (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `MEMORY.md`). A file literally named `RETRIEVAL-POLICY.md` would be rejected. Workaround: a recognized basename inside a subdirectory (e.g. `retrieval/AGENTS.md`).
6. **Bootstrap content is under a strict lean/no-truncation budget** (`bootstrap-budget.ts`). Reinforcement content must be compact.

## Decisions (from brainstorming)

- **Mechanism:** strengthen the already-auto-injected files **and** add the `bootstrap-extra-files` hook (belt-and-suspenders).
- **Hook approach:** inject a subdir recognized-basename file `retrieval/AGENTS.md` as the canonical imperative policy (the only way to get a dedicated hook-injected policy, and an AGENTS-class file may reach worker/sub sessions too).
- **Strictness:** scoped triggers — mandatory retrieval for memory/code questions, skip for chitchat/in-context-answerable.

## Design

The new hook-injected file is the single canonical source of truth for the imperative policy. Every other touched file either points to it or mirrors it compactly, so maintenance has one home.

### Component 1 — New canonical policy file: `retrieval/AGENTS.md`

Workspace path (in-container): `/home/node/.openclaw/workspace/retrieval/AGENTS.md`. Compact, budget-aware, scoped-trigger policy. Content:

```markdown
# Retrieval & Search Policy

Route by question type before answering. Use the tool — don't answer from memory alone.

## Memory questions (notes, decisions, history, config, "what did we say/do about X")
- qmd__query           — lexical/BM25, PRIMARY, try first
- qdrant__qdrant-find  — semantic fallback when lexical is thin or wording is fuzzy
- qdrant__qdrant-store — persist a durable semantic note when asked to remember
- qmd__get / qmd__multi_get — full docs by path/id;  qmd__status — only if retrieval looks broken

## Code questions ("where is X implemented", "find functions that do Y", repo behavior)
- claude-context__search_code         — semantic codebase search (read-only)
- claude-context__get_indexing_status — confirm a path is indexed (default: /home/ubuntu/godwind-team-docker/openclaw)

## Scope (scoped triggers)
- MANDATORY for: prior decisions/notes/history/config/continuation questions, and any code/repo question.
- SKIP for: greetings, chitchat, anything fully answerable from the current conversation.
- If retrieval is unavailable, say so explicitly — never bluff from stale prompt memory.

Tool names are exact: there is NO `mcp__` prefix on this install. Full reference: MEMORY-ARCHITECTURE.md.
```

### Component 2 — Hook wiring in `~/.openclaw/openclaw.json`

Add (merging into existing config, not clobbering the current `hooks` value — read it first):

```json
"hooks": {
  "internal": {
    "entries": {
      "bootstrap-extra-files": {
        "enabled": true,
        "paths": ["retrieval/AGENTS.md"]
      }
    }
  }
}
```

**Do NOT set `hooks.internal.enabled = true`.** Per `src/hooks/configured.ts` + `src/hooks/loader.ts:105`, `internal.enabled === true` makes `resolveConfiguredInternalHookNames` return `null`, disabling the allowlist filter and loading **every** bundled default-on hook. Leaving `enabled` unset while providing an enabled `entries` item keeps `hasConfiguredInternalHooks` true and filters the loader to **only** `bootstrap-extra-files`. Entry-allowlist only — no master flag.

- Back up `openclaw.json` with a timestamped copy before editing (prior-session convention).
- Restart the gateway to load the hook (confirm whether hooks hot-reload; if not, `docker restart openclaw-openclaw-gateway-1`).

### Component 3 — Fix the `mcp__` prefix bug (correctness, non-negotiable)

In `TOOLS.md`, `AGENTS.md`, and `MEMORY-ARCHITECTURE.md`, replace:
- `mcp__claude-context__search_code` → `claude-context__search_code`
- `mcp__claude-context__get_indexing_status` → `claude-context__get_indexing_status`

### Component 4 — `MEMORY.md` + `AGENTS.md` (compact, point to canonical)

- **MEMORY.md** "Retrieval policy": replace the QMD-only block with a 3-line summary — `qmd__query` (lexical, first) → `qdrant__qdrant-find` (semantic fallback) → `claude-context__search_code` (code) — plus "Canonical: `retrieval/AGENTS.md` (auto-injected)." Keep the existing "don't bluff if retrieval unavailable" line.
- **AGENTS.md**: fix the one wrong-prefix codebase line (Component 3). Optionally add a single pointer line to `retrieval/AGENTS.md`. Keep the file lean; do not expand.

### Component 5 — `MEMORY-ARCHITECTURE.md` (deep reference)

- Fix the claude-context prefix in the "Codebase search lane" section (Component 3).
- Ensure all three tools appear consistently in the "Live retrieval contract" with the scoped-trigger summary. `qdrant__*` is already correct; this is mostly aligning claude-context and adding the scoped-trigger note.
- Out of scope: the stale Qdrant version fact (`v1.12.4`) and any reconciler/rollout content — do not touch.

## Verification

Live test after implementation (gateway healthy post-restart):

1. **Hook loaded:** confirm `retrieval/AGENTS.md` is injected into the bootstrap context (gateway logs / bootstrap diagnostics show the extra file; no "skipped" diagnostic for it).
2. **Main-session behavior:** prompt the agent (e.g. via Discord) with a memory question ("what did we decide about X") → it calls `qmd__query` (then `qdrant__qdrant-find` if thin); and a code question ("where is Y implemented") → it calls `claude-context__search_code`. Tool calls use the correct names (no `mcp__`).
3. **Worker reach (the hook rationale):** verify whether the hook-injected policy reaches worker/sub sessions. If it does not (worker uses a different workspace dir), the policy is still guaranteed for the main agent via MEMORY.md/AGENTS.md/the hook — document the actual reach, don't claim more.
4. **No regression:** existing QMD/Qdrant retrieval still works; gateway boots clean.

## Out of scope

- Blacksmith/CI config, the claude-context rollout, the memory-corpus reconciler, Qdrant version facts — all settled in prior work.
- Any change to which session types OpenClaw auto-loads bootstrap files for (we work within the existing mechanism).

## Files touched

- Create: `/home/node/.openclaw/workspace/retrieval/AGENTS.md` (workspace, via container)
- Modify: `/home/node/.openclaw/openclaw.json` (hooks block, via container)
- Modify: `/home/node/.openclaw/workspace/{TOOLS.md, AGENTS.md, MEMORY.md, MEMORY-ARCHITECTURE.md}` (workspace, via container)
- This spec: `docs/superpowers/specs/2026-05-20-bootstrap-tool-reinforcement-design.md` (host repo)

## Constraints

- All workspace/config writes via `docker exec -u node openclaw-openclaw-gateway-1` — never host sudo.
- No secret dumps; verify config shape (keys only), never values.
- No Docker image rebuilds.
- Bootstrap edits must stay compact (budget).
