# Agent Prompt: Apps/Web Gateway Wiring Implementation

> **Purpose:** Comprehensive instructions for an agent to wire `apps/web` to the Gateway backend
> **Date:** 2026-02-02
> **Scope:** Full implementation of Gateway client, RPC calls, event subscriptions, and new APIs

---

## Context

You are implementing the backend wiring for `apps/web`, a React-based web UI for the Clawdbrain agent platform. The UI currently runs on mock data but needs to connect to a real Gateway server via WebSocket.

### Key Documents to Read First

1. `apps/web/ux-opus-wiring/01-UI-RPCS-AND-APIS.md` - Complete RPC reference from the working `ui/*` Control UI
2. `apps/web/ux-opus-wiring/02-APPS-WEB-FEATURE-MAP.md` - Maps UI features to backend requirements
3. `apps/web/ux-opus-wiring/03-WIRING-GAME-PLAN.md` - Implementation phases and details
4. `apps/web/ux-opus-wiring/05-GATEWAY-AUTH-MODAL-DESIGN.md` - Auth modal UX design (blocking modal instead of toast spam)

### Reference Implementation

The current working Control UI is in `ui/src/ui/`. Key files to reference:
- `ui/src/ui/gateway.ts` - Browser WebSocket client with Protocol v3 + device auth
- `ui/src/ui/controllers/*.ts` - RPC method implementations
- `ui/src/ui/app-events.ts` - Event handling patterns

### Gateway Protocol Reference

- `src/gateway/protocol/index.ts` - Protocol exports and validators
- `src/gateway/protocol/schema/*.ts` - TypeBox schemas for all RPC params/results
- `src/gateway/device-auth.ts` - Device auth payload builder

---

## Task 1: Upgrade Gateway Client to Protocol v3

### Current State

File: `apps/web/src/lib/api/gateway-client.ts`

The current client uses Protocol v1 (`minProtocol: 1, maxProtocol: 1`) and lacks:
- Device authentication
- Challenge-response flow
- Event frame handling with sequence tracking
- Proper reconnection with token persistence

### Required Changes

1. **Update protocol version:**
```typescript
const connectParams = {
  minProtocol: 3,
  maxProtocol: 3,
  // ... rest
};
```

2. **Create device identity module** (`apps/web/src/lib/api/device-identity.ts`):
   - Generate ECDSA P-256 keypair using `crypto.subtle`
   - Store in IndexedDB
   - Load on startup, create if missing
   - Export: `loadOrCreateDeviceIdentity()`, `signDevicePayload(privateKey, payload)`

3. **Create device auth token storage** (`apps/web/src/lib/api/device-auth.ts`):
   - Store/load device tokens by `{deviceId, role}`
   - Use IndexedDB for persistence
   - Export: `storeDeviceAuthToken()`, `loadDeviceAuthToken()`, `clearDeviceAuthToken()`

4. **Implement challenge-response flow in `gateway-client.ts`:**
```typescript
// After WebSocket opens, queue connect with delay
private queueConnect() {
  this.connectNonce = null;
  this.connectSent = false;
  this.connectTimer = window.setTimeout(() => {
    void this.sendConnect();
  }, 750); // Wait for challenge
}

// Handle connect.challenge event
private handleMessage(raw: string) {
  // ... parse frame
  if (frame.type === "event" && frame.event === "connect.challenge") {
    const nonce = frame.payload?.nonce;
    if (nonce) {
      this.connectNonce = nonce;
      void this.sendConnect();
    }
    return;
  }
  // ... rest
}

// Build and send connect with device auth
private async sendConnect() {
  const isSecureContext = typeof crypto !== "undefined" && !!crypto.subtle;

  if (isSecureContext) {
    const deviceIdentity = await loadOrCreateDeviceIdentity();
    const storedToken = loadDeviceAuthToken({ deviceId: deviceIdentity.deviceId, role: "operator" });

    const payload = buildDeviceAuthPayload({
      deviceId: deviceIdentity.deviceId,
      clientId: "web-ui",
      clientMode: "ui",
      role: "operator",
      scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
      signedAtMs: Date.now(),
      token: storedToken?.token ?? this.config.token,
      nonce: this.connectNonce,
    });

    const signature = await signDevicePayload(deviceIdentity.privateKey, payload);

    // Include device in connect params
    connectParams.device = {
      id: deviceIdentity.deviceId,
      publicKey: deviceIdentity.publicKey,
      signature,
      signedAt: Date.now(),
      nonce: this.connectNonce,
    };
  }

  // Send connect RPC...
}
```

