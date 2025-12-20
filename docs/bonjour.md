---
summary: "Bonjour/mDNS discovery + debugging (Gateway beacons, clients, and common failure modes)"
read_when:
  - Debugging Bonjour discovery issues on macOS/iOS
  - Changing mDNS service types, TXT records, or discovery UX
---
# Bonjour / mDNS discovery

Clawdis uses Bonjour (mDNS / DNS-SD) as a **LAN-only convenience** to discover a running Gateway bridge transport. It is best-effort and does **not** replace SSH or Tailnet-based connectivity.

## Wide-Area Bonjour (Unicast DNS-SD) over Tailscale

If you want iOS node auto-discovery while the Gateway is on another network (e.g. Vienna ⇄ London), you can keep the `NWBrowser` UX but switch discovery from multicast mDNS (`local.`) to **unicast DNS-SD** (“Wide-Area Bonjour”) over Tailscale.

High level:

1) Run a DNS server on the gateway host (reachable via tailnet IP).
2) Publish DNS-SD records for `_clawdis-bridge._tcp` in a dedicated zone (example: `clawdis.internal.`).
3) Configure Tailscale **split DNS** so `clawdis.internal` resolves via that DNS server for clients (including iOS).

Clawdis standardizes on the discovery domain `clawdis.internal.` for this mode. iOS/Android nodes browse both `local.` and `clawdis.internal.` automatically (no per-device knob).

### Gateway config (recommended)

On the gateway host (the machine running the Gateway bridge), add to `~/.clawdis/clawdis.json` (JSON5):

```json5
{
  bridge: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } } // enables clawdis.internal DNS-SD publishing
}
```

### One-time DNS server setup (gateway host)

On the gateway host (macOS), run:

```bash
clawdis dns setup --apply
```

This installs CoreDNS and configures it to:
- listen on port 53 **only** on the gateway’s Tailscale interface IPs
- serve the zone `clawdis.internal.` from the gateway-owned zone file `~/.clawdis/dns/clawdis.internal.db`

The Gateway writes/updates that zone file when `discovery.wideArea.enabled` is true.

Validate from any tailnet-connected machine:

```bash
dns-sd -B _clawdis-bridge._tcp clawdis.internal.
dig @<TAILNET_IPV4> -p 53 _clawdis-bridge._tcp.clawdis.internal PTR +short
```

### Tailscale DNS settings

In the Tailscale admin console:

- Add a nameserver pointing at the gateway’s tailnet IP (UDP/TCP 53).
- Add split DNS so the domain `clawdis.internal` uses that nameserver.

Once clients accept tailnet DNS, iOS nodes can browse `_clawdis-bridge._tcp` in `clawdis.internal.` without multicast.
Wide-area beacons also include `tailnetDns` (when available) so the macOS app can auto-fill SSH targets off-LAN.

### Bridge listener security (recommended)

The bridge port (default `18790`) is a plain TCP service. By default it binds to `0.0.0.0`, which makes it reachable from *any* interface on the gateway machine (LAN/Wi‑Fi/Tailscale).

For a tailnet-only setup, bind it to the Tailscale IP instead:

- Set `bridge.bind: "tailnet"` in `~/.clawdis/clawdis.json`.
- Restart the Gateway (or restart the macOS menubar app via `./scripts/restart-mac.sh` on that machine).

This keeps the bridge reachable only from devices on your tailnet (unless you intentionally expose it some other way).

## What advertises

Only the **Node Gateway** (`clawd` / `clawdis gateway`) advertises Bonjour beacons.

- Implementation: `src/infra/bonjour.ts`
- Gateway wiring: `src/gateway/server.ts`

## Service types

- `_clawdis-bridge._tcp` — bridge transport beacon (used by macOS/iOS/Android nodes).

## TXT keys (non-secret hints)

The Gateway advertises small non-secret hints to make UI flows convenient:

