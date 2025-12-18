---
summary: "Gateway-owned node pairing (Option B) for iOS and other remote nodes"
read_when:
  - Implementing node pairing approvals without macOS UI
  - Adding CLI flows for approving remote nodes
  - Extending gateway protocol with node management
---
# Gateway-owned pairing (Option B)

Goal: The Gateway (`clawd`) is the **source of truth** for which nodes are allowed to join the network.

This enables:
- Headless approval via terminal/CLI (no Swift UI required).
- Optional macOS UI approval (Swift app is just a frontend).
- One consistent membership store for iOS, mac nodes, future hardware nodes.

## Concepts
- **Pending request**: a node asked to join; requires explicit approve/reject.
- **Paired node**: node is allowed; gateway returns an auth token for subsequent connects.
- **Bridge**: direct transport endpoint owned by the gateway. The bridge does not decide membership.

## API surface (gateway protocol)
These are conceptual method names; wire them into `src/gateway/protocol/schema.ts` and regenerate Swift types.

### Events
- `node.pair.requested`
  - Emitted whenever a new pending pairing request is created.
  - Payload:
    - `requestId` (string)
    - `nodeId` (string)
    - `displayName?` (string)
    - `platform?` (string)
    - `version?` (string)
    - `remoteIp?` (string)
    - `ts` (ms since epoch)
- `node.pair.resolved`
  - Emitted when a pending request is approved/rejected.
  - Payload:
    - `requestId` (string)
    - `nodeId` (string)
    - `decision` ("approved" | "rejected" | "expired")
    - `ts` (ms since epoch)

### Methods
- `node.pair.request`
  - Creates (or returns) a pending request.
  - Params: node metadata (same shape as `node.pair.requested` payload, minus `requestId`/`ts`).
  - Result:
    - `status` ("pending")
    - `created` (boolean) — whether this call created the pending request
    - `request` (pending request object), including `isRepair` when the node was already paired
  - Security: **never returns an existing token**. If a paired node “lost” its token, it must be approved again (token rotation).
- `node.pair.list`
  - Returns:
    - `pending[]` (pending requests)
    - `paired[]` (paired node records)
- `node.pair.approve`
  - Params: `{ requestId }`
  - Result: `{ requestId, node: { nodeId, token, ... } }`
  - Must be idempotent (first decision wins).
- `node.pair.reject`
  - Params: `{ requestId }`
  - Result: `{ requestId, nodeId }`
- `node.pair.verify`
  - Params: `{ nodeId, token }`
  - Result: `{ ok: boolean, node?: { nodeId, ... } }`

## CLI flows
CLI must be able to fully operate without any GUI:
- `clawdis nodes pending`
- `clawdis nodes approve <requestId>`
- `clawdis nodes reject <requestId>`
- `clawdis nodes status` (paired nodes + connection status/capabilities)

Optional interactive helper:
- `clawdis nodes watch` (subscribe to `node.pair.requested` and prompt in-place)

Implementation pointers:
- CLI commands: `src/cli/nodes-cli.ts`
- Gateway handlers + events: `src/gateway/server.ts`
- Pairing store: `src/infra/node-pairing.ts` (under `~/.clawdis/nodes/`)
- Optional macOS UI prompt (frontend only): `apps/macos/Sources/Clawdis/NodePairingApprovalPrompter.swift`

## Storage (private, local)
Gateway stores the authoritative state under `~/.clawdis/`:
- `~/.clawdis/nodes/paired.json`
- `~/.clawdis/nodes/pending.json` (or `~/.clawdis/nodes/pending/*.json`)

Notes:
- Tokens are secrets. Treat `paired.json` as sensitive.
- Pending entries should have a TTL (e.g. 5 minutes) and expire automatically.

## Bridge integration
Target direction:
- The gateway runs the bridge listener (LAN/tailnet-facing) and advertises discovery beacons (Bonjour).
- The bridge is transport only; it forwards/scopes requests and enforces ACLs, but pairing decisions are made by the gateway.

The macOS UI (Swift) can:
- Subscribe to `node.pair.requested`, show an alert (including `remoteIp`), and call `node.pair.approve` or `node.pair.reject`.
- Or ignore/dismiss (“Later”) and let CLI handle it.

## Implementation note
If the bridge is only provided by the macOS app, then “no Swift app running” cannot work end-to-end.
The long-term goal is to move bridge hosting + Bonjour advertising into the Node gateway so headless pairing works by default.
