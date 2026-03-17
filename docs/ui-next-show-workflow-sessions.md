# Hiển Thị Workflow Sessions Trong Chat UI-Next

## 🎯 Vấn Đề

Workflow sessions **KHÔNG hiển thị** trong `/chat` của UI-next mặc dù đã chạy thành công.

### Root Cause Analysis

1. **Session Key Format:**

   ```
   agent:main:workflow:030f9921-7834-47d0-a9c1-8c16a0d08594:1773719902534:1773719902545:2
   agent:main:workflow:030f9921-7834-47d0-a9c1-8c16a0d08594:1773719902534:main
   ```

2. **Backend Filter Logic:**

   ```typescript
   // src/gateway/session-utils.ts:742
   if (isCronRunSessionKey(key)) {
     return false; // Filter out cron run sessions
   }
   ```

3. **Pattern Check:**

   ```typescript
   // src/sessions/session-key-utils.ts:59
   export function isCronRunSessionKey(sessionKey: string | undefined | null): boolean {
     const parsed = parseAgentSessionKey(sessionKey);
     if (!parsed) {
       return false;
     }
     return /^cron:[^:]+:run:[^:]+$/.test(parsed.rest);
   }
   ```

4. **Kết luận:**
   - Workflow sessions: `agent:main:workflow:...` ❌ **KHÔNG match** pattern `cron:*:run:*`
   - → **KHÔNG bị filter** bởi backend
   - → **Vấn đề nằm ở UI-next** không load hoặc không hiển thị

## ✅ Solutions

### **Solution 1: UI-Next Chat Page - Load All Sessions**

**File:** `ui-next/app/chat/page.tsx`

**Current Code:**

```typescript
const loadSessions = useCallback(async () => {
  if (state !== "connected") {
    return;
  }

  try {
    const res = await request<SessionsListResult>("sessions.list", {});
    setSessions(res.sessions ?? []);
    // Auto-select first session if none selected
    if (!selectedSessionKey && res.sessions?.length) {
      setSelectedSessionKey(res.sessions[0].key);
    }
  } catch (err) {
    console.error("Failed to load sessions:", err);
  }
}, [state, request, selectedSessionKey]);
```

**Issue:** Không có filter, nhưng có thể UI đang sort/filter ở chỗ khác

**Fix:** Add explicit include for workflow sessions

```typescript
const loadSessions = useCallback(async () => {
  if (state !== "connected") {
    return;
  }

  try {
    // Request ALL sessions including workflow/cron sessions
    const res = await request<SessionsListResult>("sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      // NEW: Explicitly include workflow sessions
      includeWorkflow: true, // Need to add this param to backend
    });

    // Filter to show only relevant sessions
    const visibleSessions = (res.sessions ?? []).filter((session) => {
      // Always show non-cron sessions
      if (!isCronSessionKey(session.key)) {
        return true;
      }
      // Show cron sessions that have recent activity
      const recentMs = 24 * 60 * 60 * 1000; // 24 hours
      return session.entry?.updatedAt && Date.now() - session.entry.updatedAt < recentMs;
    });

    setSessions(visibleSessions);

    if (!selectedSessionKey && visibleSessions.length) {
      setSelectedSessionKey(visibleSessions[0].key);
    }
  } catch (err) {
    console.error("Failed to load sessions:", err);
  }
}, [state, request, selectedSessionKey]);
```

### **Solution 2: Add Session Type Badge**

**File:** `ui-next/app/chat/page.tsx` (session list rendering)

Add badge to identify workflow sessions:

```typescript
function getSessionBadge(session: GatewaySessionRow) {
  const key = session.key.toLowerCase();

  if (key.includes(":workflow:")) {
    return {
      icon: "⚙️",
      label: "Workflow",
      color: "blue",
    };
  }

  if (key.includes(":cron:")) {
    return {
      icon: "⏰",
      label: "Cron",
      color: "orange",
    };
  }

  if (key.includes(":subagent:")) {
    return {
      icon: "🤖",
      label: "Subagent",
      color: "purple",
    };
  }

  return null;
}

// In session list rendering:
{sessions.map(session => {
  const badge = getSessionBadge(session);
  return (
    <div key={session.key} className="session-item">
      <span>{session.entry?.label || "Untitled"}</span>
      {badge && (
        <span className={`badge badge-${badge.color}`}>
          {badge.icon} {badge.label}
        </span>
      )}
    </div>
  );
})}
```

### **Solution 3: Backend - Add Workflow Session Filter**

**File:** `src/gateway/server-methods/sessions.ts`

Add new parameter to `sessions.list`:

```typescript
"sessions.list": ({ params, respond }) => {
  if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
    return;
  }
  const p = params as SessionsListParams & {
    includeWorkflow?: boolean;
    includeCron?: boolean;
  };

  const cfg = loadConfig();
  const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);

  // Modify filter logic
  const result = listSessionsFromStore({
    cfg,
    storePath,
    store,
    opts: {
      ...p,
      // NEW: Include workflow sessions by default
      includeWorkflow: p.includeWorkflow ?? true,
      includeCron: p.includeCron ?? false,
    },
  });

  respond(true, result, undefined);
},
```

**File:** `src/gateway/session-utils.ts`

Update filter logic:

