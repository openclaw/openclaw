---
summary: "CLI reference for `mullusi dns` (wide-area discovery helpers)"
read_when:
  - You want wide-area discovery (DNS-SD) via Tailscale + CoreDNS
  - You’re setting up split DNS for a custom discovery domain (example: mullusi.internal)
title: "dns"
---

# `mullusi dns`

DNS helpers for wide-area discovery (Tailscale + CoreDNS). Currently focused on macOS + Homebrew CoreDNS.

Related:

- Gateway discovery: [Discovery](/gateway/discovery)
- Wide-area discovery config: [Configuration](/gateway/configuration)

## Setup

```bash
mullusi dns setup
mullusi dns setup --domain mullusi.internal
mullusi dns setup --apply
```

## `dns setup`

Plan or apply CoreDNS setup for unicast DNS-SD discovery.

Options:

- `--domain <domain>`: wide-area discovery domain (for example `mullusi.internal`)
- `--apply`: install or update CoreDNS config and restart the service (requires sudo; macOS only)

What it shows:

- resolved discovery domain
- zone file path
- current tailnet IPs
- recommended `mullusi.json` discovery config
- the Tailscale Split DNS nameserver/domain values to set

Notes:

- Without `--apply`, the command is a planning helper only and prints the recommended setup.
- If `--domain` is omitted, Mullusi uses `discovery.wideArea.domain` from config.
- `--apply` currently supports macOS only and expects Homebrew CoreDNS.
- `--apply` bootstraps the zone file if needed, ensures the CoreDNS import stanza exists, and restarts the `coredns` brew service.
