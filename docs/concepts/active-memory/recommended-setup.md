---
summary: "The starter configuration to begin with, and the cold-start grace budget to set when upgrading from v2026.4.x."
read_when:
  - You want a starting configuration to tune from
  - Your first recall after a gateway restart times out
title: "Recommended setup"
---

## Recommended setup

Start with `recent`:

```json5
{
  plugins: {
    entries: {
      "active-memory": {
        enabled: true,
        config: {
          agents: ["main"],
          mode: "escalate",
          queryMode: "recent",
          promptStyle: "balanced",
          timeoutMs: 15000,
          maxSummaryChars: 220,
          logging: true,
        },
      },
    },
  },
}
```

Use `/verbose on` for the status line and `/trace on` for the debug summary
while tuning — both are sent as a follow-up after the main reply, not
before. Use `always` only when every eligible turn warrants the latency. Keep
`escalate` for the recommended balance, then choose `message`, `recent`, or
`full` for the deep-recall query itself.

### Cold-start grace

Before v2026.5.2 the plugin silently extended `timeoutMs` by an extra 30000
ms during cold start, so model warm-up, embedding-index load, and the first
recall could share one larger budget. v2026.5.2 moved that grace behind an
explicit `setupGraceTimeoutMs` config: `timeoutMs` is now the recall-work
budget by default unless you opt in. The blocking hook wraps that budget in
two fixed phases: up to 1500 ms for session/config preflight before recall
starts, then a separate fixed 1500 ms for abort settlement and transcript
recovery after recall work stops. Neither allowance extends model or tool
execution.

If you upgraded from v2026.4.x and tuned `timeoutMs` for the old
implicit-grace world (the recommended starter `timeoutMs: 15000` is one
example), set `setupGraceTimeoutMs: 30000` to restore the pre-v2026.5.2 effective
budget:

```json5
{
  plugins: {
    entries: {
      "active-memory": {
        config: {
          timeoutMs: 15000,
          setupGraceTimeoutMs: 30000,
        },
      },
    },
  },
}
```

Worst-case blocking time is `timeoutMs + setupGraceTimeoutMs + 3000` ms (the
configured recall-work budget, plus up to 1500 ms preflight, plus a fixed
1500 ms post-recall completion allowance). The embedded recall runner uses
the same effective timeout budget, so `setupGraceTimeoutMs` covers both the
outer prompt-build watchdog and the inner blocking recall run.

For resource-tight gateways where cold-start latency is an accepted
trade-off, lower values (5000-15000 ms) work too — the trade-off is a higher
chance of the very first recall after a gateway restart returning empty
while warm-up finishes.
