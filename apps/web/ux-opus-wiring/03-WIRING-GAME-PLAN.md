# Apps/Web Wiring Game Plan

> **Date:** 2026-02-02
> **Purpose:** Complete roadmap for wiring apps/web to the Gateway
> **Prerequisites:** Review `01-UI-RPCS-AND-APIS.md` and `02-APPS-WEB-FEATURE-MAP.md`

---

## Executive Summary

The `apps/web` project has a comprehensive UI with ~143 domain components, but most are running on mock data. To make it functional as a replacement for the current `ui/*` Control UI, we need:

1. **Gateway client upgrade** - Protocol v3 with device auth
2. **Core wiring** - Chat, sessions, config (already partially done)
3. **Feature wiring** - Goals, cron, channels, health
4. **New APIs** - Memories, rituals, workstreams (may require Gateway changes)
5. **Real-time events** - WebSocket event subscriptions

---

## Understanding "Protocol v3"

### What is Protocol v3?

The Gateway uses a **versioned WebSocket protocol** for client-server communication. The protocol version is negotiated during the initial `connect` handshake:

- **Current version:** `PROTOCOL_VERSION = 3` (defined in `src/gateway/protocol/schema/protocol-schemas.ts:258`)
- **apps/web currently uses:** `minProtocol: 1, maxProtocol: 1` (needs upgrade)
- **ui/* Control UI uses:** `minProtocol: 3, maxProtocol: 3`

### Protocol v3 Features

Protocol v3 adds **device-based authentication** on top of token auth:

1. **Challenge-Response Flow:** Server sends `connect.challenge` event with a nonce before accepting `connect` RPC
2. **Device Identity:** Client generates/stores a persistent device keypair (ECDSA P-256 via WebCrypto)
3. **Cryptographic Signing:** Client signs a payload containing deviceId, clientId, role, scopes, timestamp, and nonce
4. **Device Tokens:** Server issues device-specific tokens that persist across sessions

### Key Reference Files

| File | Purpose |
|------|---------|
| `src/gateway/protocol/schema/protocol-schemas.ts` | `PROTOCOL_VERSION = 3` constant |
| `src/gateway/protocol/schema/frames.ts` | `ConnectParamsSchema` with device auth fields |
| `src/gateway/device-auth.ts` | `buildDeviceAuthPayload()` function |
| `ui/src/ui/gateway.ts` | Reference browser implementation |
| `src/gateway/server/ws-connection/message-handler.ts` | Server-side protocol handling |

### Device Auth Payload Format

```typescript
// From src/gateway/device-auth.ts
function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce?: string | null;
  version?: "v1" | "v2";
}): string {
  // Returns: "v2|deviceId|clientId|mode|role|scope1,scope2|timestamp|token|nonce"
}
```

---

## Phase 0: Gateway Client Upgrade

### Objective
Upgrade `apps/web/src/lib/api/gateway-client.ts` to match `ui/src/ui/gateway.ts` capabilities.

### Tasks

| Task | Priority | Complexity | Files |
|------|----------|------------|-------|
| Upgrade to Protocol v3 | **Critical** | Medium | `gateway-client.ts` |
| Add device identity management | **Critical** | High | New: `device-identity.ts` |
| Add device token storage (IndexedDB) | **Critical** | Medium | New: `device-auth.ts` |
| Add challenge/response auth flow | **Critical** | Medium | `gateway-client.ts` |
| Add scope management | High | Low | `gateway-client.ts` |
| Add event frame handling | **Critical** | Medium | `gateway-client.ts` |
| Add sequence tracking + gap detection | Medium | Low | `gateway-client.ts` |

### Implementation Details

**Protocol v3 Connect Params (from `src/gateway/protocol/schema/frames.ts`):**
```typescript
const connectParams = {
  minProtocol: 3,
  maxProtocol: 3,
  client: {
    id: "web-ui",            // GatewayClientId
    version: "1.0.0",
    platform: "web",
    mode: "ui",              // GatewayClientMode
    instanceId: generateUUID(),
  },
  role: "operator",
  scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
  device: {
    id: deviceIdentity.deviceId,
    publicKey: deviceIdentity.publicKey,
    signature: await signDevicePayload(...),
    signedAt: Date.now(),
    nonce: challengeNonce,   // From connect.challenge event
  },
  auth: { token },           // Optional shared token
  caps: [],
  locale: navigator.language,
  userAgent: navigator.userAgent,
};
```

**Device Auth Flow:**
1. WebSocket opens → wait for `connect.challenge` event (or timeout after ~750ms)
2. Extract `nonce` from challenge payload
3. Build device auth payload string using `buildDeviceAuthPayload()`
4. Sign payload with device private key (ECDSA P-256 via WebCrypto `crypto.subtle`)
5. Send `connect` RPC with signed device info
6. On success, store returned `deviceToken` in IndexedDB keyed by `{deviceId, role}`

### Questions to Resolve

1. **Insecure Context Fallback:** Should we support plain HTTP (no device auth)? Current UI does with `allowInsecureAuth` gateway config. WebCrypto (`crypto.subtle`) is only available in secure contexts (HTTPS, localhost).
2. **Token Refresh:** Is device token rotation handled automatically or do we need explicit refresh?
3. **Multi-tab Handling:** How to handle multiple browser tabs with same device identity?

---

## Phase 1: Core Chat & Sessions Wiring

### Objective
Complete the chat and session functionality that's already partially implemented.

### Tasks

| Task | Priority | Files |
|------|----------|-------|
| Wire `useChatHistory` to gateway | **Critical** | `hooks/queries/useSessions.ts` |
| Implement `sendChatMessage` mutation | **Critical** | New: `hooks/mutations/useChatMutations.ts` |
| Wire `useSessions` to gateway | **Critical** | `hooks/queries/useSessions.ts` |
| Add chat event subscription | **Critical** | `hooks/useChatEventSubscription.ts` |
| Wire streaming message state | High | `stores/useSessionStore.ts` |
| Implement abort functionality | High | `hooks/mutations/useChatMutations.ts` |
| Add tool call tracking | Medium | `stores/useSessionStore.ts` |

### Implementation Pattern

**Chat Send Mutation:**
```typescript
export function useSendMessage() {
  const client = getGatewayClient();

  return useMutation({
    mutationFn: async ({ sessionKey, message, attachments }) => {
      const idempotencyKey = uuidv7();
      const result = await client.request("chat.send", {
        sessionKey,
        message,
        deliver: true,
        idempotencyKey,
        attachments: attachments?.map(att => ({
          type: "image",
          mimeType: att.mimeType,
          content: att.base64Content,
        })),
      });
      return { runId: result.runId, idempotencyKey };
    },
  });
}
```

**Chat Event Subscription:**
```typescript
export function useChatSubscription(sessionKey: string, handlers: ChatHandlers) {
  useEffect(() => {
    const client = getGatewayClient();

    const handleEvent = (event: GatewayEvent) => {
      if (event.event !== "chat") return;
      const payload = event.payload as ChatEventPayload;
      if (payload.sessionKey !== sessionKey) return;

      switch (payload.state) {
        case "delta":
          handlers.onDelta?.(payload);
          break;
        case "final":
          handlers.onFinal?.(payload);
          queryClient.invalidateQueries({ queryKey: sessionKeys.history(sessionKey) });
          break;
        // ...
      }
    };

    client.subscribe("chat", handleEvent);
    return () => client.unsubscribe("chat", handleEvent);
  }, [sessionKey, handlers]);
}
```

### Session Store Updates

```typescript
// Add to useSessionStore
interface StreamingState {
  runId: string;
  content: string;
  startedAt: number;
  toolCalls: ToolCallState[];
}

actions: {
  startStreaming: (sessionKey, runId) => { ... },
  appendContent: (sessionKey, delta) => { ... },
  updateToolCall: (sessionKey, toolCall) => { ... },
  finishStreaming: (sessionKey) => { ... },
}
```

---

## Phase 2: Settings & Configuration Wiring

### Objective
Wire all settings sections to Gateway RPCs.

### Tasks

| Task | Priority | Files |
|------|----------|-------|
| Wire `HealthDashboard` | High | `components/domain/config/HealthDashboard.tsx` |
| Wire `channels.status` | High | `hooks/queries/useChannels.ts` |
| Wire channel config sheets | Medium | `components/domain/config/channels/*.tsx` |
| Wire `models.list` | Medium | `hooks/queries/useModels.ts` |
| Wire TTS provider selection | Low | `hooks/mutations/useTTSMutations.ts` |

### Health Dashboard Wiring

```typescript
export function useHealth(probe = false) {
  const client = getGatewayClient();

  return useQuery({
    queryKey: ["health", { probe }],
    queryFn: () => client.request<HealthResponse>("health", { probe }),
    refetchInterval: 30000, // Refresh every 30s
  });
}

export function useStatus() {
  const client = getGatewayClient();

  return useQuery({
    queryKey: ["status"],
    queryFn: () => client.request<StatusResponse>("status", {}),
    refetchInterval: 60000,
  });
}
```

### Channel Status Wiring

```typescript
export function useChannelsStatus(options?: { probe?: boolean }) {
  const client = getGatewayClient();

  return useQuery({
    queryKey: ["channels", "status", options],
    queryFn: () => client.request<ChannelStatusResponse>("channels.status", {
      probe: options?.probe ?? false,
    }, { timeout: 8000 }),
  });
}

export function useChannelLogout() {
  const queryClient = useQueryClient();
  const client = getGatewayClient();

  return useMutation({
    mutationFn: ({ channel, accountId }) =>
      client.request("channels.logout", { channel, accountId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["channels"] });
    },
  });
}
```

---

## Phase 3: Feature Domain Wiring

### 3.1 Goals (Overseer)

**Required RPCs:** `overseer.status`, `overseer.goal.*`

| Hook | RPC | Notes |
|------|-----|-------|
| `useGoals()` | `overseer.status` | Extract goals from status |
| `useGoal(id)` | `overseer.goal.status` | Single goal detail |
| `useCreateGoal()` | `overseer.goal.create` | |
| `usePauseGoal()` | `overseer.goal.pause` | |
| `useResumeGoal()` | `overseer.goal.resume` | |

### 3.2 Cron Jobs

**Required RPCs:** `cron.*`

| Hook | RPC | Notes |
|------|-----|-------|
| `useCronJobs()` | `cron.list` | Include disabled |
| `useCronStatus()` | `cron.status` | |
| `useCreateCronJob()` | `cron.add` | |
| `useUpdateCronJob()` | `cron.update` | Enable/disable |
| `useRunCronJob()` | `cron.run` | Force execute |
| `useDeleteCronJob()` | `cron.remove` | |
| `useCronRunHistory(id)` | `cron.runs` | |

### 3.3 Automations

**Required RPCs:** `automations.*`

Similar pattern to cron jobs.

### 3.4 Skills

**Required RPCs:** `skills.*`

| Hook | RPC | Notes |
|------|-----|-------|
| `useSkills()` | `skills.status` | |
| `useUpdateSkill()` | `skills.update` | Enable/disable, API key |
| `useInstallSkill()` | `skills.install` | 120s timeout |

---

## Phase 4: New APIs Required

These features exist in `apps/web` but have **no corresponding Gateway RPCs**.

### 4.1 Memories

**UI Components:**
- `MemoryCard`, `MemoryDetail`, `MemoryDetailPanel`
- `MemorySearch`, `CreateMemoryModal`

**Proposed RPCs:**

| Method | Parameters | Response |
|--------|------------|----------|
| `memories.list` | `type?`, `tags?`, `limit?`, `cursor?` | `{ memories[], nextCursor? }` |
| `memories.get` | `id` | `Memory` |
| `memories.create` | Memory data | `{ id, ok }` |
| `memories.update` | `id`, patch | `{ ok }` |
| `memories.delete` | `id` | `{ ok }` |
| `memories.search` | `query`, `filters?` | `{ results[] }` |
| `memories.addTags` | `id`, `tags[]` | `{ ok }` |

**Questions:**
1. Where are memories stored? Config? Separate file? Database?
2. Should memories be per-agent or global?
3. Is search vector-based (requires embedding) or keyword?

### 4.2 Rituals

**UI Components:**
- `RitualCard`, `RitualDetailPanel`, `RitualList`
- `CreateRitualModal`, `RitualAssignDialog`

**Possible Mapping to Existing:**
- Rituals may be a UI abstraction over `cron.*` jobs
- Or they may need new dedicated APIs

**Proposed RPCs (if new):**

| Method | Parameters | Response |
|--------|------------|----------|
| `rituals.list` | `agentId?`, `status?` | `{ rituals[] }` |
| `rituals.get` | `id` | `Ritual` |
| `rituals.create` | Ritual data | `{ id, ok }` |
| `rituals.update` | `id`, patch | `{ ok }` |
| `rituals.delete` | `id` | `{ ok }` |
| `rituals.assign` | `id`, `agentIds[]` | `{ ok }` |
| `rituals.trigger` | `id` | `{ runId, ok }` |
| `rituals.pause` | `id` | `{ ok }` |
| `rituals.executions` | `id`, `limit?` | `{ executions[] }` |

**Questions:**
1. Are rituals agent-specific cron jobs?
2. Should `rituals.trigger` create a `cron.run`-style execution?

### 4.3 Workstreams

**UI Components:**
- `WorkstreamCard`, `WorkstreamDAG`
- `TaskNode`, `TaskDetailPanel`

**Possible Mapping to Existing:**
- Workstreams may relate to `overseer.*` work nodes
- Or they may be a new concept

**Proposed RPCs (if new):**

| Method | Parameters | Response |
|--------|------------|----------|
| `workstreams.list` | `ownerId?`, `status?` | `{ workstreams[] }` |
| `workstreams.get` | `id` | `Workstream` with tasks |
| `workstreams.create` | Workstream data | `{ id, ok }` |
| `workstreams.update` | `id`, patch | `{ ok }` |
| `workstreams.delete` | `id` | `{ ok }` |
| `workstreams.tasks.add` | `workstreamId`, task | `{ taskId, ok }` |
| `workstreams.tasks.update` | `taskId`, patch | `{ ok }` |
| `workstreams.tasks.reorder` | `workstreamId`, `taskIds[]` | `{ ok }` |

**Questions:**
1. Are workstreams related to overseer goals?
2. Is there a DAG dependency structure in the config?
3. How do tasks relate to agent sessions?

### 4.4 Activity Logs

**UI Components:**
- `AgentActivityTab`, `SessionActivityFeed`

**Proposed RPCs:**

| Method | Parameters | Response |
|--------|------------|----------|
| `activity.list` | `agentId?`, `sessionKey?`, `limit?`, `cursor?` | `{ events[], nextCursor? }` |
| `activity.recent` | `limit?` | `{ events[] }` |

**Alternative:** May be derivable from existing `logs.tail` with filters.

### 4.5 Usage Metrics

**UI Components:**
- `UsageSection` in settings

**Proposed RPCs:**

| Method | Parameters | Response |
|--------|------------|----------|
| `usage.summary` | `period?` | `{ tokens, cost, sessions, ... }` |
| `usage.byAgent` | `period?` | `{ agents: { id, tokens, cost }[] }` |
| `usage.byDay` | `days?` | `{ days: { date, tokens, cost }[] }` |

---

## Phase 5: Real-time Events System

### Objective
Create a unified event subscription system for the React app.

### Architecture

```
Gateway WebSocket
    │
    ▼
GatewayClient (event frame handling)
    │
    ▼
EventEmitter / Custom Hook
    │
    ├─► React Query invalidation
    ├─► Zustand store updates
    └─► Component callbacks
```

### Implementation

**Gateway Client Event API:**
```typescript
class GatewayClient {
  private eventListeners = new Map<string, Set<EventHandler>>();

  subscribe(event: string, handler: EventHandler): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(handler);
    return () => this.eventListeners.get(event)?.delete(handler);
  }

  private handleEvent(frame: GatewayEventFrame) {
    const handlers = this.eventListeners.get(frame.event);
    handlers?.forEach(h => h(frame));

    // Also emit to wildcard listeners
    this.eventListeners.get("*")?.forEach(h => h(frame));
  }
}
```

**React Hook:**
```typescript
export function useGatewayEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void
) {
  useEffect(() => {
    const client = getGatewayClient();
    return client.subscribe(event, (frame) => {
      handler(frame.payload as T);
    });
  }, [event, handler]);
}
```

### Event → Query Invalidation Map

| Event | Query Keys to Invalidate |
|-------|-------------------------|
| `chat` (final) | `["sessions", "history", sessionKey]` |
| `agent` | — (handled by session store) |
| `presence` | `["presence"]` |
| `cron` | `["cron"]` |
| `device.pair.*` | `["devices"]` |
| `exec.approval.*` | `["approvals"]` |

---

## Concerns & Open Questions

### Critical Questions

1. **Memory Persistence:** Where do memories live? Need to understand storage before implementing API.

2. **Rituals vs Cron:** Are rituals a UI layer over cron, or distinct? Need clarification on the domain model.

3. **Workstreams vs Overseer:** How do workstreams relate to overseer goals/work nodes?

4. **Activity Logs Source:** Is there an existing log format to parse, or do we need new event tracking?

5. **Usage Metrics Backend:** Is there existing telemetry, or does this need to be built?

### Technical Questions

6. **WebCrypto in Development:** How to handle device auth in `http://localhost`? (Should work, but verify)

7. **Session Key Format:** Is `agent:{agentId}:{mainKey}` the canonical format? What about global sessions?

8. **Config Patching vs New RPCs:** Should new features (memories, rituals) use config patching or dedicated RPCs?

9. **Event Subscription Lifecycle:** How to handle subscriptions across route changes?

10. **Mock Mode Long-term:** Keep mock mode for development, or remove once wired?

### API Design Questions

11. **Pagination Pattern:** Use cursor-based (like logs) or offset-based?

12. **Error Shape:** Should all errors follow `{ code, message, details? }` pattern?

13. **Optimistic Locking:** Which new APIs need baseHash-style locking?

---

## Implementation Priority Matrix

| Feature | User Impact | Complexity | Dependencies | Priority |
|---------|-------------|------------|--------------|----------|
| Gateway client v3 | Blocker | High | None | **P0** |
| Chat wiring | High | Medium | Gateway v3 | **P0** |
| Sessions wiring | High | Low | Gateway v3 | **P0** |
| Config (already done) | High | — | — | Done |
| Health dashboard | Medium | Low | None | **P1** |
| Channels status | Medium | Low | None | **P1** |
| Goals (overseer) | Medium | Medium | None | **P1** |
| Cron jobs | Medium | Low | None | **P1** |
| Skills | Low | Low | None | **P2** |
| Memories | Medium | High | New APIs | **P2** |
| Rituals | Medium | Medium | Clarification | **P2** |
| Workstreams | Medium | High | Clarification | **P3** |
| Activity logs | Low | Medium | Clarification | **P3** |
| Usage metrics | Low | Medium | New APIs | **P3** |

---

## Success Criteria

### Phase 0 Complete
- [ ] Gateway client connects with protocol v3
- [ ] Device authentication works in secure context
- [ ] Token persists across page reloads
- [ ] Events received and dispatched

### Phase 1 Complete
- [ ] Can send chat message and see streaming response
- [ ] Chat history loads correctly
- [ ] Session list shows real sessions
- [ ] Tool calls display during agent execution

### Phase 2 Complete
- [ ] Health dashboard shows live data
- [ ] Channel status accurate
- [ ] Channel config changes persist

### Phase 3 Complete
- [ ] Goals show from overseer
- [ ] Cron jobs manageable via UI
- [ ] Skills can be enabled/disabled

### Phase 4 Complete
- [ ] New APIs implemented and documented
- [ ] Memories, rituals, workstreams functional
- [ ] Activity logs available

### Full Wiring Complete
- [ ] All mock data removed (or optional)
- [ ] `useLiveGateway` toggle removed
- [ ] All features work end-to-end
- [ ] Performance acceptable (<2s initial load)

---

## Related Documents

- `01-UI-RPCS-AND-APIS.md` - Complete RPC reference from ui/*
- `02-APPS-WEB-FEATURE-MAP.md` - Feature inventory with status
- `../ux-opus-design/11-IMPLEMENTATION-ROADMAP.md` - UX implementation phases
- `../ux-opus-design/04-CURRENT-STATE-ANALYSIS.md` - Component analysis