- `role=gateway`
- `lanHost=<hostname>.local`
- `sshPort=<port>` (defaults to 22 when not overridden)
- `gatewayPort=<port>` (informational; the Gateway WS is typically loopback-only)
- `bridgePort=<port>` (only when bridge is enabled)
- `canvasPort=<port>` (only when the canvas host is enabled + reachable; same as `gatewayPort`; serves `/__clawdis__/canvas/`)
- `cliPath=<path>` (optional; absolute path to a runnable `clawdis` entrypoint or binary)
- `tailnetDns=<magicdns>` (optional hint; auto-detected from Tailscale when available; may be absent)

## Debugging on macOS

Useful built-in tools:

- Browse instances:
  - `dns-sd -B _clawdis-bridge._tcp local.`
- Resolve one instance (replace `<instance>`):
  - `dns-sd -L "<instance>" _clawdis-bridge._tcp local.`

If browsing shows instances but resolving fails, you’re usually hitting a LAN policy / multicast issue.

## Debugging in Gateway logs

The Gateway writes a rolling log file (printed on startup as `gateway log file: ...`).

Look for `bonjour:` lines, especially:

- `bonjour: advertise failed ...` (probing/announce failure)
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service; attempting re-advertise ...` (self-heal attempt after sleep/interface churn)

## Debugging on iOS node

The iOS node app discovers bridges via `NWBrowser` browsing `_clawdis-bridge._tcp`.

To capture what the browser is doing:

- Settings → Bridge → Advanced → enable **Discovery Debug Logs**
- Settings → Bridge → Advanced → open **Discovery Logs** → reproduce the “Searching…” / “No bridges found” case → **Copy**

The log includes browser state transitions (`ready`, `waiting`, `failed`, `cancelled`) and result-set changes (added/removed counts).

## Common failure modes

- **Bonjour doesn’t cross networks**: London/Vienna style setups require Tailnet (MagicDNS/IP) or SSH.
- **Multicast blocked**: some Wi‑Fi networks (enterprise/hotels) disable mDNS; expect “no results”.
- **Sleep / interface churn**: macOS may temporarily drop mDNS results when switching networks; retry.
- **Browse works but resolve fails (iOS “NoSuchRecord”)**: make sure the advertiser publishes a valid SRV target hostname.
  - Implementation detail: `@homebridge/ciao` defaults `hostname` to the *service instance name* when `hostname` is omitted. If your instance name contains spaces/parentheses, some resolvers can fail to resolve the implied A/AAAA record.
  - Fix: set an explicit DNS-safe `hostname` (single label; no `.local`) in `src/infra/bonjour.ts`.

## Escaped instance names (`\\032`)
Bonjour/DNS-SD often escapes bytes in service instance names as decimal `\\DDD` sequences (e.g. spaces become `\\032`).

- This is normal at the protocol level.
- UIs should decode for display (iOS uses `BonjourEscapes.decode` in `apps/shared/ClawdisKit`).

## Disabling / configuration

- `CLAWDIS_DISABLE_BONJOUR=1` disables advertising.
- `CLAWDIS_BRIDGE_ENABLED=0` disables the bridge listener (and therefore the bridge beacon).
- `bridge.bind` / `bridge.port` in `~/.clawdis/clawdis.json` control bridge bind/port (preferred).
- `CLAWDIS_BRIDGE_HOST` / `CLAWDIS_BRIDGE_PORT` still work as a back-compat override when `bridge.bind` / `bridge.port` are not set.
- `CLAWDIS_SSH_PORT` overrides the SSH port advertised in `_clawdis-bridge._tcp`.
- `CLAWDIS_TAILNET_DNS` publishes a `tailnetDns` hint (MagicDNS) in `_clawdis-bridge._tcp`. If unset, the gateway auto-detects Tailscale and publishes the MagicDNS name when possible.

## Related docs

- Discovery policy and transport selection: `docs/discovery.md`
- Node pairing + approvals: `docs/gateway/pairing.md`
