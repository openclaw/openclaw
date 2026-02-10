---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Node discovery and transports (Bonjour, Tailscale, SSH) for finding the gateway"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Implementing or changing Bonjour discovery/advertising（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adjusting remote connection modes (direct vs SSH)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Designing node discovery + pairing for remote nodes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Discovery and Transports"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Discovery & transports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw has two distinct problems that look similar on the surface:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Operator remote control**: the macOS menu bar app controlling a gateway running elsewhere.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Node pairing**: iOS/Android (and future nodes) finding a gateway and pairing securely.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The design goal is to keep all network discovery/advertising in the **Node Gateway** (`openclaw gateway`) and keep clients (mac app, iOS) as consumers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Terms（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gateway**: a single long-running gateway process that owns state (sessions, pairing, node registry) and runs channels. Most setups use one per host; isolated multi-gateway setups are possible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gateway WS (control plane)**: the WebSocket endpoint on `127.0.0.1:18789` by default; can be bound to LAN/tailnet via `gateway.bind`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Direct WS transport**: a LAN/tailnet-facing Gateway WS endpoint (no SSH).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **SSH transport (fallback)**: remote control by forwarding `127.0.0.1:18789` over SSH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Legacy TCP bridge (deprecated/removed)**: older node transport (see [Bridge protocol](/gateway/bridge-protocol)); no longer advertised for discovery.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Protocol details:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway protocol](/gateway/protocol)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Bridge protocol (legacy)](/gateway/bridge-protocol)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why we keep both “direct” and SSH（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Direct WS** is the best UX on the same network and within a tailnet:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - auto-discovery on LAN via Bonjour（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - pairing tokens + ACLs owned by the gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - no shell access required; protocol surface can stay tight and auditable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **SSH** remains the universal fallback:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - works anywhere you have SSH access (even across unrelated networks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - survives multicast/mDNS issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - requires no new inbound ports besides SSH（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Discovery inputs (how clients learn where the gateway is)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Bonjour / mDNS (LAN only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bonjour is best-effort and does not cross networks. It is only used for “same LAN” convenience.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Target direction:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The **gateway** advertises its WS endpoint via Bonjour.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clients browse and show a “pick a gateway” list, then store the chosen endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Troubleshooting and beacon details: [Bonjour](/gateway/bonjour).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Service beacon details（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Service types:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `_openclaw-gw._tcp` (gateway transport beacon)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TXT keys (non-secret):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `role=gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `lanHost=<hostname>.local`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `sshPort=22` (or whatever is advertised)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `gatewayPort=18789` (Gateway WS + HTTP)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `gatewayTls=1` (only when TLS is enabled)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `gatewayTlsSha256=<sha256>` (only when TLS is enabled and fingerprint is available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `canvasPort=18793` (default canvas host port; serves `/__openclaw__/canvas/`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `cliPath=<path>` (optional; absolute path to a runnable `openclaw` entrypoint or binary)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `tailnetDns=<magicdns>` (optional hint; auto-detected when Tailscale is available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Disable/override:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_DISABLE_BONJOUR=1` disables advertising.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.bind` in `~/.openclaw/openclaw.json` controls the Gateway bind mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_SSH_PORT` overrides the SSH port advertised in TXT (defaults to 22).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_TAILNET_DNS` publishes a `tailnetDns` hint (MagicDNS).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_CLI_PATH` overrides the advertised CLI path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Tailnet (cross-network)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For London/Vienna style setups, Bonjour won’t help. The recommended “direct” target is:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tailscale MagicDNS name (preferred) or a stable tailnet IP.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the gateway can detect it is running under Tailscale, it publishes `tailnetDns` as an optional hint for clients (including wide-area beacons).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) Manual / SSH target（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When there is no direct route (or direct is disabled), clients can always connect via SSH by forwarding the loopback gateway port.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Remote access](/gateway/remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Transport selection (client policy)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommended client behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. If a paired direct endpoint is configured and reachable, use it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Else, if Bonjour finds a gateway on LAN, offer a one-tap “Use this gateway” choice and save it as the direct endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Else, if a tailnet DNS/IP is configured, try direct.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Else, fall back to SSH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pairing + auth (direct transport)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The gateway is the source of truth for node/client admission.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing requests are created/approved/rejected in the gateway (see [Gateway pairing](/gateway/pairing)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The gateway enforces:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - auth (token / keypair)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - scopes/ACLs (the gateway is not a raw proxy to every method)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - rate limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Responsibilities by component（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gateway**: advertises discovery beacons, owns pairing decisions, and hosts the WS endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **macOS app**: helps you pick a gateway, shows pairing prompts, and uses SSH only as a fallback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **iOS/Android nodes**: browse Bonjour as a convenience and connect to the paired Gateway WS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
