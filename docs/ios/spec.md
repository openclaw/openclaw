---
summary: "Plan for an iOS voice + canvas node that connects via a secure Bonjour-discovered macOS bridge"
read_when:
  - Designing iOS node + gateway integration
  - Extending the Gateway protocol for node/canvas commands
  - Implementing Bonjour pairing or transport security
---
# iOS Node (internal) — Voice Trigger + Canvas

Status: prototype implemented (internal) · Date: 2025-12-13

Runbook (how to connect/pair + drive Canvas): `docs/ios/connect.md`

## Goals
- Build an **iOS app** that acts as a **remote node** for Clawdis:
  - **Voice trigger** (wake-word / always-listening intent) that forwards transcripts to the Gateway `agent` method.
  - **Canvas** surface that the agent can control: navigate, draw/render, evaluate JS, snapshot.
- **Dead-simple setup**:
  - Auto-discover the host on the local network via **Bonjour**.
  - One-tap pairing with an approval prompt on the Mac.
  - iOS is **never** a local gateway; it is always a remote node.
- Operational clarity:
  - When iOS is backgrounded, voice may still run; **canvas commands must fail fast** with a structured error.
  - Provide **settings**: node display name, enable/disable voice wake, pairing status.

Non-goals (v1):
- Exposing the Node Gateway directly on the LAN.
- Supporting arbitrary third-party “plugins” on iOS.
- Perfect App Store compliance; this is **internal-only** initially.

## Current repo reality (constraints we respect)
- The Gateway WebSocket server binds to `127.0.0.1:18789` (`src/gateway/server.ts`) with an optional `CLAWDIS_GATEWAY_TOKEN`.
- The Gateway exposes a Canvas file server (`canvasHost`) on the **same port** as the Gateway, so nodes can `canvas.navigate` to `http://<lanHost>:18789/__clawdis__/canvas/` and auto-reload on file changes (`docs/configuration.md`).
- macOS “Canvas” is controlled via the Gateway node protocol (`canvas.*`), matching iOS/Android (`docs/mac/canvas.md`).
- Voice wake forwards via `GatewayChannel` to Gateway `agent` (mac app: `VoiceWakeForwarder` → `GatewayConnection.sendAgent`).

## Recommended topology (B): Gateway-owned Bridge + loopback Gateway
Keep the Node gateway loopback-only; expose a dedicated **gateway-owned bridge** to the LAN/tailnet.

**iOS App** ⇄ (TLS + pairing) ⇄ **Bridge (in gateway)** ⇄ (loopback) ⇄ **Gateway WS** (`ws://127.0.0.1:18789`)

Why:
- Preserves current threat model: Gateway remains local-only.
- Centralizes auth, rate limiting, and allowlisting in the bridge.
- Lets us unify “canvas node” semantics across mac + iOS without exposing raw gateway methods.

## Security plan (internal, but still robust)
### Transport
- **Current (v0):** bridge is a LAN-facing **TCP** listener with token-based auth after pairing.
- **Next:** wrap the bridge in **TLS** and prefer key-pinned or mTLS-like auth after pairing.

### Pairing
- Bonjour discovery shows a candidate “Clawdis Bridge” on the LAN.
- First connection:
  1) iOS generates a keypair (Secure Enclave if available).
  2) iOS connects to the bridge and requests pairing.
  3) The bridge forwards the pairing request to the **Gateway** as a *pending request*.
  4) Approval can happen via:
     - **macOS UI** (Clawdis shows an alert with Approve/Reject/Later, including the node IP), or
     - **Terminal/CLI** (headless flows).
  5) Once approved, the bridge returns a token to iOS; iOS stores it in Keychain.
- Subsequent connections:
  - The bridge requires the paired identity. Unpaired clients get a structured “not paired” error and no access.

#### Gateway-owned pairing (Option B details)
Pairing decisions must be owned by the Gateway (`clawd` / Node) so nodes can be approved without the macOS app running.

Key idea:
- The Swift app may still show an alert, but it is only a **frontend** for pending requests stored in the Gateway.

Desired behavior:
- If the Swift UI is present: show alert with Approve/Reject/Later.
- If the Swift UI is not present: `clawdis` CLI can list pending requests and approve/reject.

See `docs/gateway/pairing.md` for the API/events and storage.

CLI (headless approvals):
- `clawdis nodes pending`
- `clawdis nodes approve <requestId>`
- `clawdis nodes reject <requestId>`

### Authorization / scope control (bridge-side ACL)
The bridge must not be a raw proxy to every gateway method.

- Allow by default:
  - `agent` (with guardrails; idempotency required)
  - minimal `system-event` beacons (presence updates for the node)
  - node/canvas methods defined below (new protocol surface)
- Deny by default:
  - anything that widens control without explicit intent (future “shell”, “files”, etc.)
- Rate limit:
  - handshake attempts
  - voice forwards per minute
  - snapshot frequency / payload size

## Protocol unification: add “node/canvas” to Gateway protocol
### Principle
Unify mac Canvas + iOS Canvas under a single conceptual surface:
- The agent talks to the Gateway using a stable method set (typed protocol).
- The Gateway routes node-targeted requests to:
  - local mac Canvas implementation, or
  - remote iOS node via the bridge

### Minimal protocol additions (v1)
Add to `src/gateway/protocol/schema.ts` (and regenerate Swift models):

**Identity**
- Node identity comes from `connect.params.client.instanceId` (stable), and `connect.params.client.mode = "node"` (or `"ios-node"`).

