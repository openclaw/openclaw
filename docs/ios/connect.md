---
summary: "Runbook: connect/pair the iOS node (Iris) to a Clawdis Gateway and drive its Canvas"
read_when:
  - Pairing or reconnecting the iOS node
  - Debugging iOS bridge discovery or auth
  - Sending screen/canvas commands to iOS
---

# iOS Node Connection Runbook (Iris)

This is the practical “how do I connect Iris” guide:

**iOS app** ⇄ (Bonjour + TCP bridge) ⇄ **Gateway bridge** ⇄ (loopback WS) ⇄ **Gateway**

The Gateway WebSocket stays loopback-only (`ws://127.0.0.1:18789`). Iris talks to the LAN-facing **bridge** (default `tcp://0.0.0.0:18790`) and uses Gateway-owned pairing.

## Prerequisites

- You can run the Gateway on the “master” machine.
- Iris (iOS app) can reach the gateway bridge:
  - Same LAN with Bonjour/mDNS, **or**
  - Same Tailscale tailnet using Wide-Area Bonjour / unicast DNS-SD (see below), **or**
  - Manual bridge host/port (fallback)
- You can run the CLI (`clawdis`) on the gateway machine (or via SSH).

## 1) Start the Gateway (with bridge enabled)

Bridge is enabled by default (disable via `CLAWDIS_BRIDGE_ENABLED=0`).

```bash
pnpm clawdis gateway --port 18789 --verbose
```

Confirm in logs you see something like:
- `bridge listening on tcp://0.0.0.0:18790 (Iris)`

For tailnet-only setups (recommended for Vienna ⇄ London), bind the bridge to the gateway machine’s Tailscale IP instead:

- Set `bridge.bind: "tailnet"` in `~/.clawdis/clawdis.json` on the gateway host.
- Restart the Gateway / macOS menubar app.

## 2) Verify Bonjour discovery (optional but recommended)

From the gateway machine:

```bash
dns-sd -B _clawdis-bridge._tcp local.
```

You should see your gateway advertising `_clawdis-bridge._tcp`.

If browse works, but Iris can’t connect, try resolving one instance:

```bash
dns-sd -L "<instance name>" _clawdis-bridge._tcp local.
```

More debugging notes: `docs/bonjour.md`.

### Tailnet (Vienna ⇄ London) discovery via unicast DNS-SD

If Iris and the gateway are on different networks but connected via Tailscale, multicast mDNS won’t cross the boundary. Use Wide-Area Bonjour / unicast DNS-SD instead:

1) Set up a DNS-SD zone (example `clawdis.internal.`) on the gateway host and publish `_clawdis-bridge._tcp` records.
2) Configure Tailscale split DNS for `clawdis.internal` pointing at that DNS server.

Details and example CoreDNS config: `docs/bonjour.md`.

## 3) Connect from Iris (iOS)

In Iris:
- Pick the discovered bridge (or hit refresh).
- If not paired yet, Iris will initiate pairing automatically.
- After the first successful pairing, Iris will auto-reconnect **strictly to the last discovered gateway** on launch (including after reinstall), as long as the iOS Keychain entry is still present.

### Connection indicator (always visible)

The Settings tab icon shows a small status dot:
- **Green**: connected to the bridge
- **Yellow**: connecting (subtle pulse)
- **Red**: not connected / error

## 4) Approve pairing (CLI)

On the gateway machine:

```bash
clawdis nodes pending
```

Approve the request:

```bash
clawdis nodes approve <requestId>
```

After approval, Iris receives/stores the token and reconnects authenticated.

Pairing details: `docs/gateway/pairing.md`.

## 5) Verify the node is connected

- In the macOS app: **Instances** tab should show something like `iOS Node (...)`.
- Via nodes list (paired + connected):
  ```bash
  clawdis nodes list
  ```
- Via Gateway (paired + connected):
  ```bash
  clawdis gateway call node.list --params "{}"
  ```
- Via Gateway presence (legacy-ish, still useful):
  ```bash
  clawdis gateway call system-presence --params "{}"
  ```
  Look for the node `instanceId` (often a UUID).

## 6) Drive the iOS Canvas (draw / snapshot)

Iris runs a WKWebView “Canvas” scaffold which exposes:
- `window.__clawdis.canvas`
- `window.__clawdis.ctx` (2D context)
- `window.__clawdis.setStatus(title, subtitle)`

### Draw with `screen.eval`

```bash
clawdis nodes invoke --node "iOS Node" --command screen.eval --params "$(cat <<'JSON'
{"javaScript":"(() => { const {ctx,setStatus} = window.__clawdis; setStatus('Drawing','…'); ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle='#ff2d55'; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); setStatus(null,null); return 'ok'; })()"}
JSON
)"
```

### Snapshot with `screen.snapshot`

```bash
clawdis nodes invoke --node 192.168.0.88 --command screen.snapshot --params '{"maxWidth":900}'
```

The response includes `base64` PNG data (for debugging/verification).

## Common gotchas

- **iOS in background:** all `screen.*` commands fail fast with `NODE_BACKGROUND_UNAVAILABLE` (bring Iris to foreground).
- **mDNS blocked:** some networks block multicast; use a different LAN or plan a tailnet-capable bridge (see `docs/discovery.md`).
- **Wrong node selector:** `--node` can be the node id (UUID), display name (e.g. `iOS Node`), IP, or an unambiguous prefix. If it’s ambiguous, the CLI will tell you.
- **Stale pairing / Keychain cleared:** if the pairing token is missing (or iOS Keychain was wiped), Iris must pair again; approve a new pending request.
- **App reinstall but no reconnect:** Iris restores `instanceId` + last bridge preference from Keychain; if it still comes up “unpaired”, verify Keychain persistence on your device/simulator and re-pair once.

## Related docs

- `docs/ios/spec.md` (design + architecture)
- `docs/gateway.md` (gateway runbook)
- `docs/gateway/pairing.md` (approval + storage)
- `docs/bonjour.md` (discovery debugging)
- `docs/discovery.md` (LAN vs tailnet vs SSH)
