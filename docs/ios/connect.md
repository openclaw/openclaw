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
- Iris (iOS app) is on the same LAN (Bonjour/mDNS must work).
- You can run the CLI (`clawdis`) on the gateway machine (or via SSH).

## 1) Start the Gateway (with bridge enabled)

Bridge is enabled by default (disable via `CLAWDIS_BRIDGE_ENABLED=0`).

```bash
pnpm clawdis gateway --port 18789 --verbose
```

Confirm in logs you see something like:
- `bridge listening on tcp://0.0.0.0:18790 (Iris)`

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

## 3) Connect from Iris (iOS)

In Iris:
- Pick the discovered bridge (or hit refresh).
- If not paired yet, Iris will initiate pairing automatically.

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
- Via Gateway presence:
  ```bash
  clawdis gateway call system-presence --params "{}"
  ```
  Look for the node `instanceId` (commonly `ios-node` unless changed in Iris settings).

## 6) Drive the iOS Canvas (draw / snapshot)

Iris runs a WKWebView “Canvas” scaffold which exposes:
- `window.__clawdis.canvas`
- `window.__clawdis.ctx` (2D context)
- `window.__clawdis.setStatus(title, subtitle)`

### Draw with `screen.eval`

```bash
clawdis nodes invoke --node ios-node --command screen.eval --params "$(cat <<'JSON'
{"javaScript":"(() => { const {ctx,setStatus} = window.__clawdis; setStatus('Drawing','…'); ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle='#ff2d55'; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); setStatus(null,null); return 'ok'; })()"}
JSON
)"
```

### Snapshot with `screen.snapshot`

```bash
clawdis nodes invoke --node ios-node --command screen.snapshot --params '{"maxWidth":900}'
```

The response includes `base64` PNG data (for debugging/verification).

## Common gotchas

- **iOS in background:** all `screen.*` commands fail fast with `NODE_BACKGROUND_UNAVAILABLE` (bring Iris to foreground).
- **mDNS blocked:** some networks block multicast; use a different LAN or plan a tailnet-capable bridge (see `docs/discovery.md`).
- **Wrong node id:** `--node` must match the node’s `instanceId` (shown in Instances/presence).
- **Stale pairing:** if the token is lost, Iris must pair again; approve a new pending request.

## Related docs

- `docs/ios/spec.md` (design + architecture)
- `docs/gateway.md` (gateway runbook)
- `docs/gateway/pairing.md` (approval + storage)
- `docs/bonjour.md` (discovery debugging)
- `docs/discovery.md` (LAN vs tailnet vs SSH)