**Methods**
- `node.list` → list paired/connected nodes + capabilities
- `node.describe` → describe a node (capabilities + supported `node.invoke` commands)
- `node.invoke` → send a command to a specific node
  - Params: `{ nodeId, command, params?, timeoutMs? }`

**Events**
- `node.event` → async node status/errors
  - e.g. background/foreground transitions, voice availability, canvas availability

### Node command set (canvas)
These are values for `node.invoke.command`:
- `canvas.present` / `canvas.hide`
- `canvas.navigate` with `{ url }` (loads a URL; use `""` or `"/"` to return to the default scaffold)
- `canvas.eval` with `{ javaScript }`
- `canvas.snapshot` with `{ maxWidth?, quality?, format? }`
- A2UI (mobile + macOS canvas):
  - `canvas.a2ui.push` with `{ messages: [...] }` (A2UI v0.8 server→client messages)
  - `canvas.a2ui.pushJSONL` with `{ jsonl: "..." }` (legacy alias)
  - `canvas.a2ui.reset`
  - A2UI is hosted by the Gateway canvas host (`/__clawdis__/a2ui/`); commands fail if the host is unreachable.

Result pattern:
- Request is a standard `req/res` with `ok` / `error`.
- Long operations (loads, streaming drawing, etc.) may also emit `node.event` progress.

#### Current (implemented)
As of 2025-12-13, the Gateway supports `node.invoke` for bridge-connected nodes.

Example: draw a diagonal line on the iOS Canvas:
```bash
clawdis nodes invoke --node ios-node --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__clawdis; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

### Background behavior requirement
When iOS is backgrounded:
- Voice may still be active (subject to iOS suspension).
- **All `canvas.*` commands must fail** with a stable error code, e.g.:
  - `NODE_BACKGROUND_UNAVAILABLE`
  - Include `retryable: true` and `retryAfterMs` if we want the agent to wait.

## iOS app architecture (SwiftUI)
### App structure
- Single fullscreen Canvas surface (WKWebView).
- One settings entry point: a **gear button** that opens a settings sheet.
- All navigation is **agent-driven** (no local URL bar).

### Components
- `BridgeDiscovery`: Bonjour browse + resolve (Network.framework `NWBrowser`)
- `BridgeConnection`: TCP session + pairing handshake + reconnect (TLS planned)
- `NodeRuntime`:
  - Voice pipeline (wake-word + capture + forward)
  - Canvas pipeline (WKWebView controller + snapshot + eval)
  - Background state tracking; enforces “canvas unavailable in background”

### Voice in background (internal)
- Enable background audio mode (and required session configuration) so the mic pipeline can keep running when the user switches apps.
- If iOS suspends the app anyway, surface a clear node status (`node.event`) so operators can see voice is unavailable.

## Code sharing (macOS + iOS)
Create/expand SwiftPM targets so both apps share:
- `ClawdisProtocol` (generated models; platform-neutral)
- `ClawdisGatewayClient` (shared WS framing + connect/req/res + seq-gap handling)
- `ClawdisKit` (node/canvas command types + deep links + shared utilities)

macOS continues to own:
- local Canvas implementation details (custom scheme handler serving on-disk HTML, window/panel presentation)

iOS owns:
- iOS-specific audio/speech + WKWebView presentation and lifecycle

## Repo layout
- iOS app: `apps/ios/` (XcodeGen `project.yml`)
- Shared Swift packages: `apps/shared/`
- Lint/format: iOS target runs `swiftformat --lint` + `swiftlint lint` using repo configs (`.swiftformat`, `.swiftlint.yml`).

Generate the Xcode project:
```bash
cd apps/ios
xcodegen generate
open Clawdis.xcodeproj
```

## Storage plan (private by default)
### iOS
- Canvas/workspace files (persistent, private):
  - `Application Support/Clawdis/canvas/<sessionKey>/...`
- Snapshots / temp exports (evictable):
  - `Library/Caches/Clawdis/canvas-snapshots/<sessionKey>/...`
- Credentials:
  - Keychain (paired identity + bridge trust anchor)

### macOS
- Keep current Canvas root (already implemented):
  - `~/Library/Application Support/Clawdis/canvas/<session>/...`
- Bridge state:
  - No local pairing store (pairing is gateway-owned).
  - Any local bridge-only state should remain private under Application Support.

### Gateway (node)
- Pairing (source of truth):
  - `~/.clawdis/nodes/paired.json`
  - `~/.clawdis/nodes/pending.json` (or `pending/*.json` for auditability)

## Rollout plan (phased)
1) **Bridge discovery + pairing (mac + iOS)**
  - Bonjour browse + resolve
  - Approve prompt on mac
  - Persist pairing in Keychain/App Support
2) **Voice-only node**
   - iOS voice wake toggle
   - Forward transcript to Gateway `agent` via bridge
   - Presence beacons via `system-event` (or node.event)
3) **Protocol additions for nodes**
   - Add `node.list` / `node.invoke` / `node.event` to Gateway
   - Implement bridge routing + ACLs
4) **iOS canvas**
   - WKWebView canvas surface
   - `canvas.navigate/eval/snapshot`
   - Background fast-fail for `canvas.*`
5) **Unify mac Canvas under the same node.invoke**
   - Keep existing implementation, but expose it through the unified protocol path so the agent uses one API.

## Open questions
- Should `connect.params.client.mode` be `"node"` with `platform="ios ..."` or a distinct mode `"ios-node"`? (Presence filtering currently excludes `"cli"` only.)
- Do we want a “permissions” model per node (voice only vs voice+canvas) at pairing time?
- Should loading arbitrary websites via `canvas.navigate` allow any https URL, or enforce an allowlist to reduce risk?
