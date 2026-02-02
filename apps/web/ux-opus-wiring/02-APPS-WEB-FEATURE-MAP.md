# Apps/Web Feature Map & Backend Requirements

> **Source:** `apps/web/src/*`
> **Date:** 2026-02-02
> **Purpose:** Map all UI features to their backend wiring requirements

---

## Current Wiring Status

### Architecture Overview

```
apps/web/
├── src/
│   ├── components/
│   │   ├── domain/           # Feature-specific (143+ components across 21 domains)
│   │   ├── composed/         # Assembled components (19 files)
│   │   └── ui/               # Base shadcn components
│   ├── routes/               # TanStack Router (file-based)
│   ├── hooks/
│   │   ├── queries/          # React Query hooks (data fetching)
│   │   └── mutations/        # React Query mutations (state changes)
│   ├── stores/               # Zustand state management
│   ├── integrations/         # External integrations (OpenClaw)
│   └── lib/
│       └── api/              # Gateway client & API functions
```

### Existing Gateway Client

**Location:** `apps/web/src/lib/api/gateway-client.ts`

**Current Capabilities:**
- WebSocket connection management
- Request/response correlation via message IDs
- Automatic reconnection with exponential backoff
- Event subscriptions (partial)

**Protocol Version:** 1 (needs upgrade to v3 for device auth)

**Gap:** Missing device authentication, nonce challenge handling, scopes

---

## Feature Areas & Backend Requirements

### 1. Home Dashboard (`/`)

| Component | Backend Required | Current Status |
|-----------|------------------|----------------|
| `QuickChatBox` | `chat.send`, `sessions.list` | **Unwired** - Mock only |
| `TeamAgentGrid` | `agents.list`, `agent.identity.get` | **Partial** - uses `config.get` |
| `ActiveWorkstreamsSection` | Workstream APIs (new) | **Unwired** - Mock data |
| `GoalProgressPanel` | `overseer.status` | **Unwired** - Mock data |
| `UpcomingRitualsPanel` | Ritual APIs (new) | **Unwired** - Mock data |
| `RecentMemoriesPanel` | Memory APIs (new) | **Unwired** - Mock data |

### 2. Agents (`/agents`, `/agents/$agentId`)

| Component | Backend Required | Current Status |
|-----------|------------------|----------------|
| Agent list | `agents.list` or `config.get` | **Wired** via config |
| Agent CRUD | Config patching | **Wired** via `useAgentMutations` |
| `AgentOverviewTab` | Agent config read | **Wired** via config |
| `AgentActivityTab` | Activity log API (new?) | **Unwired** - Mock data |
| `AgentToolsTab` | Toolset config | **Wired** via config |
| `AgentRitualsTab` | Ritual APIs | **Unwired** - Mock data |
| `AgentWorkstreamsTab` | Workstream APIs | **Unwired** - Mock data |
| `AgentSoulTab` | Agent soul config | **Wired** via config |
| `NewSessionDialog` | `sessions.list`, session creation | **Partial** |

### 3. Sessions & Chat (`/conversations/$id`)

| Component | Backend Required | Current Status |
|-----------|------------------|----------------|
| `SessionChat` | `chat.send`, `chat.history`, events | **Partial** - types defined |
| `SessionChatInput` | `chat.send`, `chat.abort` | **Unwired** |
| `SessionHeader` | `sessions.patch` | **Partial** |
| `SessionActivityFeed` | `agent` events | **Unwired** |
| `ConversationList` | `sessions.list` | **Wired** - mock fallback |
| `ConversationItem` | Session data | **Wired** |

**Real-time Events Needed:**
- `chat` events (delta, final, aborted, error)
- `agent` events (tool calls, progress)

### 4. Agentic Workflow (`/conversations/$id/agentic`)

| Component | Backend Required | Current Status |
|-----------|------------------|----------------|
| `MessageComposer` | `chat.send` with attachments | **Unwired** |
| `ToolApprovalCard` | `exec.approval.resolve` | **Unwired** |
| `QuestionCard` | Tool result handling | **Unwired** |
| `WorkflowVisualization` | Workflow state tracking | **Unwired** |

**OpenClaw Integration:**
- `OpenClawEventBus` implemented but not connected to gateway
- Event types defined but not subscribed

### 5. Settings (`/settings`)

| Section | Backend Required | Current Status |
|---------|------------------|----------------|
| `HealthDashboard` | `health`, `status` | **Unwired** - Mock data |
| `ModelProviderSection` | `config.get`, `config.patch`, `models.list` | **Partial** - config wired |
| `AIProviderSection` | Provider key verification | **Partial** - client-side verify |
| `GatewayConfig` | `config.get`, `config.patch` | **Wired** via config |
| `ChannelConfig` | `channels.status`, `channels.logout` | **Unwired** |
| `AgentConfig` | Agent list/CRUD | **Wired** via config |
| `ToolsetsSection` | Toolset config | **Wired** via config |
| `ConnectionsSection` | OAuth/pairing flows | **Unwired** |
| `AdvancedSection` | Various config | **Partial** |
| `UsageSection` | Usage metrics API (new?) | **Unwired** - Mock data |

