---
summary: "Bonjour/mDNS discovery + debugging (Gateway beacons, clients, and common failure modes)"
read_when:
  - Debugging Bonjour discovery issues on macOS/iOS
  - Changing mDNS service types, TXT records, or discovery UX
---
# Bonjour / mDNS discovery

DNA uses Bonjour (mDNS / DNS‑SD) as a **LAN‑only convenience** to discover
an active Gateway (WebSocket endpoint). It is best‑effort and does **not** replace SSH or
Tailnet-based connectivity.

## Wide‑area Bonjour (Unicast DNS‑SD) over Tailscale

If the node and gateway are on different networks, multicast mDNS won’t cross the
boundary. You can keep the same discovery UX by switching to **unicast DNS‑SD**
("Wide‑Area Bonjour") over Tailscale.

High‑level steps:

1) Run a DNS server on the gateway host (reachable over Tailnet).
2) Publish DNS‑SD records for `_dna-gw._tcp` under a dedicated zone
   (example: `dna.internal.`).
3) Configure Tailscale **split DNS** so `dna.internal` resolves via that
   DNS server for clients (including iOS).

DNA standardizes on `dna.internal.` for this mode. iOS/Android nodes
browse both `local.` and `dna.internal.` automatically.

### Gateway config (recommended)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } } // enables dna.internal DNS-SD publishing
}
```

### One‑time DNS server setup (gateway host)

```bash
dna dns setup --apply
```

This installs CoreDNS and configures it to:
- listen on port 53 only on the gateway’s Tailscale interfaces
- serve `dna.internal.` from `~/.dna/dns/dna.internal.db`

Validate from a tailnet‑connected machine:

```bash
dns-sd -B _dna-gw._tcp dna.internal.
dig @<TAILNET_IPV4> -p 53 _dna-gw._tcp.dna.internal PTR +short
```

### Tailscale DNS settings

In the Tailscale admin console:

- Add a nameserver pointing at the gateway’s tailnet IP (UDP/TCP 53).
- Add split DNS so the domain `dna.internal` uses that nameserver.

Once clients accept tailnet DNS, iOS nodes can browse
`_dna-gw._tcp` in `dna.internal.` without multicast.

### Gateway listener security (recommended)

The Gateway WS port (default `18789`) binds to loopback by default. For LAN/tailnet
access, bind explicitly and keep auth enabled.

For tailnet‑only setups:
- Set `gateway.bind: "tailnet"` in `~/.dna/dna.json`.
- Restart the Gateway (or restart the macOS menubar app).

## What advertises

Only the Gateway advertises `_dna-gw._tcp`.

## Service types

- `_dna-gw._tcp` — gateway transport beacon (used by macOS/iOS/Android nodes).

## TXT keys (non‑secret hints)

The Gateway advertises small non‑secret hints to make UI flows convenient:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (only when TLS is enabled)
- `gatewayTlsSha256=<sha256>` (only when TLS is enabled and fingerprint is available)
- `canvasPort=<port>` (only when the canvas host is enabled; default `18793`)
- `sshPort=<port>` (defaults to 22 when not overridden)
- `transport=gateway`
- `cliPath=<path>` (optional; absolute path to a runnable `dna` entrypoint)
- `tailnetDns=<magicdns>` (optional hint when Tailnet is available)

## Debugging on macOS

Useful built‑in tools:

- Browse instances:
  ```bash
  dns-sd -B _dna-gw._tcp local.
  ```
- Resolve one instance (replace `<instance>`):
  ```bash
  dns-sd -L "<instance>" _dna-gw._tcp local.
  ```

If browsing works but resolving fails, you’re usually hitting a LAN policy or
mDNS resolver issue.

## Debugging in Gateway logs

The Gateway writes a rolling log file (printed on startup as
`gateway log file: ...`). Look for `bonjour:` lines, especially:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Debugging on iOS node

The iOS node uses `NWBrowser` to discover `_dna-gw._tcp`.

To capture logs:
- Settings → Gateway → Advanced → **Discovery Debug Logs**
- Settings → Gateway → Advanced → **Discovery Logs** → reproduce → **Copy**

The log includes browser state transitions and result‑set changes.

## Common failure modes

- **Bonjour doesn’t cross networks**: use Tailnet or SSH.
- **Multicast blocked**: some Wi‑Fi networks disable mDNS.
- **Sleep / interface churn**: macOS may temporarily drop mDNS results; retry.
- **Browse works but resolve fails**: keep machine names simple (avoid emojis or
  punctuation), then restart the Gateway. The service instance name derives from
  the host name, so overly complex names can confuse some resolvers.

## Escaped instance names (`\032`)

Bonjour/DNS‑SD often escapes bytes in service instance names as decimal `\DDD`
sequences (e.g. spaces become `\032`).

- This is normal at the protocol level.
- UIs should decode for display (iOS uses `BonjourEscapes.decode`).

## Disabling / configuration

- `DNA_DISABLE_BONJOUR=1` disables advertising.
- `gateway.bind` in `~/.dna/dna.json` controls the Gateway bind mode.
- `DNA_SSH_PORT` overrides the SSH port advertised in TXT.
- `DNA_TAILNET_DNS` publishes a MagicDNS hint in TXT.
- `DNA_CLI_PATH` overrides the advertised CLI path.

## Related docs

- Discovery policy and transport selection: [Discovery](/gateway/discovery)
- Node pairing + approvals: [Gateway pairing](/gateway/pairing)
