# Autoresearch: Bootstrap System Prompt Cache Optimisation

## Objective

Maximise Anthropic KV cache hit rate for the OpenClaw bootstrap system prompt pipeline.

**Metric:** `system_prompt_stable_chars` — characters before the most-dynamic workspace file header (AGENTS.md if no MEMORY.md; MEMORY.md if present). Higher is better. Larger stable prefix = more content eligible for Anthropic KV caching.

**Secondary metric:** `system_prompt_total_chars` — total assembled system prompt length. Lower is better.

**Benchmark:** `./autoresearch.sh` → `bun scripts/autoresearch-benchmark.ts`

## Files in scope

- `src/agents/system-prompt.ts` — `buildAgentSystemPrompt`, prompt section ordering
- `src/agents/workspace.ts` — workspace file loading order (`loadWorkspaceBootstrapFiles`)
- `src/agents/bootstrap-cache.ts` — session-keyed in-memory cache
- `src/agents/bootstrap-files.ts` — file loading + filter pipeline
- `src/agents/pi-embedded-helpers/bootstrap.ts` — `buildBootstrapContextFiles`, truncation logic
- `scripts/autoresearch-benchmark.ts` — benchmark runner (bun TypeScript, no build step)
- `autoresearch.sh` — benchmark entry point

## Current best (CONVERGED)

`system_prompt_stable_chars=28213` / `total=29802` → **94.7% stable**
`boundary=agents-md-header` (AGENTS.md injected last among standard files)

**Theoretical maximum**: ~29,777 (if model= line removed — would break agent self-awareness).
**Practical maximum**: 28,213 ✓

## Key wins (this session)

| #   | Change                                                   | stable_chars | gain        | file             |
| --- | -------------------------------------------------------- | ------------ | ----------- | ---------------- |
| 1   | Fixed benchmark: `# Project Context` as dynamic boundary | 9,680        | —           | benchmark        |
| 2   | Moved Project Context after Heartbeats/Runtime           | 10,678       | +998        | system-prompt.ts |
| 3   | Added stable file manifest to Project Context preamble   | 10,987       | +86         | system-prompt.ts |
| 4   | Reordered workspace files: AGENTS.md last                | **28,213**   | **+17,226** | workspace.ts     |

## Prompt structure (current — optimised for KV caching)

```
[Boilerplate: Tooling, Safety, Skills, Memory, etc.]   ← stable (~10,987 ch)
## Silent Replies                                        ← stable (moved before Project Context)
## Heartbeats                                            ← stable (moved before Project Context)
## Time Zone                                             ← stable
## Runtime                                               ← stable (model= moved to separate line)
Reasoning: off (...)                                     ← stable

# Project Context
Files: SOUL.md, IDENTITY.md, ...                        ← stable file manifest
If SOUL.md is present, embody its persona...

## /workspace/SOUL.md     ← stable (rarely edited, ~8804 ch)
[SOUL.md content]
## /workspace/IDENTITY.md ← stable (rarely edited, ~1186 ch)
## /workspace/USER.md     ← stable (rarely edited, ~3782 ch)
## /workspace/TOOLS.md    ← stable (occasionally, ~2915 ch)
## /workspace/HEARTBEAT.md ← stable (~168 ch)
## /workspace/BOOTSTRAP.md ← stable/missing (~71 ch)

── AGENTS.MD BOUNDARY (28,213 chars stable) ────────────────────────────
## /workspace/AGENTS.md   ← dynamic (session protocol, frequently edited)
[AGENTS.md content ~1516 ch]

model=<model-name>         ← dynamic (per-session)
```

For workspaces with MEMORY.md (daily notes), MEMORY.md is loaded AFTER AGENTS.md via
`resolveMemoryBootstrapEntries`. The benchmark then uses MEMORY.md as boundary, and
AGENTS.md content (~1,516 chars) also enters the stable prefix. Real-world benefit
for users with active memory files.

## Dead ends

- Compressing boilerplate: reduces stable_chars and total_chars equally → primary regression
- Removing missing file placeholders (BOOTSTRAP.md): stable_chars falls by ~120 → primary regression
- Using relative paths in file headers: same stable_chars, lower total_chars → primary "equal" → discard
- Moving model= line before workspace files: inflates stable_chars with dynamic content (wrong)
- Removing model= line entirely: stable_chars unchanged (it's after the boundary); breaks agent self-awareness

## Remaining ideas (in autoresearch.ideas.md)

- Cross-session mtime-gated bootstrap cache (performance, not content)
- Skills hash-gated regeneration (performance)
- Separate AGENTS.md into base+overlay (user-facing design change)
- Move extraSystemPrompt/reactionGuidance after workspace files (real-world improvement, no benchmark impact)
