---
summary: "CLI reference for `openclaw sessions` (list stored sessions + usage)"
read_when:
  - You want to list stored sessions and see recent activity
title: "sessions"
---

# `openclaw sessions`

List stored conversation sessions.

```bash
openclaw sessions
openclaw sessions --agent work
openclaw sessions --all-agents
openclaw sessions --active 120
openclaw sessions --json
```

Scope selection:

- default: configured default agent store
- `--agent <id>`: one configured agent store
- `--all-agents`: aggregate all configured agent stores
- `--store <path>`: explicit store path (cannot be combined with `--agent` or `--all-agents`)

JSON examples:

`openclaw sessions --all-agents --json`:

```json
{
  "path": null,
  "stores": [
    { "agentId": "main", "path": "/home/user/.openclaw/agents/main/sessions/sessions.json" },
    { "agentId": "work", "path": "/home/user/.openclaw/agents/work/sessions/sessions.json" }
  ],
  "allAgents": true,
  "count": 2,
  "activeMinutes": null,
  "sessions": [
    { "agentId": "main", "key": "agent:main:main", "model": "gpt-5" },
    { "agentId": "work", "key": "agent:work:main", "model": "claude-opus-4-5" }
  ]
}
```

## Delete sessions

Delete one or many stored sessions:

```bash
openclaw sessions rm "agent:main:main"
openclaw sessions rm --agent work "agent:work:main"
openclaw sessions clear --all
openclaw sessions clear --older-than 7d
openclaw sessions clear --all --dry-run
openclaw sessions clear --older-than 1h --json
```

## `openclaw sessions rm`

Delete one session by key and all aliases that point at the same transcript:

```bash
openclaw sessions rm "agent:main:main"
openclaw sessions rm --agent work "agent:work:main"
openclaw sessions rm --dry-run "agent:main:main"
openclaw sessions rm --json "agent:main:main"
```

`openclaw sessions rm` is case-insensitive for key match and removes:
- the requested key
- any key sharing the same `sessionId` as the requested key

If the key is not found, the command exits with code 1.

Example JSON output:

```json
{
  "agentId": "main",
  "storePath": "/home/user/.openclaw/agents/main/sessions/sessions.json",
  "mode": "rm",
  "dryRun": false,
  "beforeCount": 3,
  "afterCount": 1,
  "deletedCount": 2,
  "deletedKeys": ["agent:main:alias", "agent:main:main"],
  "deletedSessionIds": ["sid-1"]
}
```

## `openclaw sessions clear`

Delete many sessions by age or remove all entries from the selected scope:

```bash
openclaw sessions clear --all
openclaw sessions clear --all --agent work
openclaw sessions clear --all --dry-run
openclaw sessions clear --older-than 30d
openclaw sessions clear --older-than 7d --json
openclaw sessions clear --older-than 1h --all-agents
```

Notes:
- `--all` and `--older-than` are mutually exclusive.
- `--all`: remove all entries in the selected store(s).
- `--older-than <duration>`: remove entries whose `updatedAt` is older than the duration.
- Transcript files are archived before removal when they can be resolved and removed safely.
- Use `--dry-run` to preview deletions.

JSON output for all-agent clear:

```json
{
  "allAgents": true,
  "dryRun": false,
  "mode": "clear-older-than",
  "stores": [
    {
      "agentId": "main",
      "storePath": "/home/user/.openclaw/agents/main/sessions/sessions.json",
      "mode": "clear-older-than",
      "dryRun": false,
      "beforeCount": 128,
      "afterCount": 12,
      "deletedCount": 116,
      "deletedKeys": ["agent:main:abc", "agent:main:def"],
      "deletedSessionIds": ["sid-1", "sid-2"]
    }
  ]
}
```

## Cleanup maintenance

Run maintenance now (instead of waiting for the next write cycle):

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --agent work --dry-run
openclaw sessions cleanup --all-agents --dry-run
openclaw sessions cleanup --enforce
openclaw sessions cleanup --enforce --active-key "agent:main:telegram:dm:123"
openclaw sessions cleanup --json
```

`openclaw sessions cleanup` uses `session.maintenance` settings from config:

- Scope note: `openclaw sessions cleanup` maintains session stores/transcripts only. It does not prune cron run logs (`cron/runs/<jobId>.jsonl`), which are managed by `cron.runLog.maxBytes` and `cron.runLog.keepLines` in [Cron configuration](/automation/cron-jobs#configuration) and explained in [Cron maintenance](/automation/cron-jobs#maintenance).

- `--dry-run`: preview how many entries would be pruned/capped without writing.
  - In text mode, dry-run prints a per-session action table (`Action`, `Key`, `Age`, `Model`, `Flags`) so you can see what would be kept vs removed.
- `--enforce`: apply maintenance even when `session.maintenance.mode` is `warn`.
- `--active-key <key>`: protect a specific active key from disk-budget eviction.
- `--agent <id>`: run cleanup for one configured agent store.
- `--all-agents`: run cleanup for all configured agent stores.
- `--store <path>`: run against a specific `sessions.json` file.
- `--json`: print a JSON summary. With `--all-agents`, output includes one summary per store.

`openclaw sessions cleanup --all-agents --dry-run --json`:

```json
{
  "allAgents": true,
  "mode": "warn",
  "dryRun": true,
  "stores": [
    {
      "agentId": "main",
      "storePath": "/home/user/.openclaw/agents/main/sessions/sessions.json",
      "beforeCount": 120,
      "afterCount": 80,
      "pruned": 40,
      "capped": 0
    },
    {
      "agentId": "work",
      "storePath": "/home/user/.openclaw/agents/work/sessions/sessions.json",
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
