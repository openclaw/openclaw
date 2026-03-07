---
summary: "Clawnet refactor: unify network protocol, roles, auth, approvals, identity"
read_when:
  - Planning a unified network protocol for nodes + operator clients
  - Reworking approvals, pairing, TLS, and presence across devices
title: "Clawnet Refactor"
---

# Clawnet refactor (protocol + auth unification)

## Hi

Hi Peter — great direction; this unlocks simpler UX + stronger security.

## Purpose

Single, rigorous document for:

- Current state: protocols, flows, trust boundaries.
- Pain points: approvals, multi‑hop routing, UI duplication.
- Proposed new state: one protocol, scoped roles, unified auth/pairing, TLS pinning.
- Identity model: stable IDs + cute slugs.
- Migration plan, risks, open questions.

## Goals (from discussion)

- One protocol for all clients (mac app, CLI, iOS, Android, headless node).
- Every network participant authenticated + paired.
- Role clarity: nodes vs operators.
- Central approvals routed to where the user is.
- TLS encryption + optional pinning for all remote traffic.
- Minimal code duplication.
- Single machine should appear once (no UI/node duplicate entry).

## Non‑goals (explicit)

- Remove capability separation (still need least‑privilege).
- Expose full gateway control plane without scope checks.
- Make auth depend on human labels (slugs remain non‑security).

---

# Current state (as‑is)

## Two protocols

### 1) Gateway WebSocket (control plane)

- Full API surface: config, channels, models, sessions, agent runs, logs, nodes, etc.
- Default bind: loopback. Remote access via SSH/Tailscale.
- Auth: token/password via `connect`.
- No TLS pinning (relies on loopback/tunnel).
- Code:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2) Bridge (node transport)

- Narrow allowlist surface, node identity + pairing.
- JSONL over TCP; optional TLS + cert fingerprint pinning.
- TLS advertises fingerprint in discovery TXT.
- Code:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Control plane clients today

- CLI → Gateway WS via `callGateway` (`src/gateway/call.ts`).
- macOS app UI → Gateway WS (`GatewayConnection`).
- Web Control UI → Gateway WS.
- ACP → Gateway WS.
- Browser control uses its own HTTP control server.

## Nodes today

- macOS app in node mode connects to Gateway bridge (`MacNodeBridgeSession`).
- iOS/Android apps connect to Gateway bridge.
- Pairing + per‑node token stored on gateway.

## Current approval flow (exec)

- Agent uses `system.run` via Gateway.
- Gateway invokes node over bridge.
- Node runtime decides approval.
- UI prompt shown by mac app (when node == mac app).
- Node returns `invoke-res` to Gateway.
- Multi‑hop, UI tied to node host.

## Presence + identity today

- Gateway presence entries from WS clients.
- Node presence entries from bridge.
- mac app can show two entries for same machine (UI + node).
- Node identity stored in pairing store; UI identity separate.

---

# Problems / pain points

- Two protocol stacks to maintain (WS + Bridge).
- Approvals on remote nodes: prompt appears on node host, not where user is.
- TLS pinning only exists for bridge; WS depends on SSH/Tailscale.
- Identity duplication: same machine shows as multiple instances.
- Ambiguous roles: UI + node + CLI capabilities not clearly separated.

---

# Proposed new state (Clawnet)

## One protocol, two roles

Single WS protocol with role + scope.

- **Role: node** (capability host)
- **Role: operator** (control plane)
- Optional **scope** for operator:
  - `operator.read` (status + viewing)
  - `operator.write` (agent run, sends)
  - `operator.admin` (config, channels, models)

### Role behaviors

**Node**

- Can register capabilities (`caps`, `commands`, permissions).
- Can receive `invoke` commands (`system.run`, `camera.*`, `canvas.*`, `screen.record`, etc).
- Can send events: `voice.transcript`, `agent.request`, `chat.subscribe`.
- Cannot call config/models/channels/sessions/agent control plane APIs.

**Operator**

- Full control plane API, gated by scope.
- Receives all approvals.
- Does not directly execute OS actions; routes to nodes.

### Key rule

Role is per‑connection, not per device. A device may open both roles, separately.

---

# Unified authentication + pairing

## Client identity

Every client provides:

- `deviceId` (stable, derived from device key).
- `displayName` (human name).
- `role` + `scope` + `caps` + `commands`.

## Pairing flow (unified)

- Client connects unauthenticated.
- Gateway creates a **pairing request** for that `deviceId`.
- Operator receives prompt; approves/denies.
- Gateway issues credentials bound to:
  - device public key
  - role(s)
  - scope(s)
  - capabilities/commands
- Client persists token, reconnects authenticated.

## Device‑bound auth (avoid bearer token replay)

Preferred: device keypairs.

- Device generates keypair once.
- `deviceId = fingerprint(publicKey)`.
- Gateway sends nonce; device signs; gateway verifies.
- Tokens are issued to a public key (proof‑of‑possession), not a string.

Alternatives:

- mTLS (client certs): strongest, more ops complexity.
- Short‑lived bearer tokens only as a temporary phase (rotate + revoke early).

## Silent approval (SSH heuristic)

Define it precisely to avoid a weak link. Prefer one:

- **Local‑only**: auto‑pair when client connects via loopback/Unix socket.
- **Challenge via SSH**: gateway issues nonce; client proves SSH by fetching it.
- **Physical presence window**: after a local approval on gateway host UI, allow auto‑pair for a short window (e.g. 10 minutes).

Always log + record auto‑approvals.

---

# TLS everywhere (dev + prod)

## Reuse existing bridge TLS

