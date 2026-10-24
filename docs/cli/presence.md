---
summary: "CLI reference for `openclaw presence` (people/devices roster via presence.query)"
read_when:
  - You want to inspect connected people and devices from the CLI
  - You previously used `openclaw gateway call presence.query`
title: "presence"
---

# `openclaw presence`

Query the Gateway people/devices presence roster — the same `presence.query`
read model as the agent `presence` tool. The Control UI Devices page uses
`system-presence` plus pairing/node inventory instead, so offline paired devices
can still appear there when this query returns no connected device.

Distinct from [`system presence`](/cli/system#system-presence), which lists the
raw `system-presence` beacon entries.

## `presence query`

```bash
openclaw presence query --json
openclaw presence query --action person --person me --include devices --json
openclaw presence query --action device --device-id <id> --include network --include location --json
openclaw presence query --port 18789 --token "$TOKEN" --json
```

| Flag | Meaning |
| --- | --- |
| `--action <list\|person\|device>` | List people (default), inspect a person, or inspect a device |
| `--person <selector>` | For `person`: `me`, a returned id, or an unambiguous display name |
| `--device-id <id>` | For `device`: presence device id from a prior query |
| `--include <field>` | Repeatable: `devices`, `network`, `location` |
| `--limit <n>` | Max people for list (1–100; Gateway default 50) |
| `--url` / `--port` / `--token` / `--password` / `--timeout` | Gateway targeting (same as other Gateway-backed CLIs) |
| `--json` | Print Gateway JSON |

Backed by `presence.query` (`operator.read`). Prefer this over
`openclaw gateway call presence.query`. See [Presence](/concepts/presence).
