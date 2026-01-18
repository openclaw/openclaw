---
summary: "CLI reference for `clawdbot service` (manage gateway + node services)"
read_when:
  - You want to manage Gateway or node services cross-platform
  - You want a single surface for start/stop/install/uninstall
---

# `clawdbot service`

Manage the **Gateway** service and **node host** services.

Related:
- Gateway daemon (legacy alias): [Daemon](/cli/daemon)
- Node host: [Node](/cli/node)

## Gateway service

```bash
clawdbot service gateway status
clawdbot service gateway install --port 18789
clawdbot service gateway start
clawdbot service gateway stop
clawdbot service gateway restart
clawdbot service gateway uninstall
```

Notes:
- `service gateway status` supports `--json` and `--deep` for system checks.
- `service gateway install` supports `--runtime node|bun` and `--token`.

## Node host service

```bash
clawdbot service node status
clawdbot service node install --host <gateway-host> --port 18790
clawdbot service node start
clawdbot service node stop
clawdbot service node restart
clawdbot service node uninstall
```

Notes:
- `service node install` supports `--runtime node|bun`, `--node-id`, `--display-name`,
  and TLS options (`--tls`, `--tls-fingerprint`).

## Aliases

- `clawdbot daemon …` → `clawdbot service gateway …`
- `clawdbot node service …` → `clawdbot service node …`
- `clawdbot node status` → `clawdbot service node status`
- `clawdbot node daemon …` → `clawdbot service node …` (legacy)