5. **Add event subscription API:**
```typescript
class GatewayClient {
  private eventListeners = new Map<string, Set<EventHandler>>();
  private lastSeq: number | null = null;

  subscribe(event: string, handler: (frame: GatewayEventFrame) => void): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(handler);
    return () => this.eventListeners.get(event)?.delete(handler);
  }

  private dispatchEvent(frame: GatewayEventFrame) {
    // Sequence tracking for gap detection
    if (frame.seq !== undefined) {
      if (this.lastSeq !== null && frame.seq > this.lastSeq + 1) {
        console.warn(`[gateway] event gap: expected ${this.lastSeq + 1}, got ${frame.seq}`);
      }
      this.lastSeq = frame.seq;
    }

    // Dispatch to specific listeners
    this.eventListeners.get(frame.event)?.forEach(h => h(frame));
    // Also dispatch to wildcard listeners
    this.eventListeners.get("*")?.forEach(h => h(frame));
  }
}
```

---

## Task 1.5: Gateway Authentication Modal

### Problem

The current `ui/*` spams toast warnings when auth fails. Users must manually find settings and update credentials. This is a poor UX.

### Solution

Create a **blocking modal** that appears when Gateway auth is required.

### Files to Create

**`apps/web/src/components/composed/GatewayAuthModal.tsx`:**
```tsx
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertCircle, Key, Lock, Loader2 } from "lucide-react";

type GatewayAuthCredentials =
  | { type: "token"; token: string }
  | { type: "password"; password: string };

interface GatewayAuthModalProps {
  open: boolean;
  error?: string;
  gatewayUrl: string;
  onAuthenticate: (auth: GatewayAuthCredentials) => Promise<void>;
}

export function GatewayAuthModal({
  open,
  error,
  gatewayUrl,
  onAuthenticate,
}: GatewayAuthModalProps) {
  const [authMethod, setAuthMethod] = useState<"token" | "password">("token");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsAuthenticating(true);
    setAuthError(null);

    try {
      const credentials: GatewayAuthCredentials =
        authMethod === "token"
          ? { type: "token", token: token.trim() }
          : { type: "password", password };

      await onAuthenticate(credentials);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setIsAuthenticating(false);
    }
  };

  return (
    <Dialog open={open} modal>
      <DialogContent className="sm:max-w-md" hideCloseButton>
        <DialogHeader>
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Key className="h-6 w-6 text-primary" />
          </div>
          <DialogTitle className="text-center">Connect to Gateway</DialogTitle>
          <DialogDescription className="text-center">
            <span className="font-mono text-xs">{gatewayUrl}</span>
          </DialogDescription>
        </DialogHeader>

        {(error || authError) && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{authError || error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Tabs value={authMethod} onValueChange={(v) => setAuthMethod(v as "token" | "password")}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="token">
                <Key className="h-4 w-4 mr-2" />
                Token
              </TabsTrigger>
              <TabsTrigger value="password">
                <Lock className="h-4 w-4 mr-2" />
                Password
              </TabsTrigger>
            </TabsList>

            <TabsContent value="token" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="token">Gateway Token</Label>
                <Input
                  id="token"
                  type="password"
                  placeholder="Paste your gateway token..."
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Get token: <code className="bg-muted px-1 rounded">clawdbrain dashboard --no-open</code>
                </p>
              </div>
            </TabsContent>

            <TabsContent value="password" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password">Gateway Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter gateway password..."
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                />
              </div>
            </TabsContent>
          </Tabs>

          <Button
            type="submit"
            className="w-full"
            disabled={isAuthenticating || (authMethod === "token" ? !token.trim() : !password)}
          >
            {isAuthenticating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Connecting...
              </>
            ) : (
              "Connect"
            )}
          </Button>
        </form>

        {/* Future: OAuth buttons */}
        <div className="text-center text-xs text-muted-foreground pt-4 border-t">
          <p>OAuth sign-in coming soon (Google, GitHub)</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

**`apps/web/src/hooks/useGatewayConnection.ts`:**
```tsx
import { useState, useEffect, useCallback } from "react";
import { getGatewayClient, type GatewayStatus } from "@/lib/api/gateway-client";

