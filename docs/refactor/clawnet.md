---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Clawnet refactor: unify network protocol, roles, auth, approvals, identity"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Planning a unified network protocol for nodes + operator clients（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Reworking approvals, pairing, TLS, and presence across devices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Clawnet Refactor"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Clawnet refactor (protocol + auth unification)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Hi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hi Peter — great direction; this unlocks simpler UX + stronger security.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Purpose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Single, rigorous document for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Current state: protocols, flows, trust boundaries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pain points: approvals, multi‑hop routing, UI duplication.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Proposed new state: one protocol, scoped roles, unified auth/pairing, TLS pinning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Identity model: stable IDs + cute slugs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Migration plan, risks, open questions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goals (from discussion)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- One protocol for all clients (mac app, CLI, iOS, Android, headless node).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Every network participant authenticated + paired.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Role clarity: nodes vs operators.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Central approvals routed to where the user is.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TLS encryption + optional pinning for all remote traffic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Minimal code duplication.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Single machine should appear once (no UI/node duplicate entry).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Non‑goals (explicit)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remove capability separation (still need least‑privilege).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Expose full gateway control plane without scope checks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Make auth depend on human labels (slugs remain non‑security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Current state (as‑is)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Two protocols（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Gateway WebSocket (control plane)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full API surface: config, channels, models, sessions, agent runs, logs, nodes, etc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default bind: loopback. Remote access via SSH/Tailscale.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: token/password via `connect`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No TLS pinning (relies on loopback/tunnel).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Code:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `src/gateway/server/ws-connection/message-handler.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `src/gateway/client.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `docs/gateway/protocol.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Bridge (node transport)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Narrow allowlist surface, node identity + pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- JSONL over TCP; optional TLS + cert fingerprint pinning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TLS advertises fingerprint in discovery TXT.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Code:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `src/infra/bridge/server/connection.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `src/gateway/server-bridge.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `src/node-host/bridge-client.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `docs/gateway/bridge-protocol.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Control plane clients today（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI → Gateway WS via `callGateway` (`src/gateway/call.ts`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS app UI → Gateway WS (`GatewayConnection`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web Control UI → Gateway WS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ACP → Gateway WS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser control uses its own HTTP control server.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Nodes today（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS app in node mode connects to Gateway bridge (`MacNodeBridgeSession`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iOS/Android apps connect to Gateway bridge.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing + per‑node token stored on gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Current approval flow (exec)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent uses `system.run` via Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway invokes node over bridge.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node runtime decides approval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI prompt shown by mac app (when node == mac app).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node returns `invoke-res` to Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multi‑hop, UI tied to node host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Presence + identity today（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway presence entries from WS clients.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node presence entries from bridge.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- mac app can show two entries for same machine (UI + node).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node identity stored in pairing store; UI identity separate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Problems / pain points（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Two protocol stacks to maintain (WS + Bridge).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approvals on remote nodes: prompt appears on node host, not where user is.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TLS pinning only exists for bridge; WS depends on SSH/Tailscale.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Identity duplication: same machine shows as multiple instances.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ambiguous roles: UI + node + CLI capabilities not clearly separated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Proposed new state (Clawnet)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## One protocol, two roles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Single WS protocol with role + scope.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Role: node** (capability host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Role: operator** (control plane)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional **scope** for operator:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `operator.read` (status + viewing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `operator.write` (agent run, sends)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `operator.admin` (config, channels, models)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Role behaviors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Node**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Can register capabilities (`caps`, `commands`, permissions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Can receive `invoke` commands (`system.run`, `camera.*`, `canvas.*`, `screen.record`, etc).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Can send events: `voice.transcript`, `agent.request`, `chat.subscribe`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cannot call config/models/channels/sessions/agent control plane APIs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Operator**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full control plane API, gated by scope.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Receives all approvals.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Does not directly execute OS actions; routes to nodes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Key rule（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Role is per‑connection, not per device. A device may open both roles, separately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Unified authentication + pairing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Client identity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Every client provides:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deviceId` (stable, derived from device key).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `displayName` (human name).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `role` + `scope` + `caps` + `commands`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pairing flow (unified)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Client connects unauthenticated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway creates a **pairing request** for that `deviceId`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Operator receives prompt; approves/denies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway issues credentials bound to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - device public key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - role(s)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - scope(s)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - capabilities/commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Client persists token, reconnects authenticated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Device‑bound auth (avoid bearer token replay)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Preferred: device keypairs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Device generates keypair once.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deviceId = fingerprint(publicKey)`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway sends nonce; device signs; gateway verifies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tokens are issued to a public key (proof‑of‑possession), not a string.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Alternatives:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- mTLS (client certs): strongest, more ops complexity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Short‑lived bearer tokens only as a temporary phase (rotate + revoke early).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Silent approval (SSH heuristic)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Define it precisely to avoid a weak link. Prefer one:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local‑only**: auto‑pair when client connects via loopback/Unix socket.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Challenge via SSH**: gateway issues nonce; client proves SSH by fetching it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Physical presence window**: after a local approval on gateway host UI, allow auto‑pair for a short window (e.g. 10 minutes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Always log + record auto‑approvals.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# TLS everywhere (dev + prod)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reuse existing bridge TLS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use current TLS runtime + fingerprint pinning:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/infra/bridge/server/tls.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- fingerprint verification logic in `src/node-host/bridge-client.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Apply to WS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WS server supports TLS with same cert/key + fingerprint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WS clients can pin fingerprint (optional).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discovery advertises TLS + fingerprint for all endpoints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Discovery is locator hints only; never a trust anchor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reduce reliance on SSH/Tailscale for confidentiality.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Make remote mobile connections safe by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Approvals redesign (centralized)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Current（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Approval happens on node host (mac app node runtime). Prompt appears where node runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Proposed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Approval is **gateway‑hosted**, UI delivered to operator clients.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### New flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Gateway receives `system.run` intent (agent).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Gateway creates approval record: `approval.requested`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Operator UI(s) show prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Approval decision sent to gateway: `approval.resolve`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Gateway invokes node command if approved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Node executes, returns `invoke-res`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Approval semantics (hardening)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Broadcast to all operators; only the active UI shows a modal (others get a toast).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- First resolution wins; gateway rejects subsequent resolves as already settled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default timeout: deny after N seconds (e.g. 60s), log reason.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Resolution requires `operator.approvals` scope.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Benefits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prompt appears where user is (mac/phone).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Consistent approvals for remote nodes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node runtime stays headless; no UI dependency.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Role clarity examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## iPhone app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Node role** for: mic, camera, voice chat, location, push‑to‑talk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional **operator.read** for status and chat view.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional **operator.write/admin** only when explicitly enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## macOS app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Operator role by default (control UI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node role when “Mac node” enabled (system.run, screen, camera).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Same deviceId for both connections → merged UI entry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Operator role always.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Scope derived by subcommand:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `status`, `logs` → read（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `agent`, `message` → write（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `config`, `channels` → admin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - approvals + pairing → `operator.approvals` / `operator.pairing`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Identity + slugs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Stable ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Required for auth; never changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Preferred:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keypair fingerprint (public key hash).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cute slug (lobster‑themed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Human label only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example: `scarlet-claw`, `saltwave`, `mantis-pinch`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stored in gateway registry, editable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Collision handling: `-2`, `-3`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## UI grouping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Same `deviceId` across roles → single “Instance” row:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Badge: `operator`, `node`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Shows capabilities + last seen.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Migration strategy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Phase 0: Document + align（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Publish this doc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Inventory all protocol calls + approval flows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Phase 1: Add roles/scopes to WS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Extend `connect` params with `role`, `scope`, `deviceId`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add allowlist gating for node role.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Phase 2: Bridge compatibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep bridge running.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add WS node support in parallel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gate features behind config flag.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Phase 3: Central approvals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add approval request + resolve events in WS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update mac app UI to prompt + respond.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node runtime stops prompting UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Phase 4: TLS unification（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add TLS config for WS using bridge TLS runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add pinning to clients.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Phase 5: Deprecate bridge（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Migrate iOS/Android/mac node to WS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep bridge as fallback; remove once stable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Phase 6: Device‑bound auth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Require key‑based identity for all non‑local connections.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add revocation + rotation UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Security notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Role/allowlist enforced at gateway boundary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No client gets “full” API without operator scope.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing required for _all_ connections.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TLS + pinning reduces MITM risk for mobile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SSH silent approval is a convenience; still recorded + revocable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discovery is never a trust anchor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Capability claims are verified against server allowlists by platform/type.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Streaming + large payloads (node media)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WS control plane is fine for small messages, but nodes also do:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- camera clips（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- screen recordings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- audio streams（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. WS binary frames + chunking + backpressure rules.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Separate streaming endpoint (still TLS + auth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Keep bridge longer for media‑heavy commands, migrate last.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pick one before implementation to avoid drift.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Capability + command policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node‑reported caps/commands are treated as **claims**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway enforces per‑platform allowlists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Any new command requires operator approval or explicit allowlist change.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Audit changes with timestamps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Audit + rate limiting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Log: pairing requests, approvals/denials, token issuance/rotation/revocation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Rate‑limit pairing spam and approval prompts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Protocol hygiene（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Explicit protocol version + error codes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reconnect rules + heartbeat policy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Presence TTL and last‑seen semantics.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Open questions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Single device running both roles: token model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Recommend separate tokens per role (node vs operator).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Same deviceId; different scopes; clearer revocation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Operator scope granularity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - read/write/admin + approvals + pairing (minimum viable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Consider per‑feature scopes later.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Token rotation + revocation UX（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Auto‑rotate on role change.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - UI to revoke by deviceId + role.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Discovery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Extend current Bonjour TXT to include WS TLS fingerprint + role hints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Treat as locator hints only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Cross‑network approval（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Broadcast to all operator clients; active UI shows modal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - First response wins; gateway enforces atomicity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Summary (TL;DR)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Today: WS control plane + Bridge node transport.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pain: approvals + duplication + two stacks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Proposal: one WS protocol with explicit roles + scopes, unified pairing + TLS pinning, gateway‑hosted approvals, stable device IDs + cute slugs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Outcome: simpler UX, stronger security, less duplication, better mobile routing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
