# Autoresearch: Bootstrap System Prompt Cache Optimisation

## Objective

Maximise Anthropic KV cache hit rate for the OpenClaw bootstrap system prompt pipeline.

**Metric:** `system_prompt_stable_chars` — characters before the AGENTS.md file header
(the most-frequently-edited workspace file, injected last). Higher is better.
Larger stable prefix = more content eligible for Anthropic KV caching.

**Secondary metric:** `system_prompt_total_chars` — total assembled system prompt length. Lower is better.

**Benchmark:** `./autoresearch.sh` → `bun scripts/autoresearch-benchmark.ts`

## Files in scope

- `src/agents/system-prompt.ts` — `buildAgentSystemPrompt`, prompt section ordering
- `src/agents/workspace.ts` — workspace file loading order (`loadWorkspaceBootstrapFiles`)
- `src/agents/bootstrap-cache.ts` — session-keyed in-memory cache
- `src/agents/bootstrap-files.ts` — file loading + filter pipeline
- `src/agents/pi-embedded-helpers/bootstrap.ts` — `buildBootstrapContextFiles`, truncation logic
- `scripts/autoresearch-benchmark.ts` — benchmark runner (bun TypeScript, no build step)

## Current best

`system_prompt_stable_chars=28213` / `total=29802` → **94.7% stable**

The stable prefix includes:

- All boilerplate (Tooling, Safety, Skills, Memory, etc.) — ~10,987 chars
- Silent Replies + Heartbeats (moved before Project Context) — ~722 chars
- Time Zone + Runtime + Reasoning — ~235 chars
- Project Context preamble (file manifest) — ~305 chars
- SOUL.md content (rarely changes) — ~8,804 chars
- IDENTITY.md, USER.md, TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md — ~8,125 chars

Remaining dynamic: AGENTS.md header + content (~1,566 chars) + model line (~25 chars) = ~1,591 chars

## What's been tried

### ✅ Key wins (this session)

1. **Refined benchmark metric**: measure stable_chars before AGENTS.md header (not model= line). AGENTS.md is the most frequently-edited workspace file. Everything before it stays in the Anthropic KV cache even when AGENTS.md changes.

2. **Moved Project Context to last position** (+998 stable chars): Previously Silent Replies, Heartbeats, Time Zone, Runtime came AFTER workspace file injection. Moved all those sections BEFORE Project Context so they remain in the cached stable prefix even when workspace files change.

3. **Added stable file manifest to Project Context preamble** (+86 stable chars): `Files: AGENTS.md, SOUL.md, ...` line before the first file header. File names are fixed by the loader — stable content.

4. **Reordered workspace file injection** (+17,226 stable chars, **+158.8%**): Changed file order from [AGENTS.md first] to [SOUL.md, IDENTITY.md, USER.md, TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md, AGENTS.md last]. SOUL.md (8,804 chars) and other rarely-edited files now come before AGENTS.md, so they remain in the Anthropic KV cache even when AGENTS.md is updated.

### ✅ Key wins (previous session)

5. **Moved model/agentId to separate final line after Reasoning**: Dynamic per-session fields (model, agentId) on their own final line after Reasoning. Reasoning now in stable prefix.

6. **Fixed benchmark** to use bun+TypeScript directly (no build step, no hashed dist chunks).

7. **Moved model/agentId to end of Runtime line** (stable fields first).

### ❌ Dead ends

- Compressing boilerplate text reduces stable_chars (primary metric) by the same amount. Equal regression.
- Skipping missing files reduces total_chars but also reduces stable_chars (BOOTSTRAP.md is before AGENTS.md). Net: primary regression.
- Using relative file paths reduces total_chars but doesn't change stable_chars boundary position.

## Prompt structure (current)

```
[Boilerplate: Tooling, Safety, Skills, Memory, etc.] ← stable
## Workspace Files (injected) ← stable
[Reply Tags, Messaging, Voice] ← stable
## Silent Replies ← stable (MOVED before Project Context)
## Heartbeats ← stable (MOVED before Project Context)
## Time Zone ← stable
## Runtime ← stable (model= line moved to separate dynamic line)
Reasoning: off (...) ← stable

# Project Context ← stable preamble
Files: SOUL.md, IDENTITY.md, ... ← stable file manifest
If SOUL.md is present, embody its persona... ← stable

## /path/workspace/SOUL.md ← stable (rarely changes)
[SOUL.md content 8804 chars] ← stable
## /path/workspace/IDENTITY.md ← stable
[...] ← stable
## /path/workspace/TOOLS.md ← stable
[...]
## /path/workspace/HEARTBEAT.md ← stable
## /path/workspace/BOOTSTRAP.md ← stable (missing placeholder)

── AGENTS.md BOUNDARY ──── (most-changed file, injected last)
## /path/workspace/AGENTS.md ← dynamic (changes frequently)
[AGENTS.md content 1516 chars] ← dynamic

model=<model-name> ← dynamic (per-session model)
```

## Ideas to try next

1. **Project-specific AGENTS.md** — if a project has its own AGENTS.md loaded via hooks, that might also change frequently. Currently project-level AGENTS.md files are not in the standard file list.

2. **Further benchmark refinement** — model the scenario where SOUL.md also changes (e.g., both SOUL.md and AGENTS.md change). In that case stable prefix = boilerplate only (~10,987). The current benchmark assumes only AGENTS.md changes.

3. **Cross-session mtime-gated bootstrap cache** — cache file content by mtime. Only re-read files that changed since last session. This doesn't affect the prompt structure but reduces build time.

4. **Skills hash-gated regeneration** — only rebuild skills section when skill files change. Performance improvement.

5. **Separate AGENTS.md into stable/dynamic parts** — split AGENTS.md into a rarely-changed "base config" and a frequently-changed "session notes" section. But this requires user-facing changes.