type GatewayConnectionState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "auth_required"; error?: string }
  | { status: "connected" }
  | { status: "error"; error: string };

type GatewayAuthCredentials =
  | { type: "token"; token: string }
  | { type: "password"; password: string };

export function useGatewayConnection() {
  const [state, setState] = useState<GatewayConnectionState>({ status: "connecting" });

  useEffect(() => {
    const client = getGatewayClient();

    // Initial connection attempt
    client.connect().catch((err) => {
      const errorMsg = err instanceof Error ? err.message : "Connection failed";
      if (errorMsg.includes("unauthorized") || errorMsg.includes("connect failed")) {
        setState({ status: "auth_required", error: errorMsg });
      } else {
        setState({ status: "error", error: errorMsg });
      }
    });

    // Subscribe to status changes
    const handleStatusChange = (status: GatewayStatus) => {
      switch (status) {
        case "connected":
          setState({ status: "connected" });
          break;
        case "connecting":
          setState({ status: "connecting" });
          break;
        case "disconnected":
          setState({ status: "disconnected" });
          break;
        case "error":
          // Check if auth error
          setState({ status: "auth_required" });
          break;
      }
    };

    // Note: GatewayClient needs to expose onStatusChange
    // This is a simplified version
    return () => {
      // Cleanup
    };
  }, []);

  const authenticate = useCallback(async (credentials: GatewayAuthCredentials) => {
    const client = getGatewayClient();

    // Update client config with new credentials
    if (credentials.type === "token") {
      localStorage.setItem("gateway_token", credentials.token);
      // Note: Need to update GatewayClient to accept runtime credential updates
    }

    setState({ status: "connecting" });

    // Reconnect with new credentials
    client.stop();
    await client.connect();
  }, []);

  return {
    state,
    isConnected: state.status === "connected",
    needsAuth: state.status === "auth_required",
    error: "error" in state ? state.error : undefined,
    authenticate,
  };
}
```

**Update `apps/web/src/App.tsx` or root layout:**
```tsx
import { GatewayAuthModal } from "@/components/composed/GatewayAuthModal";
import { useGatewayConnection } from "@/hooks/useGatewayConnection";

function App() {
  const { state, needsAuth, authenticate } = useGatewayConnection();
  const gatewayUrl = import.meta.env.VITE_GATEWAY_URL ?? "ws://127.0.0.1:18789";

  return (
    <>
      {/* Blocking auth modal */}
      <GatewayAuthModal
        open={needsAuth}
        error={state.status === "auth_required" ? state.error : undefined}
        gatewayUrl={gatewayUrl}
        onAuthenticate={authenticate}
      />

      {/* Main app content */}
      {state.status === "connected" && <RouterProvider router={router} />}
      {state.status === "connecting" && <LoadingScreen message="Connecting to gateway..." />}
      {state.status === "error" && <ErrorScreen error={state.error} />}
    </>
  );
}
```

### GatewayClient Changes Needed

Add to `gateway-client.ts`:
```typescript
class GatewayClient {
  // Add state machine
  private authCredentials: { token?: string; password?: string } = {};

  // Allow runtime credential updates
  setCredentials(credentials: { token?: string; password?: string }) {
    this.authCredentials = credentials;
    if (credentials.token) {
      this.config.token = credentials.token;
    }
  }

