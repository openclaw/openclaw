---
summary: "CLI reference for `openclaw dns` (wide-area discovery helpers)"
read_when:
  - You want wide-area discovery (DNS-SD) via Tailscale + CoreDNS
  - You're setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
---

# `openclaw dns`

DNS helpers for wide-area discovery (Tailscale + CoreDNS). Configures unicast DNS-SD so OpenClaw gateways can be discovered across a tailnet, not just on the local LAN.

Currently focused on macOS + Homebrew CoreDNS.

Related:

- Gateway discovery: [Discovery](/gateway/discovery)
- Wide-area Bonjour: [Bonjour](/gateway/bonjour)
- Wide-area discovery config: [Configuration](/gateway/configuration)

## Subcommands

### `dns setup`

Set up CoreDNS to serve your discovery domain for Wide-Area Bonjour (unicast DNS-SD).

Without `--apply`, the command prints the recommended config and Tailscale admin steps without making any changes. Add `--apply` to actually install and configure CoreDNS.

```bash
openclaw dns setup
openclaw dns setup --apply
openclaw dns setup --domain openclaw.internal --apply
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--domain <domain>` | Wide-area discovery domain (e.g. `openclaw.internal`). Falls back to `discovery.wideArea.domain` in config. |
| `--apply` | Install/update CoreDNS config and (re)start the service. Requires sudo on macOS. |

## Setup walkthrough

**1. Dry run — see what will be configured:**

```bash
openclaw dns setup --domain openclaw.internal
```

This prints:
- The discovery domain and zone file path
- Your Tailscale IPs
- The recommended `~/.openclaw/openclaw.json` snippet
- Tailscale admin steps (add a split-DNS nameserver)

**2. Apply — install CoreDNS and write configs:**

```bash
openclaw dns setup --domain openclaw.internal --apply
```

This will (with sudo where needed):
- Install CoreDNS via Homebrew if not already installed
- Write a CoreDNS server block for your discovery domain
- Bootstrap the DNS zone file
- Restart the CoreDNS service

**3. Enable wide-area discovery in your Gateway config:**

```json
{
  "gateway": { "bind": "auto" },
  "discovery": {
    "wideArea": {
      "enabled": true,
      "domain": "openclaw.internal"
    }
  }
}
```

Then restart the Gateway. It will write DNS-SD records into the zone file automatically.

**4. Add a split-DNS nameserver in the Tailscale admin console:**

- Go to **DNS → Nameservers → Add nameserver**
- Set the nameserver IP to this machine's Tailscale IPv4 address
- Restrict it to your domain (e.g. `openclaw.internal`)

Once done, other machines on your tailnet can discover this Gateway via `openclaw gateway discover`.

## Notes

- `dns setup --apply` is macOS-only and requires Homebrew.
- The zone file is managed by the Gateway once wide-area discovery is enabled — do not edit it manually, as the Gateway overwrites it on restart.
- If your Tailscale IP changes, rerun `openclaw dns setup --apply` to update the CoreDNS bind address.
