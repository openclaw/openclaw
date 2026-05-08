---
summary: "CLI reference for `openclaw sessions` (list stored sessions + usage)"
read_when:
  - You want to list stored sessions and see recent activity
title: "Sessions"
---

# `openclaw sessions`

List stored conversation sessions.

Session lists are not channel/provider liveness checks. They show persisted
conversation rows from the per-agent SQLite databases. A quiet Discord, Slack,
Telegram, or other channel can reconnect successfully without creating a new
session row until a message is processed. Use `openclaw channels status
--probe`, `openclaw status --deep`, or `openclaw health --verbose` when you need
live channel connectivity.

`openclaw sessions` and Gateway `sessions.list` responses are bounded by
default so large long-lived databases cannot monopolize the CLI process or
Gateway event loop. The CLI returns the newest 100 sessions by default; pass
`--limit <n>` for a smaller/larger window or `--limit all` when you intentionally
need the full store. JSON responses include `totalCount`, `limitApplied`, and
`hasMore` when callers need to show that more rows exist.

```bash
openclaw sessions
openclaw sessions --agent work
openclaw sessions --all-agents
openclaw sessions --active 120
openclaw sessions --limit 25
openclaw sessions --verbose
openclaw sessions --json
```

Scope selection:

- default: configured default agent database
- `--verbose`: verbose logging
- `--agent <id>`: one configured agent database
- `--all-agents`: aggregate all configured agent databases

Canonical per-agent session rows live in `openclaw-agent.sqlite` under each
agent. Existing `sessions.json` indexes are imported by the `openclaw doctor`
fix mode, then removed after SQLite has the rows. Gateway startup does not
import or rewrite legacy session indexes; run doctor when you intentionally want
that migration.

- `--limit <n|all>`: max rows to output (default `100`; `all` restores full output)

Export a trajectory bundle for a stored session:

```bash
openclaw sessions export-trajectory --session-key "agent:main:telegram:direct:123" --workspace .
openclaw sessions export-trajectory --session-key "agent:main:telegram:direct:123" --output bug-123 --json
```

This is the command path used by the `/export-trajectory` slash command after
the owner approves the exec request. The output directory is always resolved
inside `.openclaw/trajectory-exports/` under the selected workspace.

`openclaw sessions --all-agents` reads configured agent databases plus
registered agent databases. Legacy `sessions.json` files are migration inputs
only and should disappear after doctor imports them.

JSON examples:

`openclaw sessions --all-agents --json`:

```json
{
  "databasePath": null,
  "databases": [
    { "agentId": "main", "path": "/home/user/.openclaw/agents/main/agent/openclaw-agent.sqlite" },
    { "agentId": "work", "path": "/home/user/.openclaw/agents/work/agent/openclaw-agent.sqlite" }
  ],
  "allAgents": true,
  "count": 2,
  "totalCount": 2,
  "limitApplied": 100,
  "hasMore": false,
  "activeMinutes": null,
  "sessions": [
    { "agentId": "main", "key": "agent:main:main", "model": "gpt-5" },
    { "agentId": "work", "key": "agent:work:main", "model": "claude-opus-4-6" }
  ]
}
```

## Repair

Legacy JSON import belongs to `openclaw doctor --fix`. Runtime commands do not
prune, cap, import, or rewrite session databases. If doctor reports session rows
whose transcript events are missing, rerun doctor to import any remaining legacy
sources; if the source transcript is gone, reset or delete the affected session
explicitly.

Related:

- Session config: [Configuration reference](/gateway/config-agents#session)

## Related

- [CLI reference](/cli)
- [Session management](/concepts/session)
