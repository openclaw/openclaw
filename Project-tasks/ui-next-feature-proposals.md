# ui-next — New Feature Proposals (Developer Guide)

These features are **not yet implemented** in ui-next. Each section describes what the feature does, which gateway WebSocket API methods to use, and key implementation notes.

## Technical Implementation Strategy

**Stack:**

- **Framework**: React 19 + Vite
- **State Management**: Zustand (create new slices in `src/store` as needed)
- **Styling**: Tailwind CSS v4 + shadcn/ui components (`src/components/ui`)
- **Icons**: Lucide React
- **Animations**: Framer Motion
- **API Client**: Use `gatewayClient.request(method, params)` via `useGatewayStore`.

---

## 1. Onboard Wizard

**What:** Guided first-time setup — model selection, auth configuration, workspace setup.

**Gateway API:**
| Method | Purpose |
|---|---|
| `wizard.start` | Start a wizard session. Params: `{ mode: "local" | "remote", workspace?: string }`. Returns `sessionId` + first step. |
| `wizard.next` | Advance to next step. Params: `{ sessionId, answer?: { stepId, value } }`. Returns next step or `done: true`. |
| `wizard.cancel` | Cancel a running wizard. Params: `{ sessionId }`. |
| `wizard.status` | Check wizard state. Params: `{ sessionId }`. |

**UI Components:**

- **Container**: `Card` (centered layout) with `Stepper` visualization.
- **Inputs**: `Select` (models), `Input` (strings), `RadioGroup` (selection), `Checkbox` (multiselect).
- **Navigation**: `Button` (Next/Back), `Progress` bar.

**Implementation Plan:**

1. Create `src/store/wizard-store.ts` with Zustand to manage `sessionId`, `currentStep`, `history`.
2. Implement a `WizardStepRenderer` component that switches based on `step.type`.
3. Use `framer-motion` for smooth transitions between steps (`AnimatePresence`).

---

## 2. Auth Manager

**What:** View, add, remove API keys and OAuth profiles. See cooldown/billing status per profile.

**Gateway API:**
| Method | Purpose |
|---|---|
| `config.get` | Read current config including `auth.profiles` (secrets are redacted). |
| `config.patch` | Add/remove entries in `auth.profiles` or `auth.order`. |
| `models.list` | Returns model catalog with provider info. |

**UI Components:**

- **List**: `Table` or `DataList` for profiles.
- **Status**: `Badge` (Active, Rate Limited, Error).
- **Actions**: `Dialog` for adding new keys/profiles.
- **Forms**: `Form` + `Input` for credentials (use `type="password"`).

**Implementation Plan:**

1. Fetch config via `useGatewayStore` (add selector for `auth.profiles`).
2. Create `AuthProfileList` component.
3. Use `DropdownMenu` for actions (Edit, Delete, Test).

---

## 3. Model Fallback Chain Editor

**What:** Set primary model, drag-to-reorder fallback models visually.

**Gateway API:**
| Method | Purpose |
|---|---|
| `models.list` | Get available models to populate the picker. |
| `config.get` | Read current `agents.defaults.model.primary` and `agents.defaults.model.fallbacks`. |
| `config.patch` | Update primary and fallbacks array. |

**UI Components:**

- **Drag & Drop**: Use `framer-motion` (`Reorder.Group`, `Reorder.Item`) for the list.
- **Selection**: `Combobox` (shadcn) for selecting the primary model.
- **List Items**: `Card` (compact) or styled `li` with grab handle icon (`GripVertical`).

**Implementation Plan:**

1. Create `ModelChainEditor` component.
2. Load all models and filter by provider.
3. On drop/reorder, optimistically update UI state, then debounce `config.patch` call.
4. **Example Patch**:
   ```json
   {
     "agents": {
       "defaults": {
         "model": {
           "primary": "google-antigravity/claude-opus-4-6-thinking",
           "fallbacks": ["anthropic/claude-opus-4-6", "openai/gpt-5.1-codex"]
         }
       }
     }
   }
   ```

