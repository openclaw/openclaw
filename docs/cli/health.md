---
summary: "CLI reference for `openclaw health` (gateway health endpoint via RPC)"
read_when:
  - You want to quickly check the running Gateway’s health
title: "health"
---

# `openclaw health`

Fetch health from the running Gateway.

Options:

- `--json`: machine-readable output
- `--timeout <ms>`: connection timeout in milliseconds (default `10000`)
- `--verbose`: verbose logging
- `--debug`: alias for `--verbose`

Examples:

```bash
openclaw health
openclaw health --json
openclaw health --timeout 2500
openclaw health --verbose
openclaw health --debug
```

Notes:

- `--verbose` runs live probes and prints per-account timings when multiple accounts are configured.
- Output includes per-agent session stores when multiple agents are configured.
