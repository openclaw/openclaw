---
summary: "CLI reference for `openclaw system` (system events, heartbeat, presence)"
read_when:
  - You want to enqueue a system event without creating a cron job
  - You need the compatibility controls for migrated heartbeat jobs
  - You want to inspect system presence entries
title: "System"
---

# `openclaw system`

System-level helpers for the Gateway: enqueue system events, control migrated
monitor jobs through legacy interfaces, and view presence.

All `system` subcommands use Gateway RPC and accept the shared client flags:

| Flag                    | Default                              | Description                                                                                                                                                                                            |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--url <url>`           | `gateway.remote.url` when configured | Gateway WebSocket URL.                                                                                                                                                                                 |
| `--port <port>`         | none                                 | Local Gateway port.                                                                                                                                                                                    |
| `--token <token>`       | none                                 | Gateway token (if required).                                                                                                                                                                           |
| `--password <password>` | none                                 | Gateway password (if required).                                                                                                                                                                        |
| `--timeout <ms>`        | `30000`                              | RPC timeout in milliseconds.                                                                                                                                                                           |
| `--expect-final`        | off                                  | Accepted as a shared client flag, but has no effect on system commands.                                                                                                                                |
| `--json`                | off                                  | Output JSON. `heartbeat last/enable/disable` and `system presence` always print the raw RPC JSON payload regardless of this flag; `system event` uses it to switch between JSON and a plain `ok` line. |

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system event --text "Check for urgent follow-ups" --url ws://127.0.0.1:18789 --token "$OPENCLAW_GATEWAY_TOKEN"
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Use `--mode now` to submit a system event to ordinary session execution. It
targets the **main** session by default and waits behind existing work. The
legacy default mode, `next-heartbeat`, attaches the event to a suitable scheduled
automation for that session; it reports an error if no eligible job exists.
Use an explicit automation schedule when you need delayed work.

The command returns when the Gateway accepts the event, not when execution or
delivery finishes. `--expect-final` does not wait for an agent response.

Pass `--session-key` to target a specific session, for example to relay an
async-task completion back to the channel that started it. Prefer an
agent-qualified key. For example, if the `ops` agent is configured:

```bash
openclaw system event --text "Deploy finished" --session-key agent:ops:main --mode now
```

A targeted event stays with the selected session. Events assigned to another
session or a scheduled job stay with their own execution owner.

<Note>
**Timing exception with `--session-key`:** when `--session-key` is supplied,
`--mode next-heartbeat` collapses to an immediate targeted wake instead of
waiting for the next scheduled tick. Prefer `--mode now` to state that intent
explicitly. Create an automation when you want delayed delivery.
</Note>

Flags:

- `--text <text>`: required system event text.
- `--mode <mode>`: `now` or `next-heartbeat` (default).
- `--session-key <sessionKey>`: optional; target a specific agent session
  instead of the agent's main session. The Gateway rejects malformed
  agent-qualified keys, keys for unknown agents, targets that conflict with the
  caller's agent scope, and subagent sessions. Rejected targets do not fall back
  to the main session.

## `system heartbeat last|enable|disable`

- `last`: show the last compatibility heartbeat event.
- `enable`: enable the migrated/default proactive jobs recorded by setup or Doctor.
- `disable`: disable those jobs.

These compatibility controls do not affect unrelated automations and do not
recreate deleted jobs. If no converted/default job remains, use ordinary
`openclaw automations` commands or run Doctor to finish a pending migration.

## `system presence`

List the current system presence entries the Gateway knows about (nodes,
instances, and similar status lines).

## Notes

- Requires a running Gateway reachable by your current config (local or
  remote).
- System events are ephemeral and not persisted across restarts.
- Ctrl-C or SIGTERM cancels a pending `system presence` or `system heartbeat last`
  query without printing a late response. The CLI exits with status 130 or 143.
  System events and heartbeat changes already sent to the Gateway keep waiting
  for their acceptance receipt during cleanup.

## Related

- [CLI reference](/cli)