**Channel Config Sheets:**
- Discord, Slack, Telegram, WhatsApp, Signal, iMessage all present
- All **Unwired** - forms exist but no save/test functionality

### 6. Goals (`/goals`)

| Component | Backend Required | Current Status |
|-----------|------------------|----------------|
| Goal list | `overseer.status` | **Unwired** - Mock data |
| `GoalDetailPanel` | `overseer.goal.status` | **Unwired** |
| `CreateGoalModal` | `overseer.goal.create` | **Unwired** |
| Goal status updates | `overseer.goal.pause/resume` | **Unwired** |

### 7. Memories (`/memories`)

| Component | Backend Required | Current Status |
|-----------|------------------|----------------|
| Memory list | Memory list API (new?) | **Unwired** - Mock data |
| `MemorySearch` | Memory search API | **Unwired** |
| `MemoryCard` | Memory data | **Unwired** |
| `MemoryDetailPanel` | Memory detail API | **Unwired** |
| `CreateMemoryModal` | Memory create API | **Unwired** |

**Note:** Memories may require new Gateway RPCs or be managed via graph DB.

### 8. Rituals (`/rituals`)

| Component | Backend Required | Current Status |
|-----------|------------------|----------------|
| Ritual list | Ritual list API (new?) | **Unwired** - Mock data |
| `RitualCard` | Ritual data | **Unwired** |
| `RitualDetailPanel` | Ritual detail | **Unwired** |
| `CreateRitualModal` | Ritual create API | **Unwired** |
| `RitualAssignDialog` | Agent-ritual assignment | **Unwired** |

**Note:** Rituals may map to `cron.*` or require new APIs.

### 9. Workstreams (`/workstreams/$workstreamId`)

| Component | Backend Required | Current Status |
|-----------|------------------|----------------|
| Workstream list | Workstream API (new?) | **Unwired** - Mock data |
| `WorkstreamCard` | Workstream data | **Unwired** |
| `WorkstreamDAG` | DAG visualization data | **Unwired** |
| `TaskNode` | Task data | **Unwired** |
| `TaskDetailPanel` | Task detail | **Unwired** |

**Note:** Workstreams may relate to `overseer.*` or require new APIs.

### 10. Jobs (`/jobs` - Power User)

| Component | Backend Required | Current Status |
|-----------|------------------|----------------|
| Cron job list | `cron.list` | **Unwired** - Mock data |
| Job creation | `cron.add` | **Unwired** |
| Job editing | `cron.update` | **Unwired** |
| Job execution | `cron.run` | **Unwired** |
| Run history | `cron.runs` | **Unwired** |

### 11. Filesystem (`/filesystem` - Power User)

| Component | Backend Required | Current Status |
|-----------|------------------|----------------|
| File tree | File list API | **Unwired** - Mock data |
| File content | File read API | **Unwired** |
| File editing | File write API | **Unwired** |

**Note:** May need new Gateway RPCs for config file access.

### 12. Debug (`/debug` - Power User)

| Component | Backend Required | Current Status |
|-----------|------------------|----------------|
| System status | `status`, `health` | **Unwired** |
| Model list | `models.list` | **Unwired** |
| Metrics | `health` with details | **Unwired** |
| Terminal | Command execution | **Unwired** |
| Graph explorer | Node data | **Unwired** |

### 13. User Profile (`/you`)

| Component | Backend Required | Current Status |
|-----------|------------------|----------------|
| Profile section | User settings API | **Unwired** - Local only |
| Preferences | Config or local storage | **Partial** - Zustand |
| Activity log | Activity API | **Unwired** |

### 14. Security & Unlock

| Component | Backend Required | Current Status |
|-----------|------------------|----------------|
| `UnlockScreen` | Local auth (crypto) | **Partial** - UI exists |
| `SetupUnlockModal` | Local setup | **Partial** |
| 2FA setup | TOTP validation | **Unwired** |
| Audit log | Audit API | **Unwired** |

---

## Stores & Data Flow

### Current Zustand Stores

| Store | Purpose | Backend Sync |
|-------|---------|--------------|
| `useAgentStore` | Agent list & selection | Via config queries |
| `useSessionStore` | Active sessions, streaming | Needs gateway events |
| `useUIStore` | UI state, theme, modes | Local only |
| `useToolsetsStore` | Toolset presets | Via config |
| `useGuidancePackStore` | Guidance packs | Via config |

### Query Hooks Status

| Hook | Backend Call | Status |
|------|--------------|--------|
| `useAgents` | `config.get` | **Wired** - fallback to mock |
| `useAgent` | `config.get` | **Wired** - fallback to mock |
| `useSessions` | `sessions.list` | **Partial** - mock fallback |
| `useChatHistory` | `chat.history` | **Partial** - mock fallback |
| `useConfig` | `config.get` | **Wired** |
| `useModels` | `models.list` | **Unwired** |
| `useGoals` | `overseer.status` | **Unwired** |
| `useMemories` | Memory API | **Unwired** |
| `useRituals` | Ritual API | **Unwired** |
| `useWorkstreams` | Workstream API | **Unwired** |
| `useChannels` | `channels.status` | **Unwired** |
| `useGateway` | `status`, `health` | **Unwired** |
| `useUserSettings` | User API | **Unwired** |

