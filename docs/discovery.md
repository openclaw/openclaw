---
summary: "Node discovery and transports (Bonjour, Tailscale, SSH) for finding the gateway"
read_when:
  - Implementing or changing Bonjour discovery/advertising
  - Adjusting remote connection modes (direct vs SSH)
  - Designing bridge + pairing for remote nodes
---
# Discovery & transports

Clawdis has two distinct problems that look similar on the surface:

1) **Operator remote control**: the macOS menu bar app controlling a gateway running elsewhere.
2) **Node pairing**: iOS/Android (and future nodes) finding a gateway and pairing securely.

The design goal is to keep all network discovery/advertising in the **Node Gateway** (`clawd` / `clawdis gateway`) and keep clients (mac app, iOS) as consumers.

## Terms

- **Gateway**: the single, long-running gateway process that owns state (sessions, pairing, node registry) and runs providers.
- **Gateway WS (loopback)**: the existing gateway WebSocket control endpoint on `127.0.0.1:18789`.
- **Bridge (direct transport)**: a LAN/tailnet-facing endpoint owned by the gateway that allows authenticated clients/nodes to call a scoped subset of gateway methods. The bridge exists so the gateway can remain loopback-only.
- **SSH transport (fallback)**: remote control by forwarding `127.0.0.1:18789` over SSH.

## Why we keep both “direct” and SSH

- **Direct bridge** is the best UX on the same network and within a tailnet:
  - auto-discovery on LAN via Bonjour
  - pairing tokens + ACLs owned by the gateway
  - no shell access required; protocol surface can stay tight and auditable
- **SSH** remains the universal fallback:
  - works anywhere you have SSH access (even across unrelated networks)
  - survives multicast/mDNS issues
  - requires no new inbound ports besides SSH

## Discovery inputs (how clients learn where the gateway is)

### 1) Bonjour / mDNS (LAN only)

Bonjour is best-effort and does not cross networks. It is only used for “same LAN” convenience.

Target direction:
- The **gateway** advertises its bridge via Bonjour.
- Clients browse and show a “pick a gateway” list, then store the chosen endpoint.

Troubleshooting and beacon details: `docs/bonjour.md`.

#### Current implementation

- Service types:
  - `_clawdis-bridge._tcp` (bridge transport beacon)
- TXT keys (non-secret):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (or whatever is advertised)
  - `gatewayPort=18789` (loopback WS port; informational)
  - `bridgePort=18790` (when bridge is enabled)
  - `canvasPort=18789` (same as `gatewayPort` when the canvas host is enabled + gateway bind is non-loopback; serves `/__clawdis__/canvas/`)
  - `cliPath=<path>` (optional; absolute path to a runnable `clawdis` entrypoint or binary)
  - `tailnetDns=<magicdns>` (optional hint; auto-detected when Tailscale is available)

Disable/override:
- `CLAWDIS_DISABLE_BONJOUR=1` disables advertising.
- `CLAWDIS_BRIDGE_ENABLED=0` disables the bridge listener.
- `bridge.bind` / `bridge.port` in `~/.clawdis/clawdis.json` control bridge bind/port (preferred).
- `CLAWDIS_BRIDGE_HOST` / `CLAWDIS_BRIDGE_PORT` still work as a back-compat override when `bridge.bind` / `bridge.port` are not set.
- `CLAWDIS_SSH_PORT` overrides the SSH port advertised in the bridge beacon (defaults to 22).
- `CLAWDIS_TAILNET_DNS` publishes a `tailnetDns` hint (MagicDNS) in the bridge beacon (auto-detected if unset).

### 2) Tailnet (cross-network)

For London/Vienna style setups, Bonjour won’t help. The recommended “direct” target is:
- Tailscale MagicDNS name (preferred) or a stable tailnet IP.

If the gateway can detect it is running under Tailscale, it publishes `tailnetDns` as an optional hint for clients (including wide-area beacons).

### 3) Manual / SSH target

When there is no direct route (or direct is disabled), clients can always connect via SSH by forwarding the loopback gateway port.

See `docs/remote.md`.

## Transport selection (client policy)

Recommended client behavior:

1) If a paired direct endpoint is configured and reachable, use it.
2) Else, if Bonjour finds a gateway on LAN, offer a one-tap “Use this gateway” choice and save it as the direct endpoint.
3) Else, if a tailnet DNS/IP is configured, try direct.
4) Else, fall back to SSH.

## Pairing + auth (direct transport)

The gateway is the source of truth for node/client admission.

- Pairing requests are created/approved/rejected in the gateway (see `docs/gateway/pairing.md`).
- The bridge enforces:
  - auth (token / keypair)
  - scopes/ACLs (bridge is not a raw proxy to every gateway method)
  - rate limits

## Where the code lives (target architecture)

- Node gateway:
  - advertises discovery beacons (Bonjour)
  - owns pairing storage + decisions
  - runs the bridge listener (direct transport)
- macOS app:
  - UI for picking a gateway, showing pairing prompts, and troubleshooting
  - SSH tunneling only for the fallback path
- iOS node:
  - browses Bonjour (LAN) as a convenience only
  - uses direct transport + pairing to connect to the gateway
