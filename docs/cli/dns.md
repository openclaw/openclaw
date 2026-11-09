---
summary: "CLI reference for `openclaw dns` (wide-area discovery helpers)"
read_when:
  - You want wide-area discovery (DNS-SD) via Tailscale + CoreDNS
  - You're setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "DNS"
---

# `openclaw dns`

DNS helpers for wide-area discovery (Tailscale + CoreDNS). `openclaw dns setup` prints its plan on any platform; applying that plan with `--apply` requires macOS with Homebrew CoreDNS.

Related:

- Gateway discovery: [Discovery](/gateway/discovery)
- Wide-area publishing behavior: [Bonjour discovery](/gateway/bonjour)
- Wide-area discovery config: [`discovery.wideArea`](/gateway/config-runtime#wide-area-dns-sd)

## `dns setup`

Plan or apply CoreDNS setup for unicast DNS-SD discovery.

```bash
openclaw dns setup
openclaw dns setup --domain openclaw.internal
openclaw dns setup --apply
```

| Option              | Effect                                                                              |
| ------------------- | ----------------------------------------------------------------------------------- |
| `--domain <domain>` | Wide-area discovery domain (for example `openclaw.internal`).                       |
| `--apply`           | Install/update CoreDNS config and (re)start the service. Requires sudo, macOS only. |

Without `--domain`, OpenClaw uses `discovery.wideArea.domain` from config, falling
back to `OPENCLAW_WIDE_AREA_DOMAIN` when the config value is absent.

`--domain` selects the domain for this setup command; it does not save the domain
to OpenClaw config. `--apply` configures CoreDNS, but does not change OpenClaw
config or Tailscale Split DNS settings. To publish Gateway service records, set
`discovery.wideArea.domain` in the Gateway's config to the same domain and restart
the Gateway. The environment variable alone does not enable Gateway publishing.
Complete the Tailscale Split DNS settings shown in the plan; see
[Wide-area Bonjour setup](/gateway/bonjour#wide-area-bonjour-unicast-dns-sd-over-tailscale).

If no domain is configured, `--domain` is not a valid DNS name, or `--apply`
runs off macOS or without a tailnet IP, the CLI prints the specific reason on
stderr and exits with status `1`.

The preview escapes control characters in displayed paths; the actual zone path is unchanged.

Without `--apply`, the command only prints:

- Resolved discovery domain and zone file path
- Current tailnet IPs
- Recommended `openclaw.json` discovery config
- Tailscale Split DNS nameserver/domain values to set in the Tailscale admin console

With `--apply` (macOS only, requires Homebrew CoreDNS):

- Bootstraps the zone file if missing
- Adds the CoreDNS import stanza if missing
- Restarts the `coredns` brew service

## Related

- [CLI reference](/cli)
- [Discovery](/gateway/discovery)
