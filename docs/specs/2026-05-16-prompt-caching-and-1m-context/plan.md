# Plan — 1-hour prompt caching + flat-rate 1M context

## Approach

Extend `src/agents/pi-embedded-runner/extra-params.ts` (which already injects `cache_control` markers) so the markers are TTL-aware and the breakpoints are placed by a small policy module that knows the session's stable prefix shape (system prompt, MEMORY preamble, skill manifests). Add `context.window` plumbing into the same request-builder so the 1M flat-rate context can be enabled per session. Cache + window state surface through `/usage` and `/status`.

## Steps

1. Add `src/agents/pi-embedded-runner/cache-markers.ts` — given the request payload, identify the stable prefix segments and emit `cache_control: { type: "ephemeral", ttl: "5m" | "1h" }` markers at the right boundaries.
2. Extend extra-params to honor the per-session `cache.ttl` setting; existing hardcoded 5m markers become the auto default.
3. Add `context.window="1M"` plumb-through in `src/agents/model-catalog.ts` capability flags + the request builder; reject when the model can't.
4. Per-session config + `sessions.patch` extension (alongside the `taskBudget` patch from the budgets spec): `cache.ttl`, `context.window`.
5. `/usage` extension — track cache-write, cache-read, cached-input token columns; show hit-rate %. Underlying counters come from the Anthropic usage object.
6. `openclaw doctor` — warn on `cache.ttl=1h` set against a non-cache-capable model; warn on `context.window=1M` against non-1M models.
7. CLI: `openclaw sessions set <key> --cache-ttl 1h --context-window 1M`.
8. Docs: extend `docs/concepts/models.md` with caching + 1M context notes.

## Dependencies / order

- Step 1 (markers) blocks step 2.
- Step 3 (1M plumb-through) is independent; can ship first.
- Step 5 (`/usage`) depends on 1–3 to have data to show.
