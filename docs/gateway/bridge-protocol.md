---
summary: "Bridge protocol (nodes): TCP JSONL, pairing, scoped RPC"
read_when:
  - Building or debugging node clients (iOS/Android/macOS node mode)
  - Investigating pairing or bridge auth failures
  - Auditing the node surface exposed by the gateway
---

# Bridge protocol (Node transport)

The Bridge protocol is a **narrow, authenticated** transport for nodes
(iOS/Android/macOS node mode). It keeps the Gateway WS control plane loopback‑only
and exposes only a scoped set of methods for nodes.

If you are building an operator client (CLI, web UI, automations), use the
[Gateway protocol](/gateway/protocol).

## Why we have both

- **Security boundary**: the bridge exposes a small allowlist instead of the
  full gateway API surface.
- **Pairing + node identity**: node admission is owned by the gateway and tied
  to a per-node token.
- **Discovery UX**: nodes can discover gateways via Bonjour on LAN, or connect
  directly over a tailnet.
- **Loopback WS**: the full WS control plane stays local unless tunneled via SSH.

## Transport

- TCP, one JSON object per line (JSONL).
- Gateway owns the listener (default `18790`).

## Handshake + pairing

1) Client sends `hello` with node metadata + token (if already paired).  
2) If not paired, gateway replies `error` (`NOT_PAIRED`/`UNAUTHORIZED`).  
3) Client sends `pair-request`.  
4) Gateway waits for approval, then sends `pair-ok` and `hello-ok`.

`hello-ok` returns `serverName` and may include `canvasHostUrl`.

## Frames

Client → Gateway:
- `req` / `res`: scoped gateway RPC (chat, sessions, config, health, voicewake)
- `event`: node signals (voice transcript, agent request, chat subscribe)

Gateway → Client:
- `invoke` / `invoke-res`: node commands (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: chat updates for subscribed sessions
- `ping` / `pong`: keepalive

Exact allowlist is enforced in `src/gateway/server-bridge.ts`.

## Tailnet usage

- Bind the bridge to a tailnet IP: `bridge.bind: "tailnet"` in
  `~/.clawdbot/clawdbot.json`.
- Clients connect via MagicDNS name or tailnet IP.
- Bonjour does **not** cross networks; use manual host/port or wide-area DNS‑SD
  when needed.

## Versioning

Bridge is currently **implicit v1** (no min/max negotiation). Backward‑compat
is expected; add a bridge protocol version field before any breaking changes.