Use current TLS runtime + fingerprint pinning:

- `src/infra/bridge/server/tls.ts`
- fingerprint verification logic in `src/node-host/bridge-client.ts`

## Apply to WS

- WS server supports TLS with same cert/key + fingerprint.
- WS clients can pin fingerprint (optional).
- Discovery advertises TLS + fingerprint for all endpoints.
  - Discovery is locator hints only; never a trust anchor.

## Why

- Reduce reliance on SSH/Tailscale for confidentiality.
- Make remote mobile connections safe by default.

---

# Approvals redesign (centralized)

## Current

Approval happens on node host (mac app node runtime). Prompt appears where node runs.

## Proposed

Approval is **gateway‑hosted**, UI delivered to operator clients.

### New flow

1. Gateway receives `system.run` intent (agent).
2. Gateway creates approval record: `approval.requested`.
3. Operator UI(s) show prompt.
4. Approval decision sent to gateway: `approval.resolve`.
5. Gateway invokes node command if approved.
6. Node executes, returns `invoke-res`.

### Approval semantics (hardening)

- Broadcast to all operators; only the active UI shows a modal (others get a toast).
- First resolution wins; gateway rejects subsequent resolves as already settled.
- Default timeout: deny after N seconds (e.g. 60s), log reason.
- Resolution requires `operator.approvals` scope.

## Benefits

- Prompt appears where user is (mac/phone).
- Consistent approvals for remote nodes.
- Node runtime stays headless; no UI dependency.

---

# Role clarity examples

## iPhone app

- **Node role** for: mic, camera, voice chat, location, push‑to‑talk.
- Optional **operator.read** for status and chat view.
- Optional **operator.write/admin** only when explicitly enabled.

## macOS app

- Operator role by default (control UI).
- Node role when “Mac node” enabled (system.run, screen, camera).
- Same deviceId for both connections → merged UI entry.

## CLI

- Operator role always.
- Scope derived by subcommand:
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - approvals + pairing → `operator.approvals` / `operator.pairing`

---

# Identity + slugs

## Stable ID

Required for auth; never changes.
Preferred:

- Keypair fingerprint (public key hash).

## Cute slug (lobster‑themed)

Human label only.

- Example: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Stored in gateway registry, editable.
- Collision handling: `-2`, `-3`.

## UI grouping

Same `deviceId` across roles → single “Instance” row:

- Badge: `operator`, `node`.
- Shows capabilities + last seen.

---

# Migration strategy

## Phase 0: Document + align

- Publish this doc.
- Inventory all protocol calls + approval flows.

## Phase 1: Add roles/scopes to WS

- Extend `connect` params with `role`, `scope`, `deviceId`.
- Add allowlist gating for node role.

## Phase 2: Bridge compatibility

- Keep bridge running.
- Add WS node support in parallel.
- Gate features behind config flag.

## Phase 3: Central approvals

- Add approval request + resolve events in WS.
- Update mac app UI to prompt + respond.
- Node runtime stops prompting UI.

## Phase 4: TLS unification

- Add TLS config for WS using bridge TLS runtime.
- Add pinning to clients.

## Phase 5: Deprecate bridge

- Migrate iOS/Android/mac node to WS.
- Keep bridge as fallback; remove once stable.

## Phase 6: Device‑bound auth

- Require key‑based identity for all non‑local connections.
- Add revocation + rotation UI.

---

# Security notes

- Role/allowlist enforced at gateway boundary.
- No client gets “full” API without operator scope.
- Pairing required for _all_ connections.
- TLS + pinning reduces MITM risk for mobile.
- SSH silent approval is a convenience; still recorded + revocable.
- Discovery is never a trust anchor.
- Capability claims are verified against server allowlists by platform/type.

# Streaming + large payloads (node media)

WS control plane is fine for small messages, but nodes also do:

- camera clips
- screen recordings
- audio streams

Options:

1. WS binary frames + chunking + backpressure rules.
2. Separate streaming endpoint (still TLS + auth).
3. Keep bridge longer for media‑heavy commands, migrate last.

Pick one before implementation to avoid drift.

# Capability + command policy

- Node‑reported caps/commands are treated as **claims**.
- Gateway enforces per‑platform allowlists.
- Any new command requires operator approval or explicit allowlist change.
- Audit changes with timestamps.

# Audit + rate limiting

- Log: pairing requests, approvals/denials, token issuance/rotation/revocation.
- Rate‑limit pairing spam and approval prompts.

# Protocol hygiene

- Explicit protocol version + error codes.
- Reconnect rules + heartbeat policy.
- Presence TTL and last‑seen semantics.

---

# Open questions

1. Single device running both roles: token model
   - Recommend separate tokens per role (node vs operator).
   - Same deviceId; different scopes; clearer revocation.

2. Operator scope granularity
   - read/write/admin + approvals + pairing (minimum viable).
   - Consider per‑feature scopes later.

3. Token rotation + revocation UX
   - Auto‑rotate on role change.
   - UI to revoke by deviceId + role.

4. Discovery
   - Extend current Bonjour TXT to include WS TLS fingerprint + role hints.
   - Treat as locator hints only.

5. Cross‑network approval
   - Broadcast to all operator clients; active UI shows modal.
   - First response wins; gateway enforces atomicity.

---

# Summary (TL;DR)

- Today: WS control plane + Bridge node transport.
- Pain: approvals + duplication + two stacks.
- Proposal: one WS protocol with explicit roles + scopes, unified pairing + TLS pinning, gateway‑hosted approvals, stable device IDs + cute slugs.
- Outcome: simpler UX, stronger security, less duplication, better mobile routing.
