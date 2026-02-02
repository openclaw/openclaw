# UI Project RPCs and APIs Reference

> **Source:** `ui/*` (Lit-based Control UI)
> **Date:** 2026-02-02
> **Purpose:** Complete inventory of all backend communication for reference during apps/web wiring

---

## Connection Architecture

### WebSocket Protocol: `GatewayBrowserClient`

**Location:** `ui/src/ui/gateway.ts`

The UI uses a custom WebSocket-based RPC protocol with the following characteristics:

- **Protocol Version:** 3
- **Connection URL:** `ws://127.0.0.1:18789` (default)
- **Auto-reconnect:** Exponential backoff (800ms → 15s cap, 1.7x multiplier)
- **Device Authentication:** WebCrypto-based signing in secure contexts (HTTPS/localhost)
- **Frame Types:** `req`, `res`, `event`
- **Request Timeout:** Per-method configurable, default varies by operation

### Authentication Flow

```
1. WebSocket opens → queue connect (750ms delay)
2. Server sends `connect.challenge` event with nonce
3. Client builds device auth payload with:
   - Device ID, public key, signature
   - Role: "operator"
   - Scopes: ["operator.admin", "operator.approvals", "operator.pairing"]
4. Client sends `connect` RPC with auth payload
5. Server responds with `hello-ok` containing device token
6. Token stored in IndexedDB for future sessions
```

---

## Complete RPC Method Reference

### 1. Chat & Messaging

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `chat.send` | `sessionKey`, `message`, `deliver?`, `idempotencyKey`, `attachments?` | `{ ok, runId? }` | default | `controllers/chat.ts` |
| `chat.history` | `sessionKey`, `limit` (default: 200) | `{ messages[], thinkingLevel? }` | default | `controllers/chat.ts` |
| `chat.abort` | `sessionKey`, `runId?` | `{ ok }` | default | `controllers/chat.ts` |

**Event Stream:** `chat` event with `{ runId, sessionKey, state: delta|final|aborted|error, message?, errorMessage? }`

**Call Flow:**
1. User types message → `chat.send` with `idempotencyKey` (UUID)
2. Server streams `chat` events with `state: delta` containing incremental content
3. Final event: `state: final` → call `chat.history` to refresh
4. On abort: `chat.abort` clears `chatRunId` state

### 2. Session Management

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `sessions.list` | `activeMinutes?`, `limit?`, `includeGlobal?`, `includeUnknown?` | `{ ts, path, count, defaults, sessions[] }` | default | `controllers/sessions.ts` |
| `sessions.patch` | `key`, `label?`, `tags?`, `thinkingLevel?`, `verboseLevel?`, `reasoningLevel?` | `{ ok }` | default | `controllers/sessions.ts` |
| `sessions.delete` | `key`, `deleteTranscript?` | `{ ok }` | default | `controllers/sessions.ts` |

**Usage Patterns:**
- Session list refreshed after chat completion or `/new`/`/reset` commands
- Default filter: `activeMinutes: 120` (last 2 hours)
- Session key format: `agent:{agentId}:{mainKey}`

### 3. Agent & Identity

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `agents.list` | none | `{ agents[] }` | default | `controllers/agents.ts` |
| `agent.identity.get` | `sessionKey` | `{ name?, avatar?, id? }` | default | `controllers/assistant-identity.ts` |
| `agent.test` | `model`, `thinkingLevel?` | `{ ok, error?, errorCode? }` | 45s | `controllers/onboarding.ts` |

**REST Endpoint:**
- `GET /avatar/{agentId}?meta=1` → `{ avatarUrl: string }`

### 4. Configuration Management

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `config.get` | none | `ConfigSnapshot { raw, config, hash, valid, issues[] }` | default | `controllers/config.ts` |
| `config.schema` | none | `{ schema, uiHints, version }` | default | `controllers/config.ts` |
| `config.set` | `raw`, `baseHash` | `{ ok }` | default | `controllers/config.ts` |
| `config.apply` | `raw`, `baseHash`, `sessionKey?` | `{ ok }` | default | `controllers/config.ts` |
| `update.run` | `sessionKey?` | `{ ok }` | default | `controllers/config.ts` |

**Optimistic Locking:**
- `baseHash` required for writes to prevent conflicts
- If hash mismatch, reload config and retry

**Form Mode:**
- Form edits update `configForm` object
- Raw mode edits `configRaw` string directly
- Serialize via `serializeConfigForm()` before save

