---
summary: "CLI reference for `openclaw stats` (aggregate token usage and cost from stored sessions)"
read_when:
  - You want a quick token usage and cost summary for your agents
  - You need per-agent or per-provider usage totals from the terminal
  - You are scripting usage reporting and want machine-readable output
title: "Stats CLI"
---

# `openclaw stats`

Aggregate token usage and estimated cost from stored session metadata. This CLI
is read-only: it reads the same session stores as [`sessions`](/cli/sessions)
and never writes state or calls provider APIs.

Bare `openclaw stats` runs the usage summary; `openclaw stats usage` is the
explicit form.

## Commands

```bash
openclaw stats
openclaw stats usage
openclaw stats --agent work
openclaw stats --all-agents
openclaw stats --since 7d
openclaw stats --until 2026-01-31
openclaw stats --provider anthropic
openclaw stats --json
```

## Options

- `--store <path>`: read a specific session store instead of the configured one.
- `--agent <id>`: scope to a single agent (default: configured default agent).
- `--all-agents`: aggregate across all configured agents.
- `--since <when>`: only include sessions updated at or after this bound.
- `--until <when>`: only include sessions updated at or before this bound.
- `--provider <id>`: only include sessions for a model provider (case-insensitive).
- `--json`: print machine-readable output.

`--since` and `--until` accept either a duration relative to now (for example
`7d`, `24h`, `1h30m`; a bare number means days) or an absolute ISO date such as
`2026-01-31`.

## Output

Token totals sum each session's recorded input and output tokens. They are not
the per-session context-window snapshot shown by `sessions`, so they can be
added up meaningfully across sessions. Sessions without recorded usage still
count toward the session total with zero tokens.

The human-readable summary reports overall totals, then a per-agent breakdown
(when more than one agent is in scope) and a per-provider breakdown. Breakdown
rows are ordered by total tokens descending, then by name.

```text
Session store: /Users/alex/.openclaw/agents/main/agent/sessions.json
Sessions: 42
Input tokens: 1,204,880
Output tokens: 210,455
Total tokens: 1,415,335
Estimated cost: $12.4021
By provider:
  anthropic  sessions=30  in=1,000,000  out=180,000  total=1,180,000  cost=$10.5000
  openai     sessions=12  in=204,880    out=30,455    total=235,335    cost=$1.9021
```

`--json` returns an object with the resolved `stores`, the applied `since` /
`until` / `provider` filters, overall `totals`, and `byAgent` / `byProvider`
arrays. Each totals object has `sessions`, `inputTokens`, `outputTokens`,
`totalTokens`, and `estimatedCostUsd`.
