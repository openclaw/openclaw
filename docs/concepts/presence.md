---
summary: "How Clawdbot presence entries are produced, merged, and displayed"
read_when:
  - Debugging the Instances tab
  - Investigating duplicate or stale instance rows
  - Changing gateway WS connect or system-event beacons
---
# Presence

Clawdbot “presence” is a lightweight, best-effort view of:
- The **Gateway** itself (one per host), and
- The **clients connected to the Gateway** (mac app, WebChat, CLI, etc.).

Presence is used primarily to render the mac app’s **Instances** tab and to provide quick operator visibility.

## The data model

Presence entries are structured objects with (some) fields:
- `instanceId` (optional but strongly recommended): stable client identity used for dedupe
- `host`: a human-readable name (often the machine name)
- `ip`: best-effort IP address (may be missing or stale)
- `version`: client version string
- `deviceFamily` (optional): hardware family like `iPad`, `iPhone`, `Mac`
- `modelIdentifier` (optional): hardware model identifier like `iPad16,6` or `Mac16,6`
- `mode`: e.g. `gateway`, `app`, `webchat`, `cli`
- `lastInputSeconds` (optional): “seconds since last user input” for that client machine
- `reason`: a short marker like `self`, `connect`, `node-connected`, `node-disconnected`, `periodic`, `instances-refresh`
- `text`: legacy/debug summary string (kept for backwards compatibility and UI display)
- `ts`: last update timestamp (ms since epoch)

## Producers (where presence comes from)

Presence entries are produced by multiple sources and then **merged**.

### 1) Gateway self entry

The Gateway seeds a “self” entry at startup so UIs always show at least the current gateway host.

Implementation: [`src/infra/system-presence.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/infra/system-presence.ts) (`initSelfPresence()`).

### 2) WebSocket connect (connection-derived presence)

Every WS client must begin with a `connect` request. On successful handshake, the Gateway upserts a presence entry for that connection.

This is meant to answer: “Which clients are currently connected?”

Implementation: [`src/gateway/server.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/gateway/server.ts) (connect handling uses `connect.params.client.instanceId` when provided; otherwise falls back to `connId`).

#### Why one-off CLI commands do not show up

The CLI connects to the Gateway to execute one-off commands (health/status/send/agent/etc.). These are not “nodes” and would spam the Instances list, so the Gateway does not create presence entries for clients with `client.mode === "cli"`.

### 3) `system-event` beacons (client-reported presence)

Clients can publish richer periodic beacons via the `system-event` method. The mac app uses this to report:
- a human-friendly host name
- its best-known IP address
- `lastInputSeconds`

Implementation:
- Gateway: [`src/gateway/server.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/gateway/server.ts) handles method `system-event` by calling `updateSystemPresence(...)`.
- mac app beaconing: [`apps/macos/Sources/Clawdbot/PresenceReporter.swift`](https://github.com/clawdbot/clawdbot/blob/main/apps/macos/Sources/Clawdbot/PresenceReporter.swift).

### 4) Node bridge beacons (gateway-owned presence)

When a node bridge connection authenticates, the Gateway emits a presence entry
for that node and starts periodic refresh beacons so it does not expire.

- Connect/disconnect markers: `node-connected`, `node-disconnected`
- Periodic heartbeat: every 3 minutes (`reason: periodic`)

Implementation: [`src/gateway/server.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/gateway/server.ts) (node bridge handlers + timer beacons).

## Merge + dedupe rules (why `instanceId` matters)

All producers write into a single in-memory presence map.

Key points:
- Entries are **keyed** by a “presence key”. If two producers use the same key, they update the same entry.
- The best key is a stable, opaque `instanceId` that does not change across restarts.
- Keys are treated case-insensitively.

Implementation: [`src/infra/system-presence.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/infra/system-presence.ts) (`normalizePresenceKey()`).

### mac app identity (stable UUID)

The mac app uses a persisted UUID as `instanceId` so:
- restarts/reconnects do not create duplicates
- renaming the Mac does not create a new “instance”
- debug/release builds can share the same identity

Implementation: [`apps/macos/Sources/Clawdbot/InstanceIdentity.swift`](https://github.com/clawdbot/clawdbot/blob/main/apps/macos/Sources/Clawdbot/InstanceIdentity.swift).

`displayName` (machine name) is used for UI, while `instanceId` is used for dedupe.

## TTL and bounded size (why stale rows disappear)

Presence entries are not permanent:
- TTL: entries older than 5 minutes are pruned
- Max: map is capped at 200 entries (LRU by `ts`)

Implementation: [`src/infra/system-presence.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/infra/system-presence.ts) (`TTL_MS`, `MAX_ENTRIES`, pruning in `listSystemPresence()`).

## Remote/tunnel caveat (loopback IPs)

When a client connects over an SSH tunnel / local port forward, the Gateway may see the remote address as loopback (`127.0.0.1`).

To avoid degrading an otherwise-correct client beacon IP, the Gateway avoids writing loopback remote addresses into presence entries.

Implementation: [`src/gateway/server.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/gateway/server.ts) (`isLoopbackAddress()`).

## Consumers (who reads presence)

### macOS Instances tab

The mac app’s Instances tab renders the result of `system-presence`.

Implementation:
- View: [`apps/macos/Sources/Clawdbot/InstancesSettings.swift`](https://github.com/clawdbot/clawdbot/blob/main/apps/macos/Sources/Clawdbot/InstancesSettings.swift)
- Store: [`apps/macos/Sources/Clawdbot/InstancesStore.swift`](https://github.com/clawdbot/clawdbot/blob/main/apps/macos/Sources/Clawdbot/InstancesStore.swift)

The Instances rows show a small presence indicator (Active/Idle/Stale) based on
the last beacon age. The label is derived from the entry timestamp (`ts`).

The store refreshes periodically and also applies `presence` WS events.

## Debugging tips

- To see the raw list, call `system-presence` against the gateway.
- If you see duplicates:
  - confirm clients send a stable `instanceId` in the handshake (`connect.params.client.instanceId`)
  - confirm beaconing uses the same `instanceId`
  - check whether the connection-derived entry is missing `instanceId` (then it will be keyed by `connId` and duplicates are expected on reconnect)