### 5. Channel Status & Management

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `channels.status` | `probe?` | `{ channels[] }` | 8s | `controllers/channels.ts` |
| `channels.logout` | `channel`, `accountId?` | `{ channel, accountId, cleared }` | default | `controllers/channels.ts` |
| `web.login.start` | `accountId?` | `{ qrCode?, pairingCode?, ... }` | 30s | `controllers/channels.ts` |
| `web.login.wait` | `accountId?` | `{ ok, error? }` | 120s | `controllers/channels.ts` |

**Nostr REST Endpoints:**
- `PUT /api/channels/nostr/{accountId}/profile` - Save profile
- `POST /api/channels/nostr/{accountId}/profile/import` - Import profile

### 6. Cron Jobs & Scheduling

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `cron.status` | none | `{ enabled, jobCount, ... }` | default | cached |
| `cron.list` | `includeDisabled?` | `{ jobs[] }` | default | views/automations |
| `cron.add` | `name`, `schedule`, `payload`, `enabled?` | `{ id, ok }` | default | views/automations |
| `cron.update` | `id`, `enabled` | `{ ok }` | default | views/automations |
| `cron.run` | `id`, `mode: "force"` | `{ ok }` | default | views/automations |
| `cron.remove` | `id` | `{ ok }` | default | views/automations |
| `cron.runs` | `id?`, `limit?` | `{ runs[] }` | default | views/automations |

### 7. Automations

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `automations.list` | none | `{ automations[] }` | 10s | `controllers/automations.ts` |
| `automations.create` | automation object | `{ id, ok }` | default | `controllers/automations.ts` |
| `automations.update` | `id`, `enabled?`, ... | `{ ok }` | default | `controllers/automations.ts` |
| `automations.delete` | `id` | `{ ok }` | default | `controllers/automations.ts` |
| `automations.run` | `id` | `{ runId, ok }` | 30s | `controllers/automations.ts` |
| `automations.history` | `id?`, `limit?` | `{ runs[] }` | 10s | `controllers/automations.ts` |
| `automations.cancel` | `runId` | `{ ok }` | default | `controllers/automations.ts` |
| `automations.artifact.download` | `artifactId` | binary | 30s | `controllers/automations.ts` |

### 8. Overseer (Goal Management)

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `overseer.status` | none | `{ goals[], assignments[], ... }` | default | `controllers/overseer.ts` |
| `overseer.goal.status` | `goalId` | `{ goal, workNodes[], ... }` | default | `controllers/overseer.ts` |
| `overseer.goal.create` | `title`, `problemStatement`, `successCriteria` | `{ id, ok }` | default | `controllers/overseer.ts` |
| `overseer.goal.pause` | `goalId` | `{ ok }` | default | `controllers/overseer.ts` |
| `overseer.goal.resume` | `goalId` | `{ ok }` | default | `controllers/overseer.ts` |
| `overseer.tick` | `reason?` | `{ ok }` | default | `controllers/overseer.ts` |
| `overseer.work.update` | `workNodeId`, `status`, `reason?` | `{ ok }` | default | `controllers/overseer.ts` |
| `overseer.simulator.load` | none | simulator state | default | `controllers/overseer-simulator.ts` |
| `overseer.simulator.save` | state | `{ ok }` | default | `controllers/overseer-simulator.ts` |

### 9. System Health & Status

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `status` | none | system status summary | default | app-gateway |
| `health` | `probe?` | `{ uptime, memory, ... }` | default | app-gateway |
| `last-heartbeat` | none | `{ ts }` | default | app-gateway |
| `models.list` | none | `{ models[] }` | default | app-gateway |
| `system-presence` | none | `{ entries[] }` | default | app-gateway |
| `node.list` | none | `{ nodes[] }` | default | app-gateway |

### 10. Skills & Extensions

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `skills.status` | none | `{ skills[], enabled[], ... }` | default | skills view |
| `skills.update` | `id`, `enabled?`, `apiKey?` | `{ ok }` | default | skills view |
| `skills.install` | `id` | `{ ok }` | 120s | skills view |

### 11. TTS (Text-to-Speech)

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `tts.providers` | none | `{ providers[], active }` | default | `controllers/tts.ts` |
| `tts.setProvider` | `provider: openai|elevenlabs|edge` | `{ ok }` | default | `controllers/tts.ts` |

