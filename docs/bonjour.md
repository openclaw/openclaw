---
summary: "Bonjour/mDNS discovery + debugging (Gateway beacons, clients, and common failure modes)"
read_when:
  - Debugging Bonjour discovery issues on macOS/iOS
  - Changing mDNS service types, TXT records, or discovery UX
---
# Bonjour / mDNS discovery

Clawdis uses Bonjour (mDNS / DNS-SD) as a **LAN-only convenience** to discover a running Gateway and (optionally) its bridge transport. It is best-effort and does **not** replace SSH or Tailnet-based connectivity.

## What advertises

Only the **Node Gateway** (`clawd` / `clawdis gateway`) advertises Bonjour beacons.

- Implementation: `src/infra/bonjour.ts`
- Gateway wiring: `src/gateway/server.ts`

## Service types

- `_clawdis-master._tcp` — “master gateway” discovery beacon (primarily for macOS remote-control UX).
- `_clawdis-bridge._tcp` — bridge transport beacon (used by Iris/iOS nodes).

## TXT keys (non-secret hints)

The Gateway advertises small non-secret hints to make UI flows convenient:

- `role=master`
- `lanHost=<hostname>.local`
- `sshPort=<port>` (defaults to 22 when not overridden)
- `gatewayPort=<port>` (informational; the Gateway WS is typically loopback-only)
- `bridgePort=<port>` (only when bridge is enabled)
- `tailnetDns=<magicdns>` (optional hint; may be absent)

## Debugging on macOS

Useful built-in tools:

- Browse instances:
  - `dns-sd -B _clawdis-master._tcp local.`
  - `dns-sd -B _clawdis-bridge._tcp local.`
- Resolve one instance (replace `<instance>`):
  - `dns-sd -L "<instance>" _clawdis-master._tcp local.`
  - `dns-sd -L "<instance>" _clawdis-bridge._tcp local.`

If browsing shows instances but resolving fails, you’re usually hitting a LAN policy / multicast issue.

## Debugging in Gateway logs

The Gateway writes a rolling log file (printed on startup as `gateway log file: ...`).

Look for `bonjour:` lines, especially:

- `bonjour: advertise failed ...` (probing/announce failure)
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service; attempting re-advertise ...` (self-heal attempt after sleep/interface churn)

## Debugging on iOS (Iris)

Iris discovers bridges via `NWBrowser` browsing `_clawdis-bridge._tcp`.

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
- `CLAWDIS_BRIDGE_HOST` / `CLAWDIS_BRIDGE_PORT` control bridge bind/port.
- `CLAWDIS_SSH_PORT` overrides the SSH port advertised in `_clawdis-master._tcp`.
- `CLAWDIS_TAILNET_DNS` publishes a `tailnetDns` hint (MagicDNS) in `_clawdis-master._tcp`.

## Related docs

- Discovery policy and transport selection: `docs/discovery.md`
- Node pairing + approvals: `docs/gateway/pairing.md`
