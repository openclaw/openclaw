# `apps/web` Wiring Map (Current vs Needed RPCs/APIs)

This sweep maps **all functional areas in `apps/web`** to the RPCs/APIs they should use, and identifies where wiring is currently mocked or protocol-mismatched. Structured to align with the Opus UX docs (IA + Settings + Agent Config + Work/Goals + Onboarding).

## Connection + Protocol Layer

**Two competing gateway clients exist today:**

1. **`lib/api/gateway-client.ts`** (used by config/sessions hooks)
   - Uses WebSocket `connect` with **`minProtocol=1` / `maxProtocol=1`** and a simplified handshake.
   - Uses frames `{ type: "req" } / { type: "res" }` and expects `{ event }` frames.
   - **Mismatch:** gateway protocol version is **3**; legacy control UI uses `connect` + device auth/nonce.

2. **`integrations/openclaw`** (used by debug terminal + tool approvals)
   - Uses **`type: "rpc"` / `"response"`** frames and emits `OpenClawHookEvent` shapes.
   - **Mismatch:** gateway uses `type: "req"` / `"res"` frames and `event` frames; no `rpc/response` framing.

**Action needed:** unify on a single gateway client implementing protocol v3 + device auth flow + event routing.

## Live-Wired Surfaces (Gateway RPCs already referenced)

> Many of these are still gated behind `useLiveGateway` (DEV-only) or partial UI integration.

### System Settings (`/settings`)
- **RPCs used:**
  - `config.get`, `config.schema`, `config.patch`, `config.apply`
  - `channels.status`, `channels.logout`
  - `models.list`
  - `health`, `status`
- **Notes:**
  - `ModelProviderSection` uses `listModels` + `config.patch` and **direct provider HTTP calls** for API key verification (should move to gateway).
  - `GatewaySection` / `UsageSection` are **mock-only** (see below).

### Channels Configuration (Settings)
- **RPCs used:** `channels.status`, `channels.logout`, `config.patch`
- **Missing:** WhatsApp QR/pairing flow (legacy uses `web.login.start` / `web.login.wait`).

### Agent List + Detail (Partial)
- **RPCs used (live mode):** `config.get` (derives agent list)
- **Should use:** `agents.list` (already exists in gateway) + session stats (`sessions.list`).

### Sessions + Chat (Agent Session Route)
- **RPCs used:** `sessions.list`, `chat.history`, `chat.send`, `chat.abort`, `sessions.patch`, `sessions.delete`
- **Events expected:** `chat` + `tool` (stream handler), `chat` + `agent` (event subscription)
- **Mismatch:** gateway emits `chat` + `agent` (no `tool` event); `useGatewayStreamHandler` expects `tool` events.

### Worktree (Session Workspace Pane)
- **RPCs used:** `worktree.list`, `worktree.read`, `worktree.write`, `worktree.move`, `worktree.delete`, `worktree.mkdir`
- **Status:** UI still renders **mock file tree**; file preview uses `worktree.read` but shows “not implemented” errors.
- **Gateway support:** worktree RPCs are implemented in `src/gateway/server-methods/worktree.ts`.

### Security / Unlock
- **RPCs used:**
  - `security.getState`, `security.unlock`, `security.lock`
  - `security.setupPassword`, `security.changePassword`, `security.disable`
  - `security.setup2fa`, `security.verify2fa`, `security.disable2fa`, `security.getHistory`
  - `tokens.list`, `tokens.create`, `tokens.revoke`, `audit.query`
- **Status:** UI present; wiring to gateway client exists but relies on the protocol mismatch noted above.

## Mock / Unwired Surfaces → Required RPC Mapping

| Area / Route | Current data source | Should map to | Notes |
|---|---|---|---|
| **Home dashboard** (`/`) | Mock aggregates | `sessions.list`, `agents.list`, `channels.status`, `health/status` | Align with legacy overview data.
| **Conversations** (`/conversations/*`) | Mock store | `sessions.list` + `chat.history` + `chat.send` | Conversation IDs should be session keys.
| **Workstreams** (`/workstreams/*`) | Mock hooks (`useWorkstreams`) | **Likely** `overseer.*` + `automations.*` | Need product decision: workstreams map to Overseer goals/work nodes or Automations.
| **Goals** (`/goals`) | Mock hooks (`useGoals`) | `overseer.goal.*` + `overseer.status` | Goals UI aligns with Overseer more than Automations.
| **Rituals** (`/rituals`) | Mock hooks (`useRituals`) | `cron.*` (jobs) or `automations.*` | Decide: “rituals = cron jobs” vs “rituals = automations”.
| **Jobs** (`/jobs`) | Mock data | `cron.list`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, `cron.runs` | Direct match to legacy UI.
| **Nodes / Devices** (`/nodes`) | Mock data | `node.list`, `device.pair.*`, `device.token.*`, `node.pair.*` | Also map exec approvals if needed.
| **Filesystem** (`/filesystem`) | Mock tree | `worktree.list/read/write/move/delete/mkdir` | Replace mock tree + content with worktree RPCs.
| **Memories** (`/memories`) | Mock hooks | New **memory.* API** (not in gateway) | See Opus Graph/Memory track docs.
| **Debug** (`/debug`) | Mock health/RPC list | `status`, `health`, `models.list`, `logs.tail`, `system-event` | Debug UI should mirror legacy debug + event log.
| **Usage & Billing** (Settings) | Mock data | `usage.status`, `usage.cost` | Gateway methods exist in server list.
| **Gateway section** (Settings) | Mock data | `config.get` + `config.patch` (gateway.*) | Show actual bind/port/token + restart handling.
| **Toolsets** (Settings + Agent tools) | Local-only state | **New toolset CRUD RPCs** | Design docs expect gateway-backed toolsets.

## Event Stream Expectations (apps/web)

| apps/web expectation | Actual gateway events | Gap |
|---|---|---|
| `chat` streaming payloads | `chat` events exist | OK (ensure payload shape matches).
| `tool` events for tool output | Gateway emits `agent` events with `stream=tool` | Update handler to consume `agent` stream events (or add `tool` event in gateway).
| OpenClaw hook events (`agent:thinking`, `tool:pending`, etc.) | Not emitted by gateway | Either remove or add hook-event bridge.
| `gateway:connected` / `disconnected` via OpenClawEventBus | Gateway uses `hello-ok` + socket close | Need unified connection status mapping.

## HTTP Endpoints Referenced in apps/web

- `worktree` HTTP adapter expects:
  - `GET /api/agents/:agentId/worktree/list?path=...`
  - `GET /api/agents/:agentId/worktree/read?path=...`
  - `POST /api/agents/:agentId/worktree/write|move|delete|mkdir`
- **Status:** No matching HTTP handlers found in gateway; use RPC adapter instead or implement these endpoints.

## RPC Inventory Referenced by apps/web

```
connect
config.get
config.schema
config.patch
config.apply
channels.status
channels.logout
models.list
agents.list (declared, not used)
health
status
sessions.list
chat.history
chat.send
chat.abort
sessions.patch
sessions.delete
worktree.list
worktree.read
worktree.write
worktree.move
worktree.delete
worktree.mkdir
security.getState
security.setupPassword
security.changePassword
security.unlock
security.lock
security.disable
security.setup2fa
security.verify2fa
security.disable2fa
security.getHistory
tokens.list
tokens.create
tokens.revoke
audit.query
tool.approve (OpenClaw integration)
tool.reject (OpenClaw integration)
```

