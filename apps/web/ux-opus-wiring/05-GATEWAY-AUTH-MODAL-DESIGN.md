# Gateway Authentication Modal Design

> **Date:** 2026-02-02
> **Problem:** The current `ui/*` spams toast warnings when auth fails, requiring users to manually find and update credentials. This is a poor UX.
> **Solution:** A blocking modal that appears when Gateway auth is required, with clear options for Token, Password, and future OAuth.

---

## Current State (ui/*)

The current Control UI handles auth failures poorly:
1. WebSocket connects → auth fails → `connect failed` error
2. Toast warning appears in bottom-right (often missed)
3. User must manually navigate to settings and update token/password
4. Reconnection attempts spam more warnings
5. No clear path to resolution

---

## Proposed Design

### Authentication Flow

```
App Start
    │
    ▼
Gateway Connect Attempt
    │
    ├── Success → App Ready
    │
    └── Auth Failure (401/connect failed)
            │
            ▼
    Show GatewayAuthModal (blocking)
            │
            ├── Token Auth → Enter token → Retry connect
            │
            ├── Password Auth → Enter password → Retry connect
            │
            └── Future: OAuth → Redirect to provider → Callback → Retry connect
```

### GatewayAuthModal Component

**File:** `apps/web/src/components/composed/GatewayAuthModal.tsx`

```tsx
interface GatewayAuthModalProps {
  open: boolean;
  error?: string;
  gatewayUrl: string;
  onAuthenticate: (auth: GatewayAuthCredentials) => Promise<void>;
  onCancel?: () => void; // Only shown if already authenticated once
}

type GatewayAuthCredentials =
  | { type: "token"; token: string }
  | { type: "password"; password: string }
  | { type: "oauth"; provider: "google" | "github"; accessToken: string };

export function GatewayAuthModal({
  open,
  error,
  gatewayUrl,
  onAuthenticate,
  onCancel,
}: GatewayAuthModalProps) {
  const [authMethod, setAuthMethod] = useState<"token" | "password">("token");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // ... implementation
}
```

### UI Layout

```
┌─────────────────────────────────────────────┐
│                    🔐                        │
│                                             │
│        Connect to Gateway                   │
│                                             │
│   ┌─────────────────────────────────────┐   │
│   │ Gateway: ws://127.0.0.1:18789       │   │
│   └─────────────────────────────────────┘   │
│                                             │
│   ⚠ Authentication required                 │
│   (or: Connection failed: unauthorized)     │
│                                             │
│   ┌──────────┐  ┌──────────┐               │
│   │  Token   │  │ Password │               │
│   └──────────┘  └──────────┘               │
│                                             │
│   ┌─────────────────────────────────────┐   │
│   │ Enter your gateway token...         │   │
│   └─────────────────────────────────────┘   │
│                                             │
│   💡 Get token: clawdbrain dashboard --no-open │
│                                             │
│   ┌─────────────────────────────────────┐   │
│   │           Connect                    │   │
│   └─────────────────────────────────────┘   │
│                                             │
│   ─────────── or continue with ───────────  │
│                                             │
│   ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│   │ Google  │  │ GitHub  │  │  More   │    │
│   └─────────┘  └─────────┘  └─────────┘    │
│   (coming soon)                            │
│                                             │
└─────────────────────────────────────────────┘
```

---

## Integration with GatewayClient

### State Machine

```typescript
type GatewayConnectionState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "auth_required"; error?: string }
  | { status: "connected" }
  | { status: "error"; error: string };
```

### Updated GatewayClient

```typescript
class GatewayClient {
  private connectionState: GatewayConnectionState = { status: "disconnected" };
  private authCredentials: GatewayAuthCredentials | null = null;
  private stateListeners = new Set<(state: GatewayConnectionState) => void>();

  // Called when auth fails
  private handleAuthFailure(error: string) {
    this.connectionState = { status: "auth_required", error };
    this.notifyStateChange();
    // Don't auto-reconnect when auth fails
  }

  // Called from auth modal
  setAuthCredentials(credentials: GatewayAuthCredentials) {
    this.authCredentials = credentials;
    // Store in memory (and optionally localStorage for token)
    if (credentials.type === "token") {
      localStorage.setItem("gateway_token", credentials.token);
    }
  }

  retryConnect() {
    this.connectionState = { status: "connecting" };
    this.notifyStateChange();
    this.doConnect();
  }

  // Subscribe to state changes for React
  onStateChange(listener: (state: GatewayConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
}
```