---

## 4. Plugin Toggle

**What:** Enable/disable bundled plugins with switches.

**Gateway API:**
| Method | Purpose |
|---|---|
| `config.get` | Read `plugins.entries` to see current state. |
| `config.patch` | Toggle `plugins.entries.<pluginName>.enabled`. |

**UI Components:**

- **Control**: `Switch` component.
- **Layout**: `Card` per plugin with title, description, and toggle.

**Implementation Plan:**

1. Create `PluginCard` component.
2. Group plugins by category if metadata allows.
3. Show specific warning via `Alert` or `Toast` if toggling requires restart (Gateway usually restarts automatically).

---

## 5. Update Manager

**What:** Check for and run OpenClaw self-updates.

**Gateway API:**
| Method | Purpose |
|---|---|
| `update.run` | Triggers self-update. Gateway restarts after. |
| `health` | Returns version info to show current version. |

**UI Components:**

- **Status**: Global `Banner` or `Toast` when update is available.
- **Action**: `Button` with loading state (`Loader2` icon).

**Implementation Plan:**

1. Check `health.version` against latest (fetched from GitHub API or provided by Gateway event).
2. On `update.run`, show full-screen overlay "Updating...".
3. Handle disconnection gracefully (Gateway restart).

---

## 6. Memory Dashboard

**What:** Full memory management dashboard with file browsing, semantic search, index health monitoring, and activity tracking. Implemented as a dedicated `/memory` route with 4 sub-tabs.

**Status:** Implemented with dynamic backend adaptation (QMD vs Builtin).

**Gateway API:**
| Method | Purpose |
|---|---|
| `memory.status` | Returns full `MemoryProviderStatus` (backend, provider, model, files, chunks, dirty, sources, vector, FTS, cache, fallback info) + embedding probe result + health boolean. |
| `memory.search` | Semantic search across memory index. Params: `{ query, maxResults?, minScore? }`. Returns `{ results[], provider, backend, model? }`. |
| `memory.reindex` | Force re-index. Calls `manager.sync({ reason: "dashboard", force: true })`. Returns `{ ok, error? }`. |
| `agents.files.list` | List available memory files for the default agent. |
| `agents.files.get` | Read file content. |
| `agents.files.set` | Write file content. |
| `sessions.list` | List recent sessions (for activity log parsing). |
| `chat.history` | Load session messages (to extract memory tool calls for activity log). |

**Sub-tabs:**

### Tab A: Files

- Left panel: file list sorted by date, showing name, size, last modified.
- Right panel: textarea editor with Save/Revert buttons and unsaved changes indicator.
- Data: `agents.files.list` filtered to memory files, `agents.files.get`/`set` for read/write.

### Tab B: Search

- Search input with search history dropdown (persisted to localStorage, max 20).
- Results show snippet, score badge (green >= 0.8, yellow >= 0.5, muted < 0.5), source badge, file link.
- Cross-tab: clicking a result file link switches to Files tab and selects the file.
- Backend badge + search mode badge (builtin shows hybrid/fts-only mode).
- **Backend-adaptive empty states:** distinguishes "no documents indexed" (index empty) vs "no results matched" (query mismatch) using `files` count from search response.

### Tab C: Index Status

- 4-state health badge: Healthy (green), Degraded (yellow, fallback active), Empty (yellow, no content), Unavailable (red).
- Re-index Now button.
- **Backend-adaptive stat cards:**
  - QMD: Documents, Collections (from `status.custom.qmd`), Backend.
  - Builtin: Files, Chunks, Backend.
- Source counts DataTable (builtin only).
- **Backend-adaptive additional info:**
  - QMD: model, vector (always managed by qmd).
  - Builtin: model, vector (sqlite-vec), FTS, cache, batch embedding status.
- Conditional alerts: fallback active (with reason), embedding probe failed, no files/documents indexed.

### Tab D: Activity Log

