---
summary: "CLI reference for `smart-agent-neo health` (gateway health endpoint via RPC)"
read_when:
  - You want to quickly check the running Gateway’s health
title: "health"
---

# `smart-agent-neo health`

Fetch health from the running Gateway.

```bash
smart-agent-neo health
smart-agent-neo health --json
smart-agent-neo health --verbose
```

Notes:

- `--verbose` runs live probes and prints per-account timings when multiple accounts are configured.
- Output includes per-agent session stores when multiple agents are configured.
