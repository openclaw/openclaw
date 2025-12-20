---
summary: "Runbook: connect/pair the iOS node to a Clawdis Gateway and drive its Canvas"
read_when:
  - Pairing or reconnecting the iOS node
  - Debugging iOS bridge discovery or auth
  - Sending screen/canvas commands to iOS
---

# iOS Node Connection Runbook

This is the practical “how do I connect the iOS node” guide:

**iOS app** ⇄ (Bonjour + TCP bridge) ⇄ **Gateway bridge** ⇄ (loopback WS) ⇄ **Gateway**

The Gateway WebSocket stays loopback-only (`ws://127.0.0.1:18789`). The iOS node talks to the LAN-facing **bridge** (default `tcp://0.0.0.0:18790`) and uses Gateway-owned pairing.

## Prerequisites

- You can run the Gateway on the “master” machine.
- iOS node app can reach the gateway bridge:
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
- `bridge listening on tcp://0.0.0.0:18790 (node)`

For tailnet-only setups (recommended for Vienna ⇄ London), bind the bridge to the gateway machine’s Tailscale IP instead:

- Set `bridge.bind: "tailnet"` in `~/.clawdis/clawdis.json` on the gateway host.
- Restart the Gateway / macOS menubar app.

## 2) Verify Bonjour discovery (optional but recommended)

From the gateway machine:

```bash
dns-sd -B _clawdis-bridge._tcp local.
```

You should see your gateway advertising `_clawdis-bridge._tcp`.

If browse works, but the iOS node can’t connect, try resolving one instance:

```bash
dns-sd -L "<instance name>" _clawdis-bridge._tcp local.
```

More debugging notes: `docs/bonjour.md`.

### Tailnet (Vienna ⇄ London) discovery via unicast DNS-SD

If the iOS node and the gateway are on different networks but connected via Tailscale, multicast mDNS won’t cross the boundary. Use Wide-Area Bonjour / unicast DNS-SD instead:

1) Set up a DNS-SD zone (example `clawdis.internal.`) on the gateway host and publish `_clawdis-bridge._tcp` records.
2) Configure Tailscale split DNS for `clawdis.internal` pointing at that DNS server.

Details and example CoreDNS config: `docs/bonjour.md`.

## 3) Connect from the iOS node app

In the iOS node app:
- Pick the discovered bridge (or hit refresh).
- If not paired yet, it will initiate pairing automatically.
- After the first successful pairing, it will auto-reconnect **strictly to the last discovered gateway** on launch (including after reinstall), as long as the iOS Keychain entry is still present.

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

After approval, the iOS node receives/stores the token and reconnects authenticated.

Pairing details: `docs/gateway/pairing.md`.

## 5) Verify the node is connected

- In the macOS app: **Instances** tab should show something like `iOS Node (...)`.
- Via nodes status (paired + connected):
  ```bash
  clawdis nodes status
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

The iOS node runs a WKWebView “Canvas” scaffold which exposes:
- `window.__clawdis.canvas`
- `window.__clawdis.ctx` (2D context)
- `window.__clawdis.setStatus(title, subtitle)`

### Gateway Canvas Host (recommended for web content)

If you want the node to show real HTML/CSS/JS that the agent can edit on disk, point it at the Gateway canvas host.

Note: the Gateway must be bound to a LAN/tailnet interface (`gateway.bind=lan|tailnet`) so the node can reach `:18789`.

1) Create `~/clawd/canvas/index.html` on the gateway host.

2) Navigate the node to it (LAN):

```bash
clawdis nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18789/__clawdis__/canvas/"}'
```

Notes:
- The server injects a live-reload client into HTML and reloads on file changes.
- A2UI is hosted on the same canvas host at `http://<gateway-host>:18789/__clawdis__/a2ui/`.
- Tailnet (optional): if both devices are on Tailscale, use a MagicDNS name or tailnet IP instead of `.local`, e.g. `http://<gateway-magicdns>:18789/__clawdis__/canvas/`.
- iOS may require App Transport Security allowances to load plain `http://` URLs; if it fails to load, prefer HTTPS or adjust the iOS app’s ATS config.

### Draw with `canvas.eval`

```bash
clawdis nodes invoke --node "iOS Node" --command canvas.eval --params "$(cat <<'JSON'
{"javaScript":"(() => { const {ctx,setStatus} = window.__clawdis; setStatus('Drawing','…'); ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle='#ff2d55'; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); setStatus(null,null); return 'ok'; })()"}
JSON
)"
```

### Snapshot with `canvas.snapshot`

```bash
clawdis nodes invoke --node 192.168.0.88 --command canvas.snapshot --params '{"maxWidth":900}'
```

The response includes `{ format, base64 }` image data (default `format="jpeg"`; pass `{"format":"png"}` when you specifically need lossless PNG).

## Common gotchas

- **iOS in background:** all `canvas.*` commands fail fast with `NODE_BACKGROUND_UNAVAILABLE` (bring the iOS node app to foreground).
- **Return to default scaffold:** `canvas.navigate` with `{"url":""}` or `{"url":"/"}` returns to the built-in scaffold page.
- **mDNS blocked:** some networks block multicast; use a different LAN or plan a tailnet-capable bridge (see `docs/discovery.md`).
- **Wrong node selector:** `--node` can be the node id (UUID), display name (e.g. `iOS Node`), IP, or an unambiguous prefix. If it’s ambiguous, the CLI will tell you.
- **Stale pairing / Keychain cleared:** if the pairing token is missing (or iOS Keychain was wiped), the node must pair again; approve a new pending request.
- **App reinstall but no reconnect:** the node restores `instanceId` + last bridge preference from Keychain; if it still comes up “unpaired”, verify Keychain persistence on your device/simulator and re-pair once.

## Related docs

- `docs/ios/spec.md` (design + architecture)
- `docs/gateway.md` (gateway runbook)
- `docs/gateway/pairing.md` (approval + storage)
- `docs/bonjour.md` (discovery debugging)
- `docs/discovery.md` (LAN vs tailnet vs SSH)