### Mutation Hooks Status

| Hook | Backend Call | Status |
|------|--------------|--------|
| `useCreateAgent` | `config.patch` | **Wired** |
| `useUpdateAgent` | `config.patch` | **Wired** |
| `useDeleteAgent` | `config.patch` | **Wired** |
| `useUpdateAgentStatus` | N/A | **Mock only** |
| `useConfigMutations` | `config.patch` | **Wired** |
| `useConversationMutations` | Session APIs | **Unwired** |
| `useGoalMutations` | Overseer APIs | **Unwired** |
| `useMemoryMutations` | Memory APIs | **Unwired** |
| `useRitualMutations` | Ritual APIs | **Unwired** |
| `useWorkstreamMutations` | Workstream APIs | **Unwired** |
| `useUserSettingsMutations` | User APIs | **Unwired** |

---

## OpenClaw Integration Analysis

**Location:** `apps/web/src/integrations/openclaw/`

### Current Implementation

```typescript
// Event types defined
type OpenClawEventAction =
  | "new" | "reset" | "stop" | "send" | "retry"
  | "created" | "resumed" | "ended" | "pruned"
  | "thinking" | "streaming" | "tool_call" | "tool_result" | "complete" | "error"
  | "startup" | "shutdown" | "connected" | "disconnected" | "message"
  | "pending" | "approved" | "rejected" | "executing" | "executed"
  | "started" | "paused" | "resumed" | "cancelled" | "waiting_approval" | "waiting_input";

// Gateway client exists
class OpenClawGatewayClient {
  async connect(): Promise<void>
  async rpc<T>(method: string, params?: unknown): Promise<T>
  send(message: GatewayMessage): void
}

// Event bus implemented
class OpenClawEventBus {
  on<K>(event: K, handler: Listener<K>): this
  emit<K>(event: K, data: Events[K]): boolean
}
```

### Gap Analysis

1. **Not Connected:** `OpenClawGatewayClient` exists but isn't used by React hooks
2. **Missing Protocol v3:** Current client uses v1, needs upgrade
3. **No Device Auth:** Missing challenge/response flow
4. **Events Not Subscribed:** Event bus defined but not receiving gateway events

---

## Live/Mock Mode Toggle

**Implementation:** `useUIStore.useLiveGateway`

**Pattern in Hooks:**
```typescript
const useLiveGateway = useUIStore((state) => state.useLiveGateway);
const liveMode = (import.meta.env?.DEV ?? false) && useLiveGateway;

// Query with mode-aware key
return useQuery({
  queryKey: agentKeys.list({ mode: liveMode ? "live" : "mock" }),
  queryFn: () => fetchAgents(liveMode),
});
```

**Behavior:**
- Mock mode: Returns hardcoded mock data after artificial delay
- Live mode: Calls gateway, falls back to mock on error

---

## Critical Missing Pieces

### 1. Gateway Client Upgrade

Current `GatewayClient` needs:
- Protocol v3 support
- Device authentication with WebCrypto
- Challenge/response nonce handling
- Proper scope management

### 2. Event Subscription System

Need to bridge:
- Gateway WebSocket events → React Query cache invalidation
- Gateway events → UI store updates
- Real-time chat streaming

### 3. New Domain APIs

Features with no existing Gateway RPCs:
- **Memories** - CRUD + search
- **Rituals** - CRUD + assignment
- **Workstreams** - DAG + task management
- **Activity logs** - Per-agent/global
- **Usage metrics** - Token counts, costs

### 4. Session Store Integration

`useSessionStore` defines:
```typescript
interface SessionStore {
  activeSessionKeys: Set<string>;
  streamingMessages: Map<string, StreamingMessage>;
  currentRunIds: Map<string, string>;
  pendingMessages: Map<string, PendingMessage[]>;
}
```

Needs connection to:
- `chat` events for streaming
- `agent` events for tool tracking
- Session lifecycle events

---

## Summary Statistics

| Category | Total | Wired | Partial | Unwired |
|----------|-------|-------|---------|---------|
| Routes | 16 | 2 | 5 | 9 |
| Domain Components | 143+ | ~15 | ~30 | ~98 |
| Query Hooks | 15 | 3 | 3 | 9 |
| Mutation Hooks | 11 | 4 | 0 | 7 |
| Stores | 6 | 2 | 2 | 2 |

**Wiring Effort Estimate:**
- **Phase 1 (Core):** Gateway client upgrade, chat/sessions - 3-5 days
- **Phase 2 (Config):** Settings wiring, channels - 2-3 days
- **Phase 3 (Features):** Goals, cron, health - 3-5 days
- **Phase 4 (New APIs):** Memories, rituals, workstreams - 5-10 days (depends on new Gateway RPCs)