### React Hook

```typescript
// hooks/useGatewayConnection.ts
export function useGatewayConnection() {
  const [state, setState] = useState<GatewayConnectionState>(
    getGatewayClient().getConnectionState()
  );

  useEffect(() => {
    const client = getGatewayClient();
    return client.onStateChange(setState);
  }, []);

  const authenticate = useCallback(async (credentials: GatewayAuthCredentials) => {
    const client = getGatewayClient();
    client.setAuthCredentials(credentials);
    client.retryConnect();

    // Wait for connection or failure
    return new Promise<void>((resolve, reject) => {
      const unsub = client.onStateChange((newState) => {
        if (newState.status === "connected") {
          unsub();
          resolve();
        } else if (newState.status === "auth_required" || newState.status === "error") {
          unsub();
          reject(new Error(newState.error ?? "Connection failed"));
        }
      });
    });
  }, []);

  return {
    state,
    isConnected: state.status === "connected",
    needsAuth: state.status === "auth_required",
    authenticate,
  };
}
```

### App Root Integration

```tsx
// In App.tsx or root layout
function App() {
  const { state, needsAuth, authenticate } = useGatewayConnection();
  const gatewayUrl = useGatewayUrl();

  return (
    <>
      <GatewayAuthModal
        open={needsAuth}
        error={state.status === "auth_required" ? state.error : undefined}
        gatewayUrl={gatewayUrl}
        onAuthenticate={authenticate}
      />

      {/* Only render app when connected or connecting */}
      {state.status === "connected" && <RouterProvider router={router} />}
      {state.status === "connecting" && <LoadingScreen />}
      {state.status === "error" && <ErrorScreen error={state.error} />}
    </>
  );
}
```

---

## Token Persistence

### Storage Strategy

1. **Device Token** (from device auth) → IndexedDB (keyed by deviceId)
2. **Shared Token** (user-entered) → localStorage `gateway_token`
3. **Password** → Never stored (entered each session)
4. **OAuth Tokens** → localStorage with expiry check

### Initial Connection Flow

```typescript
async function getInitialAuth(): Promise<GatewayAuthCredentials | null> {
  // 1. Check for device token
  const deviceIdentity = await loadDeviceIdentity();
  if (deviceIdentity) {
    const deviceToken = loadDeviceAuthToken(deviceIdentity.deviceId);
    if (deviceToken) {
      return { type: "token", token: deviceToken.token };
    }
  }

  // 2. Check for stored shared token
  const storedToken = localStorage.getItem("gateway_token");
  if (storedToken) {
    return { type: "token", token: storedToken };
  }

  // 3. No stored credentials - will need auth modal
  return null;
}
```

---

## Future: OAuth Integration

### OAuth Flow Architecture

```
User clicks "Continue with Google"
    │
    ▼
Redirect to Gateway OAuth endpoint
    │  GET /auth/oauth/google/start?redirect_uri=...
    │
    ▼
Gateway redirects to Google OAuth
    │
    ▼
User authorizes
    │
    ▼
Google redirects back to Gateway
    │  GET /auth/oauth/google/callback?code=...
    │
    ▼
Gateway exchanges code for tokens, creates session
    │
    ▼
Gateway redirects to web app with session token
    │  GET /auth/callback?token=...
    │
    ▼
Web app stores token, connects WebSocket
```

### Required Gateway Changes for OAuth

1. **New HTTP endpoints:**
   - `GET /auth/oauth/{provider}/start` - Initiate OAuth flow
   - `GET /auth/oauth/{provider}/callback` - Handle OAuth callback
   - `GET /auth/oauth/providers` - List enabled OAuth providers