### 12. Device Pairing & Security

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `device.pair.list` | none | `{ pending[], paired[] }` | default | devices view |
| `device.pair.approve` | `deviceId`, `scopes` | `{ ok }` | default | devices view |
| `device.pair.reject` | `deviceId` | `{ ok }` | default | devices view |
| `device.token.rotate` | `deviceId` | `{ newToken }` | default | devices view |
| `device.token.revoke` | `deviceId` | `{ ok }` | default | devices view |

### 13. Exec Approvals

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `exec.approvals.get` | none | approvals file content | default | app-events |
| `exec.approvals.set` | approvals data | `{ ok }` | default | app-events |
| `exec.approvals.node.get` | `nodeId` | node approvals | default | app-events |
| `exec.approvals.node.set` | `nodeId`, approvals | `{ ok }` | default | app-events |
| `exec.approval.resolve` | `id`, `decision: allow-once|allow-always|deny` | `{ ok }` | default | app-events |

**Events:**
- `exec.approval.requested` → pending approval added to queue
- `exec.approval.resolved` → approval completed

### 14. Logs

| Method | Parameters | Response | Timeout | Controller |
|--------|------------|----------|---------|------------|
| `logs.tail` | `cursor?`, `maxBytes?` | `{ entries[], nextCursor }` | default | logs view |

---

## WebSocket Event Types

| Event | Payload Shape | Purpose |
|-------|---------------|---------|
| `connect.challenge` | `{ nonce }` | Device auth challenge |
| `chat` | `ChatEventPayload` | Chat streaming updates |
| `agent` | tool call progress, status | Agent activity (tool calls) |
| `presence` | `{ entries[] }` | Online/offline status |
| `cron` | job status changes | Cron job updates |
| `device.pair.requested` | `{ deviceId, ... }` | New pairing request |
| `device.pair.resolved` | `{ deviceId, approved }` | Pairing completed |
| `exec.approval.requested` | `{ id, command, ... }` | Tool approval needed |
| `exec.approval.resolved` | `{ id, decision }` | Tool approval resolved |

---

## Tab/View → RPC Mapping

| UI Tab | Primary RPCs | Events |
|--------|--------------|--------|
| **Chat** | `chat.send`, `chat.history`, `chat.abort`, `sessions.patch` | `chat`, `agent` |
| **Agents** | `agents.list`, `agent.identity.get`, `/avatar` | - |
| **Sessions** | `sessions.list`, `sessions.patch`, `sessions.delete` | - |
| **Config** | `config.get`, `config.schema`, `config.set`, `config.apply` | - |
| **Channels** | `channels.status`, `web.login.*`, `channels.logout` | - |
| **Cron** | `cron.*` | `cron` |
| **Automations** | `automations.*` | - |
| **Overseer** | `overseer.*` | - |
| **Debug** | `status`, `health`, `models.list`, `logs.tail` | - |
| **Devices** | `device.pair.*`, `device.token.*` | `device.pair.*` |
| **Skills** | `skills.*` | - |
| **Exec Approvals** | `exec.approvals.*`, `exec.approval.resolve` | `exec.approval.*` |

---

## State Management Patterns

### Tool Stream Buffering
- Location: `app-tool-stream.ts`
- Max items: 50
- Throttle: 80ms
- Output truncation: 120K chars

### Session Refresh After Chat
- Track `refreshSessionsAfterChat: Set<runId>`
- On `chat.final`, check if runId in set → `sessions.list`

### Config Form State
```typescript
interface ConfigState {
  configSnapshot: ConfigSnapshot | null;    // Last loaded config
  configForm: Record<string, unknown>;      // Editable form data
  configFormOriginal: Record<string, unknown>;  // For dirty detection
  configFormDirty: boolean;
  configFormMode: "form" | "raw";
  configRaw: string;                        // Raw YAML/JSON
}
```

---

## Authentication Scopes

| Scope | Purpose |
|-------|---------|
| `operator.admin` | Full configuration access |
| `operator.approvals` | Approve/deny tool executions |
| `operator.pairing` | Manage device pairing |

---

## Error Handling Patterns

1. **Network Errors:** Trigger reconnect with backoff
2. **RPC Errors:** Store in `lastError`, display via toast
3. **Config Hash Mismatch:** Reload config, user retry
4. **Close Code 1012 (Service Restart):** Silent reconnect
5. **Close Code 4008 (Connect Failed):** Visible error, trigger reconnect

---

## Summary Statistics

- **54 RPC Methods** across 14 categories
- **3 REST Endpoints** (avatar + Nostr profile)
- **10 Event Types** for real-time updates
- **Protocol Version:** 3 with device authentication
- **Reconnect Strategy:** Exponential backoff 800ms → 15s
