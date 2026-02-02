# Legacy `ui/*` RPC & API Map (Control UI)

This document maps every RPC/API invoked by the legacy `ui/*` control UI to its feature silo, including event-driven call flows and HTTP endpoints.

## Transport + Handshake

- **WebSocket transport** via `ui/src/ui/gateway.ts` (`GatewayBrowserClient`).
- **Handshake RPC:** `connect` (sent after optional `connect.challenge` event). Uses:
  - `minProtocol = 3`, `maxProtocol = 3`
  - client info: `openclaw-control-ui`, `mode: webchat`
  - role/scopes: `operator` with `operator.admin`, `operator.approvals`, `operator.pairing`
  - optional auth: token/password; device identity signatures when in a secure context (HTTPS/localhost)
- **Hello payload:** `hello-ok` contains `snapshot` (presence, health, session defaults) and `features`.

## Gateway Events Consumed

| Event | Used by | Effect |
|---|---|---|
| `connect.challenge` | `GatewayBrowserClient` | Provides nonce for device auth signature before `connect`.
| `agent` | Chat + tool stream | Tool call stream + compaction updates (`app-tool-stream.ts`).
| `chat` | Chat | Streaming deltas/final/aborted/error; triggers history refresh.
| `presence` | Overview / Instances | Updates presence list.
| `cron` | Cron tab | Refresh cron status/jobs when active.
| `device.pair.requested` / `device.pair.resolved` | Devices | Refresh pairing list.
| `exec.approval.requested` / `exec.approval.resolved` | Exec approvals | Queue updates + auto-expiry.

## HTTP Endpoints Used

| Endpoint | Method | Used by | Purpose |
|---|---|---|---|
| `/avatar/:agentId?meta=1` | `GET` | `app-chat.ts` | Fetch avatar URL metadata for current agent.
| `/api/channels/nostr/:accountId/profile` | `PUT` | `app-channels.ts` | Publish Nostr profile to relays.
| `/api/channels/nostr/:accountId/profile/import` | `POST` | `app-channels.ts` | Import/merge Nostr profile from relays.

## Feature Silos → RPCs / Call Flow

### Overview / Connection
- **RPCs:** `status`, `health`, `models.list`, `last-heartbeat`, `cron.list`, `channels.status`, `system-presence`, `sessions.list`, `cron.status`, `agent.identity.get`, `agents.list`
- **Flow:** on connect → load assistant identity + agents; on Overview tab → load channels/presence/sessions/cron + debug snapshots.

### Chat (webchat)
- **RPCs:** `chat.history`, `chat.send`, `chat.abort`
- **Events:** `chat` (delta/final/aborted/error), `agent` (tool stream + compaction)
- **HTTP:** `/avatar/:agentId?meta=1`
- **Flow:**
  1. Load history via `chat.history`.
  2. Send message via `chat.send` (idempotencyKey = runId; attachments encoded).
  3. Stream updates from `chat` events; tool output from `agent` events.
  4. Abort via `chat.abort`.

### Sessions
- **RPCs:** `sessions.list`, `sessions.patch`, `sessions.delete`
- **Flow:** list sessions with filters; patch labels/tags/verbosity; delete transcript.

### Agents
- **RPCs:** `agents.list` (+ `sessions.list` for recent session stats)
- **Flow:** list agents + render detail pane; session stats derived from session list.

### Config / Settings
- **RPCs:** `config.get`, `config.schema`, `config.set`, `config.apply`, `update.run`
- **Flow:** fetch config + schema; edit in form or raw; `config.set` for save; `config.apply` for apply w/ sessionKey; `update.run` for gateway update.

### Channels
- **RPCs:** `channels.status`, `web.login.start`, `web.login.wait`, `channels.logout`, `config.get`, `config.schema`, `config.set`
- **HTTP:** Nostr profile endpoints above.
- **Flow:** channel tab loads config + status; WhatsApp pairing via `web.login.*`; save channel config via `config.set` then reload.

### Skills
- **RPCs:** `skills.status`, `skills.update`, `skills.install`
- **Flow:** list skills, enable/disable, set API keys, install.

### Cron / Jobs
- **RPCs:** `cron.status`, `cron.list`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, `cron.runs`
- **Events:** `cron` (refresh when active)

### Automations
- **RPCs:** `automations.list`, `automations.create`, `automations.update`, `automations.delete`, `automations.run`, `automations.cancel`, `automations.history`, `automations.artifact.download`
- **Events:** `automations` (emitted by gateway; not explicitly handled in UI)

### Overseer (Goals / Work graph)
- **RPCs:** `overseer.status`, `overseer.goal.status`, `overseer.goal.create`, `overseer.goal.pause`, `overseer.goal.resume`, `overseer.work.update`, `overseer.tick`, `overseer.simulator.load`, `overseer.simulator.save`

### Nodes + Devices
- **RPCs:** `node.list`, `device.pair.list`, `device.pair.approve`, `device.pair.reject`, `device.token.rotate`, `device.token.revoke`
- **Events:** `device.pair.requested` / `device.pair.resolved`

### Exec Approvals
- **RPCs:** `exec.approvals.get`, `exec.approvals.set`, `exec.approvals.node.get`, `exec.approvals.node.set`, `exec.approval.resolve`
- **Events:** `exec.approval.requested` / `exec.approval.resolved`

### Logs
- **RPCs:** `logs.tail`

### Presence / Instances
- **RPCs:** `system-presence`

### Debug
- **RPCs:** `status`, `health`, `models.list`, `last-heartbeat`, `cron.list`, plus **arbitrary RPC calls** entered by the user in the debug console.

### TTS
- **RPCs:** `tts.providers`, `tts.setProvider`

### Onboarding
- **RPCs:** `config.get`, `config.set`, `health`, `channels.status`, **`agent.test`**
- **Note:** `agent.test` is invoked by the UI but not found in gateway server methods (gap to resolve).

## Complete RPC Inventory (Legacy UI)

```
connect
status
health
models.list
last-heartbeat
cron.list
channels.status
channels.logout
web.login.start
web.login.wait
config.get
config.schema
config.set
config.apply
config.patch (not used by legacy UI)
update.run
agents.list
agent.identity.get
sessions.list
sessions.patch
sessions.delete
chat.history
chat.send
chat.abort
skills.status
skills.update
skills.install
logs.tail
system-presence
cron.status
cron.add
cron.update
cron.remove
cron.run
cron.runs
node.list
device.pair.list
device.pair.approve
device.pair.reject
device.token.rotate
device.token.revoke
exec.approvals.get
exec.approvals.set
exec.approvals.node.get
exec.approvals.node.set
exec.approval.resolve
automations.list
automations.create
automations.update
automations.delete
automations.run
automations.cancel
automations.history
automations.artifact.download
overseer.status
overseer.goal.status
overseer.goal.create
overseer.goal.pause
overseer.goal.resume
overseer.work.update
overseer.tick
overseer.simulator.load
overseer.simulator.save
tts.providers
tts.setProvider
agent.test (called by UI; missing server method)
```

## Known Gaps / Questions

- `agent.test` is called from onboarding but appears missing in gateway server methods.
- Nostr profile HTTP endpoints (`/api/channels/nostr/...`) are used but no backend handlers were located in this repo.