- Filter buttons: All, Reads, Writes.
- Timeline entries parsed from recent session transcripts: timestamp, operation badge, tool name, file/query, session key.
- "Load more sessions" button for paginated loading.
- Operations tracked: `memory_search`, `memory_get`, `memory_read`, `write`/`edit`/`read` on memory paths.

**Store:** `ui-next/src/store/memory-store.ts` (Zustand)

State shape covers all 4 tabs: files, search, index status, activity log, plus active tab persistence.

**Hook:** `ui-next/src/hooks/use-memory.ts`

Wraps all RPC calls with store updates: `getMemoryStatus`, `searchMemory`, `reindexMemory`, `listMemoryFiles`, `getMemoryFile`, `setMemoryFile`, `loadActivityLog`.

**localStorage keys:**

- `openclaw.memory.searchHistory` — search query history (max 20)
- `openclaw.memory.activeTab` — last active tab

**Files:**

- `src/gateway/server-methods/memory-dashboard.ts` — 3 RPC handlers
- `ui-next/src/store/memory-store.ts` — Zustand store
- `ui-next/src/hooks/use-memory.ts` — RPC hook
- `ui-next/src/pages/memory.tsx` — Page with 4 tabs

---

## 7. Heartbeat Config

**What:** Edit HEARTBEAT.md.

**Gateway API:** Same as #6 — `agents.files.*`.

**UI Components:**

- **Input**: `Textarea` (autosize).
- **Controls**: `Button` (Save), `Switch` (Enable/Disable Heartbeats via `set-heartbeats`).

**Implementation Plan:**

1. Reuse `FileEditor` component from #6 logic.
2. Simple abstraction: `component={HeartbeatEditor}`.

---

## 8. Tool Call Display Mode (Frontend Only)

**What:** Toggle tool call visibility in chat.

**Gateway API:** None.

**UI Components:**

- **Settings**: `RadioGroup` or `Select` in Appearance Settings.
- **Chat Bubble**: Update `ToolResult` component to respect this state.

**Implementation Plan:**

1. Update `ChatStore` (Zustand) with `toolDisplayMode: 'expanded' | 'collapsed' | 'hidden'`.
2. Persist to `localStorage`.
3. Modes:
   - **Expanded**: Show full JSON/Text.
   - **Collapsed**: Show "Ran tool: fetch_data" (clickable).
   - **Hidden**: No visual output (unless error).

---

## General Notes

- **Transport**: All gateway methods are called over the existing WebSocket connection (JSON-RPC).
- **Optimistic Updates**: UI should update immediately where safe, reverting on error.
- **Error Handling**: Use `toast.error()` for API failures.
- **Reconnection**: The `GatewayBrowserClient` handles reconnects; UI should show a small "Connecting..." indicator if `ws.readyState !== OPEN`.

---

## Cross-Cutting Concerns

### Error Recovery & Validation

**Partial Failure Handling:**

