---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Bonjour/mDNS discovery + debugging (Gateway beacons, clients, and common failure modes)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging Bonjour discovery issues on macOS/iOS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing mDNS service types, TXT records, or discovery UX（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Bonjour Discovery"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bonjour / mDNS discovery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses Bonjour (mDNS / DNS‑SD) as a **LAN‑only convenience** to discover（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
an active Gateway (WebSocket endpoint). It is best‑effort and does **not** replace SSH or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tailnet-based connectivity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Wide‑area Bonjour (Unicast DNS‑SD) over Tailscale（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the node and gateway are on different networks, multicast mDNS won’t cross the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
boundary. You can keep the same discovery UX by switching to **unicast DNS‑SD**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
("Wide‑Area Bonjour") over Tailscale.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
High‑level steps:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Run a DNS server on the gateway host (reachable over Tailnet).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Publish DNS‑SD records for `_openclaw-gw._tcp` under a dedicated zone（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   (example: `openclaw.internal.`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Configure Tailscale **split DNS** so your chosen domain resolves via that（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   DNS server for clients (including iOS).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw supports any discovery domain; `openclaw.internal.` is just an example.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
iOS/Android nodes browse both `local.` and your configured wide‑area domain.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Gateway config (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### One‑time DNS server setup (gateway host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw dns setup --apply（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This installs CoreDNS and configures it to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- listen on port 53 only on the gateway’s Tailscale interfaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- serve your chosen domain (example: `openclaw.internal.`) from `~/.openclaw/dns/<domain>.db`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Validate from a tailnet‑connected machine:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
dns-sd -B _openclaw-gw._tcp openclaw.internal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tailscale DNS settings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In the Tailscale admin console:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add a nameserver pointing at the gateway’s tailnet IP (UDP/TCP 53).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add split DNS so your discovery domain uses that nameserver.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Once clients accept tailnet DNS, iOS nodes can browse（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`_openclaw-gw._tcp` in your discovery domain without multicast.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Gateway listener security (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway WS port (default `18789`) binds to loopback by default. For LAN/tailnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
access, bind explicitly and keep auth enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For tailnet‑only setups:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `gateway.bind: "tailnet"` in `~/.openclaw/openclaw.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Restart the Gateway (or restart the macOS menubar app).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What advertises（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Only the Gateway advertises `_openclaw-gw._tcp`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Service types（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `_openclaw-gw._tcp` — gateway transport beacon (used by macOS/iOS/Android nodes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## TXT keys (non‑secret hints)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway advertises small non‑secret hints to make UI flows convenient:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `role=gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `displayName=<friendly name>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `lanHost=<hostname>.local`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gatewayPort=<port>` (Gateway WS + HTTP)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gatewayTls=1` (only when TLS is enabled)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gatewayTlsSha256=<sha256>` (only when TLS is enabled and fingerprint is available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `canvasPort=<port>` (only when the canvas host is enabled; default `18793`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sshPort=<port>` (defaults to 22 when not overridden)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `transport=gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cliPath=<path>` (optional; absolute path to a runnable `openclaw` entrypoint)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tailnetDns=<magicdns>` (optional hint when Tailnet is available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Debugging on macOS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Useful built‑in tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browse instances:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  dns-sd -B _openclaw-gw._tcp local.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Resolve one instance (replace `<instance>`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  dns-sd -L "<instance>" _openclaw-gw._tcp local.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If browsing works but resolving fails, you’re usually hitting a LAN policy or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mDNS resolver issue.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Debugging in Gateway logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway writes a rolling log file (printed on startup as（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`gateway log file: ...`). Look for `bonjour:` lines, especially:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bonjour: advertise failed ...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bonjour: watchdog detected non-announced service ...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Debugging on iOS node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The iOS node uses `NWBrowser` to discover `_openclaw-gw._tcp`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To capture logs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Settings → Gateway → Advanced → **Discovery Debug Logs**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Settings → Gateway → Advanced → **Discovery Logs** → reproduce → **Copy**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The log includes browser state transitions and result‑set changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common failure modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Bonjour doesn’t cross networks**: use Tailnet or SSH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multicast blocked**: some Wi‑Fi networks disable mDNS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sleep / interface churn**: macOS may temporarily drop mDNS results; retry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Browse works but resolve fails**: keep machine names simple (avoid emojis or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  punctuation), then restart the Gateway. The service instance name derives from（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the host name, so overly complex names can confuse some resolvers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Escaped instance names (`\032`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bonjour/DNS‑SD often escapes bytes in service instance names as decimal `\DDD`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sequences (e.g. spaces become `\032`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- This is normal at the protocol level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UIs should decode for display (iOS uses `BonjourEscapes.decode`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Disabling / configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_DISABLE_BONJOUR=1` disables advertising (legacy: `OPENCLAW_DISABLE_BONJOUR`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.bind` in `~/.openclaw/openclaw.json` controls the Gateway bind mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_SSH_PORT` overrides the SSH port advertised in TXT (legacy: `OPENCLAW_SSH_PORT`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_TAILNET_DNS` publishes a MagicDNS hint in TXT (legacy: `OPENCLAW_TAILNET_DNS`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_CLI_PATH` overrides the advertised CLI path (legacy: `OPENCLAW_CLI_PATH`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discovery policy and transport selection: [Discovery](/gateway/discovery)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node pairing + approvals: [Gateway pairing](/gateway/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
