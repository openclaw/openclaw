---
summary: "`openclaw gateway discover` and the Bonjour beacons and TXT hints it scans for"
read_when:
  - Discovering gateways via Bonjour (local + wide-area DNS-SD)
title: "Discover gateways (Bonjour)"
sidebarTitle: "Discovery"
---

Scanning for Gateway beacons over mDNS and wide-area DNS-SD. Part of the [`openclaw gateway`](/cli/gateway) reference.

## Discover gateways (Bonjour)

`gateway discover` scans for Gateway beacons (`_openclaw-gw._tcp`).

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (wide-area Bonjour): choose a domain (example: `openclaw.internal.`) and set up split DNS + a DNS server; see [Bonjour](/gateway/bonjour).

Only gateways with Bonjour discovery enabled (default) advertise the beacon.

TXT hints on every beacon: `role` (gateway role hint), `transport` (transport hint, e.g. `gateway`), `gatewayPort` (WebSocket port, usually `18789`), `tailnetDns` (MagicDNS hostname, when available), `gatewayTls` / `gatewayTlsSha256` (TLS enabled + cert fingerprint). `sshPort` and `cliPath` are published only in full discovery mode (`discovery.mdns.mode: "full"`; default is `"minimal"`, which omits them — clients then default SSH targets to port `22`).

### `gateway discover`

```bash
openclaw gateway discover
```

<ParamField path="--timeout <ms>" type="number" default="2000">
  Per-command timeout (browse/resolve).
</ParamField>
<ParamField path="--json" type="boolean">
  Machine-readable output (also disables styling/spinner).
</ParamField>

Examples:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```

<Note>
- Scans `local.` plus the configured wide-area domain when one is enabled.
- `wsUrl` in JSON output is derived from the resolved service endpoint, not from TXT-only hints such as `lanHost` or `tailnetDns`.
- `discovery.mdns.mode` controls `sshPort`/`cliPath` publication on both `local.` mDNS and wide-area DNS-SD (see above).

</Note>
