---
summary: "CLI reference for `openclaw health` (gateway health snapshot via RPC)"
read_when:
  - You want to quickly check the running Gateway's health
title: "Health"
---

# `openclaw health`

Fetch a health snapshot from the running Gateway over WebSocket RPC (no direct channel sockets from the CLI).

## Options

| Flag             | Default | Description                                                                       |
| ---------------- | ------- | --------------------------------------------------------------------------------- |
| `--json`         | `false` | Print machine-readable JSON instead of text.                                      |
| `--timeout <ms>` | dynamic | Overall Gateway response deadline in milliseconds.                                |
| `--verbose`      | `false` | Forces a live probe and expands output across all configured accounts and agents. |
| `--debug`        | `false` | Alias for `--verbose`.                                                            |

Examples:

```bash
openclaw health
openclaw health --json
openclaw health --timeout 2500
openclaw health --verbose
openclaw health --debug
```

## Behavior

- Without `--verbose`, the Gateway can return a cached snapshot (fresh for up to 60 seconds and unchanged from live channel runtime state) and refresh it in the background for the next caller.
- `--verbose` forces a live probe (per-channel account probes), prints Gateway connection details, and expands human-readable output across all configured accounts and agents instead of just the default agent.
- Without an explicit `--timeout`, cached health keeps the 10-second response deadline. Live `--verbose`/`--debug` health keeps connection startup bounded, then waits for the Gateway to finish its account-dependent probe set. The Gateway bounds every account probe to 10 seconds and runs at most five for one channel concurrently.
- An explicit `--timeout` is always the overall client response deadline, including in verbose/debug mode.
- `--json` always returns the full snapshot: channels, per-account probes, plugin load state, context-engine quarantine state, model-pricing cache state, event-loop health, delivery-queue dead letters, and per-agent session stores.
- When outbound deliveries or inbound channel events are dead-lettered, text output reports their counts and oldest failure age. Inbound counts are grouped by channel account; inspect or recover individual events with [`openclaw channels dead-letters`](/cli/channels#inbound-dead-letters).

## Related

- [CLI reference](/cli)
- [`openclaw status`](/cli/status) — local diagnosis and channel probes without a full health snapshot
- [Gateway health](/gateway/health)
