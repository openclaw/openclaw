---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "How OpenClaw presence entries are produced, merged, and displayed"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging the Instances tab（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Investigating duplicate or stale instance rows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing gateway WS connect or system-event beacons（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Presence"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Presence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw “presence” is a lightweight, best‑effort view of:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- the **Gateway** itself, and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **clients connected to the Gateway** (mac app, WebChat, CLI, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Presence is used primarily to render the macOS app’s **Instances** tab and to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
provide quick operator visibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Presence fields (what shows up)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Presence entries are structured objects with fields like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `instanceId` (optional but strongly recommended): stable client identity (usually `connect.client.instanceId`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `host`: human‑friendly host name（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ip`: best‑effort IP address（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `version`: client version string（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deviceFamily` / `modelIdentifier`: hardware hints（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `lastInputSeconds`: “seconds since last user input” (if known)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ts`: last update timestamp (ms since epoch)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Producers (where presence comes from)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Presence entries are produced by multiple sources and **merged**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Gateway self entry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway always seeds a “self” entry at startup so UIs show the gateway host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
even before any clients connect.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) WebSocket connect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Every WS client begins with a `connect` request. On successful handshake the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway upserts a presence entry for that connection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Why one‑off CLI commands don’t show up（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The CLI often connects for short, one‑off commands. To avoid spamming the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Instances list, `client.mode === "cli"` is **not** turned into a presence entry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) `system-event` beacons（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Clients can send richer periodic beacons via the `system-event` method. The mac（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
app uses this to report host name, IP, and `lastInputSeconds`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4) Node connects (role: node)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a node connects over the Gateway WebSocket with `role: node`, the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
upserts a presence entry for that node (same flow as other WS clients).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Merge + dedupe rules (why `instanceId` matters)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Presence entries are stored in a single in‑memory map:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Entries are keyed by a **presence key**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The best key is a stable `instanceId` (from `connect.client.instanceId`) that survives restarts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keys are case‑insensitive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a client reconnects without a stable `instanceId`, it may show up as a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**duplicate** row.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## TTL and bounded size（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Presence is intentionally ephemeral:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **TTL:** entries older than 5 minutes are pruned（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Max entries:** 200 (oldest dropped first)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This keeps the list fresh and avoids unbounded memory growth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote/tunnel caveat (loopback IPs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a client connects over an SSH tunnel / local port forward, the Gateway may（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
see the remote address as `127.0.0.1`. To avoid overwriting a good client‑reported（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
IP, loopback remote addresses are ignored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Consumers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### macOS Instances tab（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS app renders the output of `system-presence` and applies a small status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
indicator (Active/Idle/Stale) based on the age of the last update.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Debugging tips（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To see the raw list, call `system-presence` against the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you see duplicates:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - confirm clients send a stable `client.instanceId` in the handshake（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - confirm periodic beacons use the same `instanceId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - check whether the connection‑derived entry is missing `instanceId` (duplicates are expected)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
