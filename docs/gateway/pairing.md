---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Gateway-owned node pairing (Option B) for iOS and other remote nodes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Implementing node pairing approvals without macOS UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding CLI flows for approving remote nodes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Extending gateway protocol with node management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Gateway-Owned Pairing"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Gateway-owned pairing (Option B)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In Gateway-owned pairing, the **Gateway** is the source of truth for which nodes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
are allowed to join. UIs (macOS app, future clients) are just frontends that（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
approve or reject pending requests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Important:** WS nodes use **device pairing** (role `node`) during `connect`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`node.pair.*` is a separate pairing store and does **not** gate the WS handshake.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Only clients that explicitly call `node.pair.*` use this flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Concepts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Pending request**: a node asked to join; requires approval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Paired node**: approved node with an issued auth token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Transport**: the Gateway WS endpoint forwards requests but does not decide（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  membership. (Legacy TCP bridge support is deprecated/removed.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How pairing works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. A node connects to the Gateway WS and requests pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. The Gateway stores a **pending request** and emits `node.pair.requested`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. You approve or reject the request (CLI or UI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. On approval, the Gateway issues a **new token** (tokens are rotated on re‑pair).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. The node reconnects using the token and is now “paired”.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pending requests expire automatically after **5 minutes**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI workflow (headless friendly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes pending（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes approve <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes reject <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`nodes status` shows paired/connected nodes and their capabilities.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## API surface (gateway protocol)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Events:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.pair.requested` — emitted when a new pending request is created.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.pair.resolved` — emitted when a request is approved/rejected/expired.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Methods:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.pair.request` — create or reuse a pending request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.pair.list` — list pending + paired nodes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.pair.approve` — approve a pending request (issues token).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.pair.reject` — reject a pending request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.pair.verify` — verify `{ nodeId, token }`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.pair.request` is idempotent per node: repeated calls return the same（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  pending request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approval **always** generates a fresh token; no token is ever returned from（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `node.pair.request`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requests may include `silent: true` as a hint for auto-approval flows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auto-approval (macOS app)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS app can optionally attempt a **silent approval** when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- the request is marked `silent`, and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- the app can verify an SSH connection to the gateway host using the same user.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If silent approval fails, it falls back to the normal “Approve/Reject” prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Storage (local, private)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pairing state is stored under the Gateway state directory (default `~/.openclaw`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/nodes/paired.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/nodes/pending.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you override `OPENCLAW_STATE_DIR`, the `nodes/` folder moves with it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Security notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tokens are secrets; treat `paired.json` as sensitive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Rotating a token requires re-approval (or deleting the node entry).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Transport behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The transport is **stateless**; it does not store membership.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the Gateway is offline or pairing is disabled, nodes cannot pair.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the Gateway is in remote mode, pairing still happens against the remote Gateway’s store.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
