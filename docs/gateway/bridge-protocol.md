---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Bridge protocol (legacy nodes): TCP JSONL, pairing, scoped RPC"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Building or debugging node clients (iOS/Android/macOS node mode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Investigating pairing or bridge auth failures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Auditing the node surface exposed by the gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Bridge Protocol"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bridge protocol (legacy node transport)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Bridge protocol is a **legacy** node transport (TCP JSONL). New node clients（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
should use the unified Gateway WebSocket protocol instead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you are building an operator or node client, use the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Gateway protocol](/gateway/protocol).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** Current OpenClaw builds no longer ship the TCP bridge listener; this document is kept for historical reference.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy `bridge.*` config keys are no longer part of the config schema.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why we have both（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Security boundary**: the bridge exposes a small allowlist instead of the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  full gateway API surface.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Pairing + node identity**: node admission is owned by the gateway and tied（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  to a per-node token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Discovery UX**: nodes can discover gateways via Bonjour on LAN, or connect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  directly over a tailnet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Loopback WS**: the full WS control plane stays local unless tunneled via SSH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Transport（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TCP, one JSON object per line (JSONL).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional TLS (when `bridge.tls.enabled` is true).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Legacy default listener port was `18790` (current builds do not start a TCP bridge).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When TLS is enabled, discovery TXT records include `bridgeTls=1` plus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`bridgeTlsSha256` so nodes can pin the certificate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Handshake + pairing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Client sends `hello` with node metadata + token (if already paired).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. If not paired, gateway replies `error` (`NOT_PAIRED`/`UNAUTHORIZED`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Client sends `pair-request`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Gateway waits for approval, then sends `pair-ok` and `hello-ok`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`hello-ok` returns `serverName` and may include `canvasHostUrl`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Frames（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Client → Gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `req` / `res`: scoped gateway RPC (chat, sessions, config, health, voicewake, skills.bins)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `event`: node signals (voice transcript, agent request, chat subscribe, exec lifecycle)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway → Client:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `invoke` / `invoke-res`: node commands (`canvas.*`, `camera.*`, `screen.record`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `location.get`, `sms.send`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `event`: chat updates for subscribed sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ping` / `pong`: keepalive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy allowlist enforcement lived in `src/gateway/server-bridge.ts` (removed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Exec lifecycle events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Nodes can emit `exec.finished` or `exec.denied` events to surface system.run activity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are mapped to system events in the gateway. (Legacy nodes may still emit `exec.started`.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Payload fields (all optional unless noted):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionKey` (required): agent session to receive the system event.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `runId`: unique exec id for grouping.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `command`: raw or formatted command string.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `exitCode`, `timedOut`, `success`, `output`: completion details (finished only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `reason`: denial reason (denied only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tailnet usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bind the bridge to a tailnet IP: `bridge.bind: "tailnet"` in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `~/.openclaw/openclaw.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clients connect via MagicDNS name or tailnet IP.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bonjour does **not** cross networks; use manual host/port or wide-area DNS‑SD（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  when needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Versioning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bridge is currently **implicit v1** (no min/max negotiation). Backward‑compat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
is expected; add a bridge protocol version field before any breaking changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
