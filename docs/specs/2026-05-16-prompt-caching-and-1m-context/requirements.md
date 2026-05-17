# Requirements — 1-hour prompt caching + flat-rate 1M context

## Outcome

Operators can enable per-session 1-hour prompt caching (cache writes at 2× base, reads at 0.1× — Anthropic May 2026 pricing) and opt into the flat-rate 1M context window on Opus 4.7 and Sonnet 4.6 without per-message ceremony. The Gateway auto-routes high-reuse system prompts + skill bundles + memory directories through `cache_control` and reports cache hit rate per session in `/usage`.

## Users affected

- Operators running long, repeat-prompt-shaped sessions (interactive chats with stable system context, agents with large bundled skills).
- The agent runtime — `src/agents/pi-embedded-runner/extra-params.ts` already understands `cache_control` (hardcoded 5-minute markers); we extend to 1h.
- Cost reporting — `/usage` chat command, `src/agents/usage-tracking`.

## In scope

- Per-session `cache.ttl = "5m" | "1h" | "off"` (default `5m` to preserve current behavior).
- Auto-mark cache breakpoints for: system prompt, MEMORY.md preamble, bundled-skill manifests, large attachments. Operator can override the auto markers.
- Per-session `context.window = "default" | "1M"` for capable models. Auto-rejects on non-capable models with a clear error.
- `/usage` shows `cached_input`, `cache_write`, `cache_read` token columns + hit-rate %.
- Doctor warning when `cache.ttl=1h` is used with a model that doesn't support it.

## Out of scope

- Cross-session cache sharing (Anthropic doesn't expose it; we don't fake it).
- Pre-warming caches at startup.
- Custom cache TTLs beyond the two Anthropic offers (5m / 1h).
- Provider-specific caching for non-Anthropic providers (each has its own model + may not have caching).

## Decisions

- Default TTL `5m`, not `1h`. Reason: 1h write is 2× base — easy to overspend if the session doesn't reuse enough.
- Auto-mark the system prompt + skill bundle by default; don't auto-mark user messages. Reason: the system prompt is stable across turns; user messages aren't.
- 1M context is opt-in per session, not per agent. Reason: avoid accidental enable on short sessions where the flat rate is still wasted token allocation.
