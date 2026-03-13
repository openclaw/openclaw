## Task: Tight patch for OpenClaw fallback/cooldown behavior

Implement ONLY this narrow change set:

1. In model fallback, when the current provider is fully cooldowned for a transient reason (`rate_limit` or `overloaded`) AND a cross-provider fallback candidate exists, do NOT foreground-probe the cooldowned provider. Skip directly to the cross-provider fallback.
2. Preserve existing same-provider fallback behavior unless required for the above.
3. Reduce log noise for non-terminal fallback/cooldown events where appropriate, but do not remove structured observability entirely.
4. Add/update focused tests covering:
   - cooldowned primary + cross-provider fallback => no foreground probe, fallback reached quickly
   - existing same-provider probe path still works where intended
5. Run targeted tests + a compile/build verification.

Files to focus on:

- src/agents/model-fallback.ts
- src/agents/model-fallback-observation.ts
- relevant model-fallback / embedded runner tests only

Avoid broader architecture changes. No unrelated cleanup.

At the end, print:

- exact files changed
- exact behavior change
- exact test/build commands run and results
