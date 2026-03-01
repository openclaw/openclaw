---
summary: "CLI reference for `openclaw health` (gateway health endpoint via RPC)"
read_when:
  - You want to quickly check the running Gateway's health
title: "health"
---

# `openclaw health`

Fetch health from the running Gateway over RPC.

Use this as a quick liveness check. For deeper diagnostics, see [`openclaw doctor`](/cli/doctor) or [`openclaw status`](/cli/status).

## Flags

| Flag | Description |
|------|-------------|
| `--json` | Output JSON instead of human-readable text |
| `--timeout <ms>` | Connection timeout in milliseconds (default: `10000`) |
| `--verbose` | Verbose logging |
| `--debug` | Alias for `--verbose` |

## Examples

Basic health check:

```bash
openclaw health
```

JSON output (useful for scripting):

```bash
openclaw health --json
```

Verbose output (shows per-account probe timings when multiple accounts are configured):

```bash
openclaw health --verbose
```

Tighten the timeout for fast failure in scripts:

```bash
openclaw health --timeout 3000 --json
```

## Notes

- `--verbose` runs live probes and prints per-account timings when multiple accounts are configured.
- Output includes per-agent session store info when multiple agents are configured.
- If the Gateway is not running or not reachable, the command exits with a non-zero status. Run `openclaw doctor` to diagnose connectivity issues.

## Related

- Deep diagnostics: [`openclaw doctor`](/cli/doctor)
- Channel health and session summary: [`openclaw status`](/cli/status)
- Gateway management: [`openclaw gateway`](/cli/gateway)