  // Detect auth failures in connect
  private handleConnectError(error: Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("unauthorized") || msg.includes("connect failed") || msg.includes("401")) {
      this.setStatus("auth_required"); // New status
    } else {
      this.setStatus("error");
    }
  }
}
```

---

## Task 2: Wire Core Chat & Sessions

### Files to Modify/Create

- `apps/web/src/hooks/queries/useSessions.ts` - Already exists, needs live implementation
- `apps/web/src/hooks/mutations/useChatMutations.ts` - Create new
- `apps/web/src/hooks/useChatEventSubscription.ts` - Wire events to React
- `apps/web/src/stores/useSessionStore.ts` - Add streaming state

### Implementation

**Chat Mutations (`useChatMutations.ts`):**
```typescript
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getGatewayClient } from "@/lib/api/gateway-client";
import { uuidv7 } from "@/lib/ids";
import { sessionKeys } from "./queries/useSessions";

export function useSendMessage(sessionKey: string) {
  const queryClient = useQueryClient();
  const client = getGatewayClient();

  return useMutation({
    mutationFn: async ({ message, attachments }: { message: string; attachments?: Attachment[] }) => {
      const idempotencyKey = uuidv7();

      const result = await client.request<{ ok: boolean; runId?: string }>("chat.send", {
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
    onSuccess: () => {
      // History will be refreshed by chat.final event
    },
  });
}

export function useAbortChat(sessionKey: string) {
  const client = getGatewayClient();

  return useMutation({
    mutationFn: async (runId?: string) => {
      return client.request("chat.abort", { sessionKey, runId });
    },
  });
}
```

**Session Store Updates (`useSessionStore.ts`):**
```typescript
interface StreamingMessage {
  runId: string;
  content: string;
  startedAt: number;
}

interface ToolCallState {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  input?: string;
  output?: string;
  progress?: number;
}

interface SessionStoreState {
  // Existing...
  streamingMessages: Map<string, StreamingMessage>;
  toolCalls: Map<string, ToolCallState[]>;

  // Actions
  startStreaming: (sessionKey: string, runId: string) => void;
  appendStreamingContent: (sessionKey: string, content: string) => void;
  updateToolCall: (sessionKey: string, toolCall: ToolCallState) => void;
  finishStreaming: (sessionKey: string) => void;
}
```

**Chat Event Subscription Hook:**
```typescript
export function useChatEventSubscription(
  sessionKey: string | null,
  handlers: {
    onDelta?: (content: string) => void;
    onFinal?: () => void;
    onToolCall?: (toolCall: ToolCallState) => void;
  }
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!sessionKey) return;

    const client = getGatewayClient();

    const unsubChat = client.subscribe("chat", (frame) => {
      const payload = frame.payload as ChatEventPayload;
      if (payload.sessionKey !== sessionKey) return;

      switch (payload.state) {
        case "delta":
          handlers.onDelta?.(extractText(payload.message));
          break;
        case "final":
          handlers.onFinal?.();
          queryClient.invalidateQueries({ queryKey: sessionKeys.history(sessionKey) });
          break;
      }
    });

    const unsubAgent = client.subscribe("agent", (frame) => {
      const payload = frame.payload as AgentEventPayload;
      if (payload.sessionKey !== sessionKey) return;

      if (payload.toolCallId) {
        handlers.onToolCall?.({
          id: payload.toolCallId,
          name: payload.toolName ?? "unknown",
          status: payload.status as ToolCallState["status"],
          input: payload.input ? JSON.stringify(payload.input) : undefined,
          output: payload.output ? JSON.stringify(payload.output) : undefined,
        });
      }
    });

    return () => {
      unsubChat();
      unsubAgent();
    };
  }, [sessionKey, handlers, queryClient]);
}
```

---

## Task 3: Wire Settings & Configuration

### Files to Create/Modify

- `apps/web/src/hooks/queries/useHealth.ts` - New
- `apps/web/src/hooks/queries/useChannels.ts` - New
- `apps/web/src/hooks/queries/useModels.ts` - Update to use gateway

### Implementation

**Health Hook (`useHealth.ts`):**
```typescript
export function useHealth(options?: { probe?: boolean; enabled?: boolean }) {
  const client = getGatewayClient();

  return useQuery({
    queryKey: ["health", { probe: options?.probe }],
    queryFn: () => client.request<HealthResponse>("health", { probe: options?.probe }),
    refetchInterval: 30000,
    enabled: options?.enabled !== false,
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

**Channels Hook (`useChannels.ts`):**
```typescript
export function useChannelsStatus(options?: { probe?: boolean }) {
  const client = getGatewayClient();

  return useQuery({
    queryKey: ["channels", "status", options],
    queryFn: () => client.request<ChannelsStatusResult>("channels.status", {
      probe: options?.probe ?? false,
    }, { timeout: 8000 }),
    staleTime: 60000,
  });
}

export function useChannelLogout() {
  const queryClient = useQueryClient();
  const client = getGatewayClient();

  return useMutation({
    mutationFn: ({ channel, accountId }: { channel: string; accountId?: string }) =>
      client.request("channels.logout", { channel, accountId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["channels"] });
    },
  });
}
```

---

## Task 4: Wire Feature Domains

### Goals (Overseer)

```typescript
// hooks/queries/useGoals.ts
export function useGoals() {
  const client = getGatewayClient();

  return useQuery({
    queryKey: ["overseer", "status"],
    queryFn: async () => {
      const result = await client.request<OverseerStatusResult>("overseer.status", {});
      return result.goals ?? [];
    },
  });
}

export function useGoal(goalId: string) {
  const client = getGatewayClient();

  return useQuery({
    queryKey: ["overseer", "goal", goalId],
    queryFn: () => client.request<OverseerGoalStatusResult>("overseer.goal.status", { goalId }),
    enabled: !!goalId,
  });
}

// hooks/mutations/useGoalMutations.ts
export function useCreateGoal() {
  const queryClient = useQueryClient();
  const client = getGatewayClient();

  return useMutation({
    mutationFn: (data: { title: string; problemStatement: string; successCriteria: string[] }) =>
      client.request<OverseerGoalCreateResult>("overseer.goal.create", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["overseer"] });
    },
  });
}
```

### Cron Jobs

```typescript
// hooks/queries/useCron.ts
export function useCronJobs(options?: { includeDisabled?: boolean }) {
  const client = getGatewayClient();

  return useQuery({
    queryKey: ["cron", "list", options],
    queryFn: () => client.request<{ jobs: CronJob[] }>("cron.list", {
      includeDisabled: options?.includeDisabled ?? true,
    }),
  });
}

// hooks/mutations/useCronMutations.ts
export function useCreateCronJob() {
  const queryClient = useQueryClient();
  const client = getGatewayClient();

  return useMutation({
    mutationFn: (data: { name: string; schedule: string; payload: unknown; enabled?: boolean }) =>
      client.request("cron.add", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cron"] });
    },
  });
}

export function useRunCronJob() {
  const client = getGatewayClient();

  return useMutation({
    mutationFn: (id: string) =>
      client.request("cron.run", { id, mode: "force" }),
  });
}
```

---

## Task 5: Add New Gateway RPCs (If Needed)

For features that don't map to existing RPCs, you may need to add new Gateway methods.

### Pattern for Adding New RPCs

1. **Define schema** in `src/gateway/protocol/schema/`:
```typescript
// src/gateway/protocol/schema/memories.ts
export const MemorySchema = Type.Object({
  id: NonEmptyString,
  type: Type.Union([
    Type.Literal("note"),
    Type.Literal("document"),
    Type.Literal("conversation"),
  ]),
  title: NonEmptyString,
  content: Type.String(),
  tags: Type.Array(NonEmptyString),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});

export const MemoriesListParamsSchema = Type.Object({
  type: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(NonEmptyString)),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(NonEmptyString),
});

export const MemoriesListResultSchema = Type.Object({
  memories: Type.Array(MemorySchema),
  nextCursor: Type.Optional(NonEmptyString),
});
```

2. **Add to protocol exports** in `src/gateway/protocol/schema.ts`

3. **Implement handler** in `src/gateway/server-methods/`:
```typescript
// src/gateway/server-methods/memories.ts
export function registerMemoriesMethods(server: GatewayServer) {
  server.registerMethod("memories.list", async (params, ctx) => {
    // Implementation
  });

  server.registerMethod("memories.create", async (params, ctx) => {
    // Implementation
  });
}
```

4. **Register in server** at `src/gateway/server-methods-list.ts`

### Potential New RPCs Needed

| Domain | Methods | Notes |
|--------|---------|-------|
| Memories | `memories.list`, `memories.get`, `memories.create`, `memories.update`, `memories.delete`, `memories.search` | May use graph DB |
| Rituals | `rituals.list`, `rituals.create`, `rituals.trigger`, `rituals.assign` | Or map to `cron.*` |
| Workstreams | `workstreams.list`, `workstreams.get`, `workstreams.tasks.*` | Or map to `overseer.*` |
| Activity | `activity.list`, `activity.recent` | May derive from `logs.tail` |
| Usage | `usage.summary`, `usage.byAgent` | Needs telemetry |

---

## Task 6: Remove Mock Mode

Once wiring is complete:

1. Remove `useLiveGateway` toggle from `useUIStore`
2. Remove mock data from all query hooks
3. Remove mock fallbacks in mutation hooks
4. Update tests to use gateway mock/fixtures

---

## Testing Strategy

### Unit Tests

- Test device identity generation/storage
- Test device auth payload building
- Test event subscription/unsubscription

### Integration Tests

- Test full connect flow with mock gateway
- Test chat send → receive delta → receive final flow
- Test reconnection with token persistence

### E2E Tests

- Test real gateway connection
- Test full chat workflow
- Test config changes persist

---

## Success Criteria

- [ ] Gateway connects with Protocol v3
- [ ] **Auth modal appears when authentication is required (no toast spam)**
- [ ] **Auth modal blocks app until successfully authenticated**
- [ ] **Token and password auth both work from modal**
- [ ] Device tokens persist across page reloads
- [ ] Chat messages send and stream correctly
- [ ] Tool calls display during agent execution
- [ ] Session list shows real sessions
- [ ] Health dashboard shows live data
- [ ] Channel status is accurate
- [ ] Goals/cron/skills work end-to-end
- [ ] No console errors in normal operation
- [ ] Reconnection works smoothly after disconnect

---

## Checklist for Implementation

### Phase 1: Gateway Client (Critical Path)
- [ ] Create `device-identity.ts` with WebCrypto keypair management
- [ ] Create `device-auth.ts` with IndexedDB token storage
- [ ] Update `gateway-client.ts` to Protocol v3
- [ ] Implement challenge-response flow
- [ ] Add event subscription API
- [ ] Add sequence tracking
- [ ] Add connection state machine (`connecting`, `connected`, `auth_required`, `error`)

### Phase 1.5: Gateway Auth Modal
- [ ] Create `GatewayAuthModal.tsx` component
- [ ] Create `useGatewayConnection.ts` hook
- [ ] Update GatewayClient with `setCredentials()` and auth state
- [ ] Integrate modal at app root (blocking until authenticated)
- [ ] Token persistence in localStorage
- [ ] Clear error display

### Phase 2: Chat & Sessions
- [ ] Create `useChatMutations.ts`
- [ ] Wire `useSessions.ts` to gateway
- [ ] Wire `useChatHistory` to gateway
- [ ] Create `useChatEventSubscription.ts`
- [ ] Update `useSessionStore.ts` with streaming state
- [ ] Connect `SessionChat` component to hooks

### Phase 3: Settings
- [ ] Create `useHealth.ts`
- [ ] Create `useChannels.ts`
- [ ] Wire `HealthDashboard` component
- [ ] Wire channel config sheets

### Phase 4: Features
- [ ] Wire goals (overseer) hooks
- [ ] Wire cron hooks
- [ ] Wire skills hooks
- [ ] Evaluate/implement new APIs for memories/rituals/workstreams

### Phase 5: Cleanup
- [ ] Remove mock data
- [ ] Remove `useLiveGateway` toggle
- [ ] Update tests
- [ ] Update documentation
