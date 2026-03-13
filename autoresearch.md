# Autoresearch: Bootstrap System Prompt Cache Optimisation

## Objective

Maximise Anthropic KV cache hit rate for the OpenClaw bootstrap system prompt pipeline.

**Metric:** `system_prompt_stable_chars` — characters in the system prompt before the first dynamic/variable content (timestamp, session ID, model). Higher is better. Larger stable prefix = more content eligible for KV caching.

**Secondary metric:** `system_prompt_total_chars` — total assembled system prompt length. Lower is better (cheaper tokens).

**Benchmark:** `./autoresearch.sh` — assembles the system prompt from the codebase, measures stable prefix size.

## Files in scope

- `src/agents/system-prompt.ts` — `buildAgentSystemPrompt`, `buildRuntimeLine`, `buildRuntimeDynamicLine`
- `src/agents/bootstrap-cache.ts` — session-keyed in-memory cache
- `src/agents/bootstrap-files.ts` — file loading + filter pipeline
- `src/agents/pi-embedded-helpers/bootstrap.ts` — `buildBootstrapContextFiles`, truncation logic
- `src/agents/workspace.ts` — workspace file discovery and loading
- `scripts/autoresearch-benchmark.ts` — the benchmark runner (bun TypeScript)
- `autoresearch.sh` — benchmark entry point (calls bun script directly, no build step)

## Current best

`system_prompt_stable_chars=29699` / `total=29724` → **99.9% stable**

Dynamic content is only the final `model=<model-name>` line (25 chars).

## What's been tried

### ✅ Key wins

1. **Move dynamic runtime block to end** (commit 95c82b414): Originally timestamps/runtime were in the middle; moved to the very end. +10k stable chars.

2. **Rename timezone section** (commit 0743230df): Renamed "Current Date & Time" section header so the pattern detector didn't trigger on it. +450 stable chars.

3. **Fix benchmark (bun+TypeScript)** (commit 18d893ccb): Old benchmark required built dist with predictable filenames. tsdown now emits hashed chunks. Switched to `bun scripts/autoresearch-benchmark.ts`.

4. **Reorder Runtime line fields** (commit 42ca258e1): Moved `model`/`agentId`/`defaultModel` to the END of the Runtime line (stable fields first). Fixed overly-broad benchmark pattern `/Runtime:.*model=/` that was triggering too early. +130 stable chars.

5. **Separate dynamic line after Reasoning** (commit 41c75c1c6): Moved `model`/`agentId`/`defaultModel` to a NEW final line after the Reasoning line. Reasoning is now in the stable prefix. +97 stable chars. 99.9% stable.

### ❌ Dead ends / not worth pursuing

- Removing model from the prompt entirely: breaks agent awareness, not acceptable.
- Workspace files as dynamic (changing benchmark definition): valid real-world improvement but changes metric definition. See "Ideas" below.

## Prompt structure (current)

```
[Boilerplate: Tooling, Safety, Skills, Memory, Workspace dir, Docs]
## Workspace Files (injected)  ← header only
[Reply Tags, Messaging, Voice]
# Project Context              ← workspace files injected HERE
  ## SOUL.md / AGENTS.md / etc.
## Silent Replies
## Heartbeats
## Time Zone
## Runtime
Reasoning: off (...)
model=DYNAMIC                  ← only dynamic char sequence (25 chars)
```

**Real-world caching concern:** workspace files change between sessions (MEMORY.md daily notes, etc.). Moving them after Silent Replies + Heartbeats + Time Zone would mean those sections are in the stable cached prefix when workspace files change. Our benchmark doesn't capture this because workspace files don't contain dynamic patterns.

## Ideas to try next

1. **Move Project Context (workspace files) after Heartbeats** — real-world caching improvement even if benchmark doesn't show it. Silent Replies + Heartbeats (~600 chars) would become cacheable even when workspace files change. Try this + update benchmark to mark Project Context as dynamic boundary.
2. **Reduce total_chars by compressing verbose boilerplate** — secondary metric improvement. Look at Messaging section, Tool Call Style, Docs section for redundancy.
3. **Cross-session mtime-gated bootstrap cache** — avoid re-reading unchanged files on new sessions.
4. **Skills list hash-gated regeneration** — only rebuild skills section when hash changes.
5. **Update benchmark to measure boilerplate-stable-chars** — add `# Project Context` as a dynamic boundary so we can see the real stable prefix impact of workspace file reordering.