2. **New config options:**
   ```yaml
   gateway:
     auth:
       oauth:
         google:
           enabled: true
           clientId: "..."
           clientSecret: "..."
         github:
           enabled: true
           clientId: "..."
           clientSecret: "..."
   ```

3. **Session token issuance:**
   - After OAuth success, Gateway issues a session token
   - Token can be used for WebSocket auth same as manual token

### UI for OAuth

```tsx
function OAuthButtons({ providers, onSelect }: OAuthButtonsProps) {
  return (
    <div className="space-y-2">
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <Separator />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">
            or continue with
          </span>
        </div>
      </div>

      <div className="flex gap-2 justify-center">
        {providers.includes("google") && (
          <Button variant="outline" onClick={() => onSelect("google")}>
            <GoogleIcon className="h-4 w-4 mr-2" />
            Google
          </Button>
        )}
        {providers.includes("github") && (
          <Button variant="outline" onClick={() => onSelect("github")}>
            <GithubIcon className="h-4 w-4 mr-2" />
            GitHub
          </Button>
        )}
      </div>
    </div>
  );
}
```

### OAuth Not Yet Available Placeholder

Until OAuth is implemented:

```tsx
<div className="text-center text-sm text-muted-foreground mt-4">
  <p>OAuth sign-in coming soon</p>
  <p className="text-xs">Google, GitHub, and more</p>
</div>
```

---

## Error States

### Error Messages

| Error Code | User Message |
|------------|--------------|
| `unauthorized` | "Invalid token or password. Please check your credentials." |
| `token_expired` | "Your session has expired. Please sign in again." |
| `connect_failed` | "Could not connect to gateway. Is it running?" |
| `network_error` | "Network error. Check your connection." |
| `protocol_mismatch` | "Gateway version mismatch. Please update." |

### Retry Logic

- Auth failures: **No auto-retry**, show modal
- Network errors: Auto-retry with backoff (existing behavior)
- Token expiry: Clear token, show modal

---

## Implementation Checklist

### Phase 1: Basic Token/Password Auth Modal
- [ ] Create `GatewayAuthModal` component
- [ ] Add `GatewayConnectionState` to client
- [ ] Create `useGatewayConnection` hook
- [ ] Integrate modal at app root
- [ ] Token persistence in localStorage
- [ ] Clear error handling

### Phase 2: Polish
- [ ] Remember auth method preference
- [ ] "Show password" toggle
- [ ] Copy token from clipboard button
- [ ] Gateway URL display/edit (for remote gateways)
- [ ] Connection timeout handling

### Phase 3: OAuth (Future)
- [ ] Add OAuth endpoints to Gateway
- [ ] Create OAuth callback route
- [ ] Add provider buttons to modal
- [ ] Token refresh handling
- [ ] Account linking

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `apps/web/src/components/composed/GatewayAuthModal.tsx` | Create |
| `apps/web/src/hooks/useGatewayConnection.ts` | Create |
| `apps/web/src/lib/api/gateway-client.ts` | Modify (add state machine) |
| `apps/web/src/App.tsx` or root layout | Modify (add modal) |
| `apps/web/src/lib/api/auth-storage.ts` | Create (token persistence) |

---

## Relationship to App Lock

**App Lock** (`features/security/`) and **Gateway Auth** are separate concerns:

| Feature | Purpose | Storage | Blocking |
|---------|---------|---------|----------|
| App Lock | Protect local device access | Local encrypted storage | Yes, full screen |
| Gateway Auth | Authenticate with server | Token in localStorage/IndexedDB | Yes, modal |

They can work together:
1. User unlocks app (App Lock)
2. App attempts Gateway connection
3. If auth needed, show Gateway Auth modal
4. Once both pass, app is fully usable

---

## Security Considerations

1. **Token Storage:** localStorage is accessible to JS - acceptable for session tokens, not for long-term secrets
2. **Password:** Never stored, always re-entered
3. **HTTPS:** Device auth requires secure context; warn if using HTTP
4. **Token Rotation:** Respect `deviceToken` from server, update stored token
5. **Logout:** Clear all stored tokens and disconnect
