# Token Observability Guide

> Measure what you burn. Three metrics to diagnose context bloat, compaction waste, and memory overhead.

## Core Metrics

### 1. Context Utilization Ratio (CUR)

```
context_utilization_ratio = used_tokens / model_context_window
```

- **Healthy:** 0.3–0.7 — enough room for responses without wasting capacity
- **Warning:** >0.85 — compaction imminent, response quality degrades
- **Wasteful:** <0.15 — model downgrade candidate (cheaper model, smaller window)

### 2. Pruning Efficiency (PE)

```
pruning_efficiency = (pre_prune_tokens - post_prune_tokens) / pre_prune_tokens
```

- **Healthy:** 0.3–0.6 — meaningful reduction, retains important context
- **Too aggressive:** >0.8 — likely losing critical context, check compaction summaries
- **Ineffective:** <0.1 — pruning fires but removes almost nothing; tune thresholds

### 3. Memory Injection Ratio (MIR)

```
memory_injection_ratio = memory_tokens / total_prompt_tokens
```

- **Healthy:** 0.05–0.15 — memory enriches without dominating
- **Bloated:** >0.25 — MEMORY.md/AGENTS.md/context files need trimming
- **Starved:** <0.02 — agent lacks continuity; check file loading

## Extracting Data from OpenClaw Logs

OpenClaw emits lifecycle events you can grep for:

```bash
# 1. Compaction events (PE data source)
grep 'auto_compaction_start\|auto_compaction_end' ~/.openclaw/logs/*.log

# 2. Token usage per request (CUR data source)
# Set LOG_LEVEL=debug for token counts in model responses
LOG_LEVEL=debug openclaw gateway restart
grep -o '"usage":{[^}]*}' ~/.openclaw/logs/*.log | tail -20

# 3. System prompt size (MIR approximation)
# Count tokens in context files loaded per session
wc -c AGENTS.md SOUL.md USER.md MEMORY.md TOOLS.md IDENTITY.md 2>/dev/null
# Rule of thumb: 1 token ≈ 4 chars English, ≈ 2 chars Chinese
```

**Tip:** Pipe compaction logs through `jq` to extract pre/post token counts when structured logging is enabled.

## Common Token Waste Patterns

| Pattern | Symptom | Diagnosis |
|---------|---------|-----------|
| **Bloated AGENTS.md** | MIR >0.25, slow first response | `wc -c AGENTS.md` — trim to <4KB |
| **Skill over-injection** | CUR >0.8 before user speaks | Count loaded skills; disable unused ones |
| **Compaction death spiral** | PE <0.1 + repeated compactions | Context grows faster than pruning; reduce `maxTurns` |
| **Zombie tool outputs** | CUR spikes mid-session | Large tool results not compacted; enable `contextPruning.mode: "cache-ttl"` |
| **Memory file sprawl** | MIR >0.3 | Too many context files; consolidate or use `contextFiles` allowlist |

**Quick diagnostic script:**
```bash
# Estimate current context file token load
find . -name "*.md" -path "*/workspace/*" -exec wc -c {} + | sort -rn | head -10
# Files >8KB are prime trim candidates
```

## Configuration Recommendations

```jsonc
// openclaw.json — token-aware defaults
{
  "agents": {
    "defaults": {
      "compaction": {
        "enabled": true,        // auto-compact on overflow
        "strategy": "summary"   // preserve key decisions
      },
      "contextPruning": {
        "mode": "cache-ttl",    // prune stale tool outputs
        "maxAgeSec": 300        // 5 min TTL for cached results
      },
      "contextTokens": 120000, // leave 8K headroom on 128K models
      "maxTurns": 40           // prevent unbounded session growth
    }
  }
}
```

**Key tuning levers:**
- `contextTokens`: Set to `model_window - max_output - 8192` (safety margin)
- `compaction.strategy`: `"summary"` for long sessions, default for short tasks
- `contextPruning.mode`: `"cache-ttl"` eliminates zombie tool outputs — single biggest win
- Trim `AGENTS.md` + `SOUL.md` combined to <6KB for subagents (use `minimalPrompt`)

---

## Research Context

- **Source:** OpenClaw `pi.md` architecture doc — lifecycle events (`auto_compaction_start/end`), compaction-safeguard extension (adaptive token budgeting), context-pruning extension (`cache-ttl` mode)
- **Architecture refs:** `src/agents/pi-extensions/compact.ts`, `context-pruning.ts`, `compaction-safeguard.ts`, `context-window-guard.ts`
- **Gap identified:** OpenClaw currently emits compaction events but does not expose structured token metrics (usage.prompt_tokens, usage.completion_tokens) at the session level. A future PR could add a `/metrics` endpoint or structured log line per turn with all three metrics pre-calculated.
- **Validation:** Metric definitions derived from standard LLM observability practices (context window management, prompt engineering efficiency). Thresholds calibrated against 128K-context models (Claude Opus/Sonnet).