- **Wizard (#1)**: If `wizard.next` fails, show inline error, allow retry without losing progress. Store step history in Zustand.
- **Config Changes (#2, #3, #4)**: On `config.patch` rejection, revert optimistic UI update and show specific error (e.g., "Invalid API key format").
- **File Operations (#6, #7)**: Handle write conflicts (file modified externally) with diff view or force-overwrite option.

**Input Validation:**

- **Auth Manager (#2)**: Validate API key format client-side before submission (provider-specific regex patterns).
- **Model Chain Editor (#3)**: Prevent duplicate models in fallback chain; validate model IDs against `models.list` response.
- **File Browser (#6, #7)**: Enforce max file size (e.g., 1MB for SOUL.md); validate Markdown syntax before save.

**Security Enforcement:**

- **File Browser (#6)**: Maintain allowlist in frontend (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `HEARTBEAT.md`, `tools.md`). Reject any `agents.files.list` results not in allowlist.
- **Auth Manager (#2)**: Never log or expose full API keys in console/network inspector; use masked display (`sk-...abc123`).

### WebSocket Event Subscriptions

**Real-Time Updates:**

- **Auth Manager (#2)**: Subscribe to `auth.profile.status` events for rate limit/cooldown changes. Update badge colors live.
- **Update Manager (#5)**: Listen for `update.available` event (pushed by Gateway). Show banner immediately.
- **Plugin Toggle (#4)**: Subscribe to `plugin.state.changed` to reflect restarts or external toggles.

**Event Handler Pattern:**

```typescript
useEffect(() => {
  const unsubscribe = gatewayClient.on("auth.profile.status", (event) => {
    updateProfileStatus(event.profileId, event.status);
  });
  return unsubscribe;
}, []);
```

### UX States & Accessibility

**Loading & Empty States:**

- **All Lists**: Show skeleton loaders during initial fetch. Display empty state with "Add First Item" CTA.
- **File Browser (#6)**: Show "No files in workspace" with setup instructions if `agents.files.list` returns empty.
- **Model Chain Editor (#3)**: Disable drag handles during `config.patch` request.

**Accessibility:**

- **Drag & Drop (#3)**: Provide keyboard alternative (Up/Down arrows + Ctrl+Shift to reorder). Announce position changes to screen readers.
- **Wizard (#1)**: Use `aria-live` regions for step transitions. Ensure focus management on Next/Back.
- **All Forms**: Proper `label` associations, error announcements, focus trapping in dialogs.

### Persistence & State Management

**LocalStorage Strategy:**

- **UI Preferences**: `toolDisplayMode` (#8), panel sizes (#6), theme, last-selected model.
- **Draft State**: Auto-save file edits (#6, #7) to localStorage every 5s. Restore on reload with "Resume Editing?" prompt.
- **Wizard Progress (#1)**: Persist `sessionId` and step index to allow browser refresh without losing progress.

**Zustand Slices:**

- `wizard-store.ts`: Session state, step history.
- `auth-store.ts`: Profile list, status cache.
- `config-store.ts`: Centralized config cache with patch queue.
- `ui-store.ts`: Preferences, panel states, modals.

### Rollback & Undo

**Config History:**

- **Implementation**: Store last 5 config snapshots in `config-store` (timestamp + diff).
- **UI**: Add "Undo Last Change" button in Settings header (disabled if no history).
- **API**: Call `config.patch` with previous snapshot on undo.

**File Edits (#6, #7):**

- Implement Ctrl+Z / Cmd+Z in editor (use CodeMirror's built-in undo stack).
- Show "Revert to Saved" button if unsaved changes exist.

### Update Manager Edge Cases (#5)

**Restart Flow:**

- **Timeout**: If Gateway doesn't reconnect within 60s, show "Update may have failed. Check logs or restart manually."
- **Version Mismatch**: After reconnect, compare `health.version` to expected version. Show warning if mismatch.
- **Failed Update**: If `update.run` returns error, display full error message with "Retry" and "Report Issue" buttons.

**Reconnection Strategy:**

- Exponential backoff: 1s, 2s, 4s, 8s, then every 10s.
- Show progress: "Reconnecting... (attempt 3/10)".

### Plugin Metadata (#4)

**Schema Assumption:**

```typescript
interface PluginEntry {
  enabled: boolean;
  name: string;
  description?: string;
  category?: "messaging" | "tools" | "integrations";
  requiresRestart?: boolean;
}
```

**Fallbacks:**

- If `description` missing, show plugin name only.
- If `category` missing, group under "Other".
- If `requiresRestart` undefined, assume `true` and show warning.

### Error Boundaries

**Component-Level:**

- Wrap each feature (#1-#8) in `ErrorBoundary` with fallback UI: "This feature encountered an error. [Reload Feature]".
- Log errors to console + optional telemetry (if user opted in).

**Global:**

- Top-level boundary catches catastrophic failures. Show "Something went wrong. [Reload Page]" with error ID.
