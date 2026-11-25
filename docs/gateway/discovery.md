---
summary: "Node discovery and transports (Bonjour, Tailscale, SSH) for finding the Gateway"
read_when:
  - Implementing or changing Bonjour discovery/advertising
  - Adjusting remote connection modes (direct vs SSH)
  - Designing node discovery + pairing for remote nodes
title: "Discovery and transports"
---

OpenClaw has two related but distinct discovery problems:

1. **Operator remote control**: the macOS menu bar app controlling a Gateway running elsewhere.
2. **Node pairing**: iOS/Android (and future nodes) finding a Gateway and pairing securely.

All network discovery/advertising lives in the **Gateway**
(`openclaw gateway`); clients (mac app, iOS) are consumers only.

## Terms

- **Gateway**: a single long-running process that owns state (sessions,
  pairing, node registry) and runs channels. Most setups use one per host;
  isolated multi-gateway setups are possible.
- **Gateway WS (control plane)**: the WebSocket endpoint on `127.0.0.1:18789`
  by default; bind it to LAN/tailnet via `gateway.bind`.
- **Direct WS transport**: a LAN/tailnet-facing Gateway WS endpoint (no SSH).
- **SSH transport (fallback)**: remote control by forwarding
  `127.0.0.1:18789` over SSH.

Protocol details: [Gateway protocol](/gateway/protocol).

## Why direct and SSH both exist

- **Direct WS** is the best UX on the same network and within a tailnet: LAN
  auto-discovery via Bonjour, pairing tokens and ACLs owned by the Gateway,
  and no shell access required.
- **SSH** is the universal fallback: works anywhere you have SSH access, even
  across unrelated networks, survives multicast/mDNS issues, and needs no new
  inbound port besides SSH.

## Discovery inputs

### 1) Bonjour / DNS-SD

Multicast Bonjour is best-effort and does not cross networks. OpenClaw also
supports browsing the same Gateway beacon via a configured wide-area DNS-SD
domain, so discovery can cover both `local.` on the same LAN and a configured
unicast DNS-SD domain for cross-network discovery.

