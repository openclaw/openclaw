---
summary: "CLI reference for `mullusi sessions` (list stored sessions + usage)"
read_when:
  - You want to list stored sessions and see recent activity
title: "sessions"
---

# `mullusi sessions`

List stored conversation sessions.

```bash
mullusi sessions
mullusi sessions --agent work
mullusi sessions --all-agents
mullusi sessions --active 120
mullusi sessions --verbose
mullusi sessions --json
```

Scope selection:

- default: configured default agent store
- `--verbose`: verbose logging
- `--agent <id>`: one configured agent store
- `--all-agents`: aggregate all configured agent stores
- `--store <path>`: explicit store path (cannot be combined with `--agent` or `--all-agents`)

`mullusi sessions --all-agents` reads configured agent stores. Gateway and ACP
session discovery are broader: they also include disk-only stores found under
the default `agents/` root or a templated `session.store` root. Those
discovered stores must resolve to regular `sessions.json` files inside the
agent root; symlinks and out-of-root paths are skipped.

JSON examples:

`mullusi sessions --all-agents --json`:

```json
{
  "path": null,
  "stores": [
    { "agentId": "main", "path": "/home/user/.mullusi/agents/main/sessions/sessions.json" },
    { "agentId": "work", "path": "/home/user/.mullusi/agents/work/sessions/sessions.json" }
  ],
  "allAgents": true,
  "count": 2,
  "activeMinutes": null,
  "sessions": [
    { "agentId": "main", "key": "agent:main:main", "model": "gpt-5" },
    { "agentId": "work", "key": "agent:work:main", "model": "claude-opus-4-6" }
  ]
}
```

## Cleanup maintenance

Run maintenance now (instead of waiting for the next write cycle):

```bash
mullusi sessions cleanup --dry-run
mullusi sessions cleanup --agent work --dry-run
mullusi sessions cleanup --all-agents --dry-run
mullusi sessions cleanup --enforce
mullusi sessions cleanup --enforce --active-key "agent:main:telegram:direct:123"
mullusi sessions cleanup --json
```

`mullusi sessions cleanup` uses `session.maintenance` settings from config:

- Scope note: `mullusi sessions cleanup` maintains session stores/transcripts only. It does not prune cron run logs (`cron/runs/<jobId>.jsonl`), which are managed by `cron.runLog.maxBytes` and `cron.runLog.keepLines` in [Cron configuration](/automation/cron-jobs#configuration) and explained in [Cron maintenance](/automation/cron-jobs#maintenance).

- `--dry-run`: preview how many entries would be pruned/capped without writing.
  - In text mode, dry-run prints a per-session action table (`Action`, `Key`, `Age`, `Model`, `Flags`) so you can see what would be kept vs removed.
- `--enforce`: apply maintenance even when `session.maintenance.mode` is `warn`.
- `--fix-missing`: remove entries whose transcript files are missing, even if they would not normally age/count out yet.
- `--active-key <key>`: protect a specific active key from disk-budget eviction.
- `--agent <id>`: run cleanup for one configured agent store.
- `--all-agents`: run cleanup for all configured agent stores.
- `--store <path>`: run against a specific `sessions.json` file.
- `--json`: print a JSON summary. With `--all-agents`, output includes one summary per store.

`mullusi sessions cleanup --all-agents --dry-run --json`:

```json
{
  "allAgents": true,
  "mode": "warn",
  "dryRun": true,
  "stores": [
    {
      "agentId": "main",
      "storePath": "/home/user/.mullusi/agents/main/sessions/sessions.json",
      "beforeCount": 120,
      "afterCount": 80,
      "pruned": 40,
      "capped": 0
    },
    {
      "agentId": "work",
      "storePath": "/home/user/.mullusi/agents/work/sessions/sessions.json",
      "beforeCount": 18,
      "afterCount": 18,
      "pruned": 0,
      "capped": 0
    }
  ]
}
```

Related:

- Session config: [Configuration reference](/gateway/configuration-reference#session)
