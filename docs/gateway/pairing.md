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
- **Bridge**: LAN transport that forwards between node ↔ gateway. The bridge does not decide membership.

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
    - `requestId`
    - `status` ("pending" | "alreadyPaired")
    - If already paired: may include `token` directly to allow fast path.
- `node.pair.list`
  - Returns:
    - `pending[]` (pending requests)
    - `paired[]` (paired node records)
- `node.pair.approve`
  - Params: `{ requestId }`
  - Result: `{ nodeId, token }`
  - Must be idempotent (first decision wins).
- `node.pair.reject`
  - Params: `{ requestId }`
  - Result: `{ nodeId }`

## CLI flows
CLI must be able to fully operate without any GUI:
- `clawdis nodes pending`
- `clawdis nodes approve <requestId>`
- `clawdis nodes reject <requestId>`

Optional interactive helper:
- `clawdis nodes watch` (subscribe to `node.pair.requested` and prompt in-place)

## Storage (private, local)
Gateway stores the authoritative state under `~/.clawdis/`:
- `~/.clawdis/nodes/paired.json`
- `~/.clawdis/nodes/pending.json` (or `~/.clawdis/nodes/pending/*.json`)

Notes:
- Tokens are secrets. Treat `paired.json` as sensitive.
- Pending entries should have a TTL (e.g. 5 minutes) and expire automatically.

## Bridge integration
The macOS Bridge is responsible for:
- Surfacing the pairing request to the gateway (`node.pair.request`).
- Waiting for the decision (`node.pair.approve`/`reject`) and completing the on-wire pairing handshake to the node.
- Enforcing ACLs on what the node can call, even after paired.

The macOS UI (Swift) can:
- Subscribe to `node.pair.requested`, show an alert, and call `node.pair.approve` or `node.pair.reject`.
- Or ignore/dismiss (“Later”) and let CLI handle it.

## Implementation note
If the bridge is only provided by the macOS app, then “no Swift app running” cannot work end-to-end.
To support headless pairing, also add a `clawdis bridge` CLI mode that provides the Bonjour bridge service and forwards to the local gateway.