The **Gateway** advertises its WS endpoint via Bonjour when the bundled
`bonjour` plugin is enabled; clients browse and show a "pick a Gateway" list,
then apply their connection trust policy. On macOS, a selection opens the
connection editor; it does not save the advertised endpoint. See
[Configure in the app](/platforms/mac/remote#configure-in-the-app).

Troubleshooting and beacon details: [Bonjour](/gateway/bonjour).

#### Service beacon details

- Service type: `_openclaw-gw._tcp` (Gateway transport beacon).
- TXT keys (non-secret):

  | Key                         | Notes                                                                                                                                                            |
  | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `role=gateway`              | Always present.                                                                                                                                                  |
  | `transport=gateway`         | Always present.                                                                                                                                                  |
  | `displayName=<name>`        | Operator-configured display name.                                                                                                                                |
  | `lanHost=<hostname>.local`  | LAN mDNS advertiser only; not written by wide-area DNS-SD.                                                                                                       |
  | `gatewayPort=18789`         | Gateway WS + HTTP port.                                                                                                                                          |
  | `gatewayTls=1`              | Only when TLS is enabled.                                                                                                                                        |
  | `gatewayTlsSha256=<sha256>` | Only when TLS is enabled and a fingerprint is available.                                                                                                         |
  | `tailnetDns=<magicdns>`     | Optional hint; auto-detected when Tailscale is available.                                                                                                        |
  | `sshPort=<port>`            | Present only when `discovery.mdns.mode="full"`; omitted (SSH defaults to `22`) in the default `"minimal"` mode, on both the LAN advertiser and wide-area DNS-SD. |
  | `cliPath=<path>`            | Same `discovery.mdns.mode="full"` gate as `sshPort`; a remote-install hint for the CLI path.                                                                     |

Security notes:

- Bonjour/mDNS TXT records are **unauthenticated**. Clients must treat TXT
  values as UX hints only.
- Routing (host/port) should prefer the **resolved service endpoint**
  (SRV + A/AAAA) over TXT-provided `lanHost`, `tailnetDns`, or `gatewayPort`.
- TLS pinning must never let an advertised `gatewayTlsSha256` override a
  previously stored pin.
- iOS/Android nodes should require an explicit "trust this fingerprint"
  confirmation before storing a first-time pin (out-of-band verification)
  whenever the chosen route is secure/TLS-based.

Enable, disable, and override:

- `openclaw plugins enable bonjour` enables LAN multicast advertising.
- `discovery.mdns.mode` in `openclaw.json` controls mDNS broadcast:
  `"minimal"` (default), `"full"` (adds `cliPath`/`sshPort` to both the LAN
  beacon and any wide-area DNS-SD zone), or `"off"` (disables mDNS).
- `OPENCLAW_DISABLE_BONJOUR=1` force-disables advertising; `discovery.mdns.mode="off"`
  disables it independently. `OPENCLAW_DISABLE_BONJOUR=0` is an explicit
  opt-in that overrides the plugin's auto-disable inside a detected container
  (Docker, containerd, Kubernetes, LXC); it does not override
  `discovery.mdns.mode="off"`. The bundled `bonjour` plugin auto-starts on
  macOS hosts (`enabledByDefaultOnPlatforms: ["darwin"]`) and auto-disables
  inside detected containers; Linux, Windows, and other containerized
  deployments need explicit `plugins enable bonjour`.
- `gateway.bind` in `~/.openclaw/openclaw.json` controls the Gateway bind mode.
- `OPENCLAW_SSH_PORT` overrides the advertised SSH port (only takes effect
  when `discovery.mdns.mode="full"`).
- `OPENCLAW_TAILNET_DNS` publishes a `tailnetDns` hint (MagicDNS).
- `OPENCLAW_CLI_PATH` overrides the advertised CLI path.

### 2) Tailnet (cross-network)

For Gateways on different physical networks, Bonjour will not help. The
recommended direct target is a Tailscale MagicDNS name (preferred) or a
stable tailnet IP.

If the Gateway detects it is running under Tailscale, it publishes
`tailnetDns` as an optional hint for clients (including wide-area beacons).
For a configured macOS connection, prefer a trusted MagicDNS name over a raw
Tailscale IP so the name resolves to the current address. Discovery does not
replace the saved address.

For mobile node pairing, discovery hints never relax transport security on
tailnet/public routes:

- iOS/Android still require a secure first-time tailnet/public connect path
  (`wss://` or Tailscale Serve/Funnel).
- A discovered raw tailnet IP is a routing hint, not permission to use
  plaintext remote `ws://`.
- Private LAN direct-connect `ws://` remains supported.
- For the simplest Tailscale path on mobile nodes, use Tailscale Serve so
  discovery and setup both resolve to the same secure MagicDNS endpoint.

### 3) Manual / SSH target

When there is no direct route (or direct is disabled), clients can always
connect via SSH by forwarding the loopback Gateway port. See
[Remote access](/gateway/remote).

## Transport selection (client policy)

The macOS app uses its configured direct or SSH transport. Discovery does not
replace that route or select a fallback. For a new connection, the user supplies
a trusted address, SSH target, or setup code in the connection editor and saves it.

Discovery-based client selection follows this policy:

1. If a paired direct endpoint is configured and reachable, use it.
2. Else, if discovery finds a Gateway on `local.` or the configured wide-area
   domain, offer setup for that candidate. Apply the client's trust policy
   before saving a direct endpoint; discovery alone is not authorization.
3. Else, if a tailnet DNS/IP is configured, try direct. For mobile nodes on
   tailnet/public routes, direct means a secure endpoint, not plaintext
   remote `ws://`.
4. Else, fall back to SSH.

## Pairing and auth (direct transport)

The Gateway is the source of truth for node/client admission:

- Pairing requests are created/approved/rejected in the Gateway (see
  [Gateway pairing](/gateway/pairing)).
- The Gateway enforces auth (token/keypair), scopes/ACLs (it is not a raw
  proxy to every method), and rate limits.

## Responsibilities by component

- **Gateway**: advertises discovery beacons, owns pairing decisions, hosts
  the WS endpoint.
- **macOS app**: edits trusted Gateway connections, shows pairing prompts,
  and uses the configured direct or SSH transport.
- **iOS/Android nodes**: browse Bonjour as a convenience, connect to the
  paired Gateway WS.

## Related

- [Remote access](/gateway/remote)
- [Tailscale](/gateway/tailscale)
- [Bonjour discovery](/gateway/bonjour)