```typescript
export function listSessionsFromStore(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  opts: SessionsListParams & {
    includeWorkflow?: boolean;
    includeCron?: boolean;
  };
}): SessionsListResult {
  const { cfg, storePath, store, opts } = params;
  const now = Date.now();

  const includeWorkflow = opts.includeWorkflow ?? true; // NEW
  const includeCron = opts.includeCron ?? false;

  let sessions = Object.entries(store).filter(([key]) => {
    // Filter cron run sessions (keep cron main sessions)
    if (isCronRunSessionKey(key)) {
      return includeCron; // NEW: Configurable
    }

    // NEW: Filter workflow sessions
    if (key.includes(":workflow:") && !includeWorkflow) {
      return false;
    }

    // ... existing filters ...
  });
  // ... rest of the logic ...
}
```

### **Solution 4: Quick Fix - Show All Sessions**

**Simplest fix** - Remove workflow session filter entirely:

**File:** `src/gateway/session-utils.ts:742`

**Change:**

```typescript
// OLD: Filter out cron run sessions
if (isCronRunSessionKey(key)) {
  return false;
}

// NEW: Comment out or remove
// if (isCronRunSessionKey(key)) {
//   return false;
// }
```

⚠️ **Warning:** This will show ALL cron run sessions, which might clutter the UI.

## 🎨 UI Improvements

### **Session List with Badges**

```typescript
// ui-next/components/session-list.tsx
interface SessionBadge {
  type: "workflow" | "cron" | "subagent" | "acp" | "normal";
  icon: string;
  label: string;
  color: string;
}

function classifySession(sessionKey: string): SessionBadge {
  const key = sessionKey.toLowerCase();

  if (key.includes(":workflow:")) {
    return {
      type: "workflow",
      icon: "⚙️",
      label: "Workflow",
      color: "bg-blue-100 text-blue-800",
    };
  }

  if (key.includes(":cron:")) {
    return {
      type: "cron",
      icon: "⏰",
      label: "Cron",
      color: "bg-orange-100 text-orange-800",
    };
  }

  if (key.includes(":subagent:")) {
    return {
      type: "subagent",
      icon: "🤖",
      label: "Subagent",
      color: "bg-purple-100 text-purple-800",
    };
  }

  return {
    type: "normal",
    icon: "💬",
    label: "Chat",
    color: "bg-gray-100 text-gray-800",
  };
}

export function SessionList({ sessions, onSelect }: SessionListProps) {
  return (
    <div className="space-y-1">
      {sessions.map(session => {
        const badge = classifySession(session.key);
        const lastActive = session.entry?.updatedAt
          ? new Date(session.entry.updatedAt).toLocaleString()
          : "Unknown";

        return (
          <button
            key={session.key}
            onClick={() => onSelect(session.key)}
            className="w-full flex items-center justify-between p-3 hover:bg-gray-50 rounded-lg transition-colors"
          >
            <div className="flex items-center space-x-3">
              <span className="text-lg">{badge.icon}</span>
              <div className="text-left">
                <div className="font-medium text-gray-900">
                  {session.entry?.label || "Untitled Session"}
                </div>
                <div className="text-xs text-gray-500">
                  {lastActive}
                </div>
              </div>
            </div>
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${badge.color}`}>
              {badge.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
```

### **Filter Toggle**

Add toggle to show/hide workflow sessions:

```typescript
// ui-next/app/chat/page.tsx
const [showWorkflowSessions, setShowWorkflowSessions] = useState(true);

const filteredSessions = sessions.filter(session => {
  if (!showWorkflowSessions && session.key.includes(":workflow:")) {
    return false;
  }
  return true;
});

// In UI:
<div className="flex items-center space-x-2 mb-4">
  <label className="flex items-center space-x-2">
    <input
      type="checkbox"
      checked={showWorkflowSessions}
      onChange={(e) => setShowWorkflowSessions(e.target.checked)}
      className="rounded border-gray-300"
    />
    <span className="text-sm text-gray-600">Show Workflow Sessions</span>
  </label>
  <span className="text-xs text-gray-400">
    ({filteredSessions.length} / {sessions.length} sessions)
  </span>
</div>
```

## 🧪 Testing

### **Test Workflow Session Visibility**

1. **Run workflow:**

   ```bash
   openclaw cron run <workflow-job-id>
   ```

2. **Check session created:**

   ```bash
   pnpm tsx scripts/debug-workflow-sessions.ts
   ```

3. **Open UI-next chat:**

   ```
   http://localhost:3000/chat
   ```

4. **Verify:**
   - ✅ Session appears in list
   - ✅ Badge shows "⚙️ Workflow"
   - ✅ Click to open chat
   - ✅ Messages visible

### **Expected Session Keys**

After running workflow, should see sessions like:

```
agent:main:workflow:030f9921-7834-47d0-a9c1-8c16a0d08594:1773719902534:main
agent:main:workflow:030f9921-7834-47d0-a9c1-8c16a0d08594:1773719902534:1773719902545:2
```

## 📝 Implementation Checklist

- [ ] **Backend:** Update `sessions.list` to include workflow sessions
- [ ] **Backend:** Add `includeWorkflow` parameter
- [ ] **UI:** Add session classification function
- [ ] **UI:** Add badges for workflow sessions
- [ ] **UI:** Add filter toggle
- [ ] **UI:** Test with real workflow execution
- [ ] **Docs:** Update workflow debugging guide

## 🔗 Related Files

- Backend: `src/gateway/server-methods/sessions.ts`
- Backend: `src/gateway/session-utils.ts`
- Backend: `src/sessions/session-key-utils.ts`
- UI: `ui-next/app/chat/page.tsx`
- UI: `ui-next/components/session-list.tsx` (create new)
