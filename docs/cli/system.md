---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw system` (system events, heartbeat, presence)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to enqueue a system event without creating a cron job（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to enable or disable heartbeats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to inspect system presence entries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "system"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw system`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
System-level helpers for the Gateway: enqueue system events, control heartbeats,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and view presence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw system event --text "Check for urgent follow-ups" --mode now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw system heartbeat enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw system heartbeat last（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw system presence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## `system event`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enqueue a system event on the **main** session. The next heartbeat will inject（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
it as a `System:` line in the prompt. Use `--mode now` to trigger the heartbeat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
immediately; `next-heartbeat` waits for the next scheduled tick.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Flags:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--text <text>`: required system event text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--mode <mode>`: `now` or `next-heartbeat` (default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: machine-readable output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## `system heartbeat last|enable|disable`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Heartbeat controls:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `last`: show the last heartbeat event.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enable`: turn heartbeats back on (use this if they were disabled).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `disable`: pause heartbeats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Flags:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: machine-readable output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## `system presence`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List the current system presence entries the Gateway knows about (nodes,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
instances, and similar status lines).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Flags:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: machine-readable output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires a running Gateway reachable by your current config (local or remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- System events are ephemeral and not persisted across restarts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
