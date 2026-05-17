# Validation — 1-hour prompt caching + flat-rate 1M context

## Automated tests

- `src/agents/pi-embedded-runner/cache-markers.test.ts` — markers placed at expected segment boundaries; TTL honored.
- `src/agents/pi-embedded-runner/extra-params.test.ts` — `ttl: "1h"` emitted when configured; `5m` by default; absent when `off`.
- `src/agents/model-catalog.test.ts` — `supportsCaching` + `supportsMillionContext` true/false for known models.
- `src/agents/usage-tracking.test.ts` — cache-write/read/hit-rate counters correctly aggregated.
- E2E: `scripts/e2e/cache-budget-docker.sh` — fixture long-session that should hit ≥ 80% cache-read on turn 5+ against a stub provider.
- Live: gated `OPENCLAW_LIVE_TEST=1` — three-turn conversation reports a real hit rate above 0 on a cache-capable model.

## Smoke checks

- `openclaw sessions set <key> --cache-ttl 1h` then `/usage` after two turns shows non-zero `cache_read`.
- `openclaw sessions set <key> --context-window 1M` on Opus 4.7 succeeds; on a non-capable model errors clearly.
- `openclaw doctor` flags an incompatible combo.

## Manual criteria

- `/usage` columns are readable; hit-rate % is easy to spot.
- Operator can tell whether their session is benefiting from caching at a glance.

## AI eval plan

- Success criteria: on a 10-session fixture of repeat-shaped chats, average `cache_read` ratio ≥ 60% with default 5m markers, ≥ 85% with 1h markers when sessions span >5min.
- Eval dataset: `tests/evals/cache-replay/` — recorded session shapes (system prompt + skill bundle + user turn pattern).
- Regression set: 3 sessions — short (1 turn), medium (5 turns over 4min), long (10 turns over 30min).
- Cadence: per-PR on fixtures; nightly on the live-models matrix to validate Anthropic returns the cache counters we expect.

## Risks & rollback

- **Risks:**
  - Operator enables `1h` on a short session and overpays for the cache write. *Mitigate* with `/usage` visibility and a doctor hint.
  - 1M context surcharge surprise on a model that *advertises* 1M but Anthropic adds a flat fee later. *Detect via* the usage tracker; surface the per-call cost.
  - Marker placement breaks deterministic prefix on a future Pi SDK upgrade. *Detect via* the marker placement test.
- **Rollback:** set `cache.ttl=off` and `context.window=default` per session. PR revert is safe.

## Open questions

- Should the cache markers preserve through a `/compact` operation, or be rebuilt? Probably rebuilt, since the prefix changes.
