---
summary: "Bonjour/mDNS discovery + debugging (Gateway beacons, clients, and common failure modes)"
read_when:
  - Debugging Bonjour discovery issues on macOS/iOS
  - Changing mDNS service types, TXT records, or discovery UX
---
# Bonjour / mDNS discovery

Clawdis uses Bonjour (mDNS / DNS-SD) as a **LAN-only convenience** to discover a running Gateway and (optionally) its bridge transport. It is best-effort and does **not** replace SSH or Tailnet-based connectivity.

## Wide-Area Bonjour (Unicast DNS-SD) over Tailscale

If you want Iris/iPad auto-discovery while the Gateway is on another network (e.g. Vienna ⇄ London), you can keep the `NWBrowser` UX but switch discovery from multicast mDNS (`local.`) to **unicast DNS-SD** (“Wide-Area Bonjour”) over Tailscale.

High level:

1) Run a DNS server on the gateway host (reachable via tailnet IP).
2) Publish DNS-SD records for `_clawdis-bridge._tcp` in a dedicated zone (example: `clawdis.internal.`).
3) Configure Tailscale **split DNS** so `clawdis.internal` resolves via that DNS server for clients (including iOS).
4) In Iris: Settings → Bridge → Advanced → set **Discovery Domain** to `clawdis.internal.`

### Example: CoreDNS on macOS (gateway host)

On the gateway host (macOS):

```bash
brew install coredns

sudo mkdir -p /opt/homebrew/etc/coredns
sudo tee /opt/homebrew/etc/coredns/Corefile >/dev/null <<'EOF'
clawdis.internal:53 {
    log
    errors
    file /opt/homebrew/etc/coredns/clawdis.internal.db
}
EOF

# Replace `<TAILNET_IPV4>` with the gateway machine’s tailnet IP.
sudo tee /opt/homebrew/etc/coredns/clawdis.internal.db >/dev/null <<'EOF'
$ORIGIN clawdis.internal.
$TTL 60

@ IN SOA ns.clawdis.internal. hostmaster.clawdis.internal. (
  2025121701 ; serial
  60         ; refresh
  60         ; retry
  604800     ; expire
  60         ; minimum
)

@  IN NS ns
ns IN A <TAILNET_IPV4>

gw-london IN A <TAILNET_IPV4>

_clawdis-bridge._tcp IN PTR ClawdisBridgeLondon._clawdis-bridge._tcp
ClawdisBridgeLondon._clawdis-bridge._tcp IN SRV 0 0 18790 gw-london
ClawdisBridgeLondon._clawdis-bridge._tcp IN TXT "displayName=Mac Studio (London)"
EOF

sudo brew services start coredns
```

Validate from any tailnet-connected machine:

```bash
dns-sd -B _clawdis-bridge._tcp clawdis.internal.
dig @<TAILNET_IPV4> -p 53 _clawdis-bridge._tcp.clawdis.internal PTR +short
```

### Tailscale DNS settings

In the Tailscale admin console:

- Add a nameserver pointing at the gateway’s tailnet IP (UDP/TCP 53).
- Add split DNS so the domain `clawdis.internal` uses that nameserver.

Once clients accept tailnet DNS, Iris can browse `_clawdis-bridge._tcp` in `clawdis.internal.` without multicast.

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
