# ADR 0001 — Context Budget (Chars) for Token Cost Control

Status: Proposed

## Context

OpenClaw deployments often want lower token usage without degrading UX.
The main cost drivers are _context construction_:

- injected workspace files (bootstrap)
- memory search snippets injected into the prompt
- large tool outputs (especially `web_fetch`)

Today, OpenClaw offers per-feature limits (e.g. `agents.defaults.bootstrapMaxChars`, `memory.qmd.limits.maxInjectedChars`, `tools.web.fetch.maxChars`), but there is no single, agent-level, opt-in “budget policy” that can:

- be enabled/disabled with a flag
- override limits consistently across features
- remain upstream-friendly (small, optional, backwards compatible)

## Decision

Introduce an **opt-in** agent-level config block:

```jsonc
{
  "agents": {
    "defaults": {
      "contextBudget": {
        "enabled": false,
        "bootstrapMaxChars": 8000,
        "memoryMaxInjectedChars": 2500,
        "webFetchMaxChars": 8000,
      },
    },
  },
}
```

When `enabled=true`, these values act as _global caps_ that override the existing per-feature defaults.
When `enabled=false` (default), behavior is unchanged.

### Scope (Phase 1)

- **bootstrap injection**: `resolveBootstrapMaxChars()` uses `contextBudget.bootstrapMaxChars` if enabled.
- **memory injection**: memory tool clamps results using `min(configuredMaxInjectedChars, contextBudget.memoryMaxInjectedChars)` if enabled.
- **web_fetch output**: `web_fetch` resolves `maxChars` using `min(configuredMaxChars, contextBudget.webFetchMaxChars)` if enabled.

This phase intentionally stays in **chars** (not exact tokens) because:

- it is deterministic and cheap to compute
- it maps well to existing controls (`maxChars`)

### Non-goals (Phase 1)

- token-precise accounting across full prompt
- automatic summarization/trimming policies
- per-session adaptive budgets

Those can be layered later once the budget “hook points” exist.

## Consequences

Pros:

- upstream-friendly: additive + behind a flag
- consistent caps across the biggest cost drivers
- easy to reason about and tune

Cons:

- chars are only an approximation of tokens
- does not by itself guarantee quality (still needs good prompting/usage)

## Follow-ups

- Phase 2: add optional summarization hook(s) for long tool outputs (web/doc) while preserving source metadata.
- Phase 2: add a `/context budget` report showing effective caps and what was clamped.
