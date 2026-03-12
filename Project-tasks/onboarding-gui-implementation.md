# Operator1 GUI Onboarding — Implementation Guide

**Created:** 2026-03-12
**Author:** Operator1 (COO)
**Status:** Implementation Guide
**Reference:** [paperclipai/paperclip](https://github.com/paperclipai/paperclip) — onboarding wizard patterns
**Depends on:** SQLite consolidation (Phase 0–3 landed), ui-next control panel, existing `wizard.*` RPC system

---

## 1. Goal

Build a guided, step-by-step onboarding wizard in `ui-next` that takes a fresh Operator1 installation from zero to fully operational — gateway connected, providers configured, agents activated, first message sent. No terminal required.

**Success criteria:** A user who has never used Operator1 can complete setup entirely through the browser UI.

**Non-goal:** Force existing installs through the wizard. Auto-detect and skip (see §3.0).

---

## 2. Stack Comparison — Paperclip vs Operator1

| Layer         | Paperclip                    | Operator1                                        | Notes                              |
| ------------- | ---------------------------- | ------------------------------------------------ | ---------------------------------- |
| Frontend      | React 19, Vite 6, shadcn/ui  | React 19, Vite, shadcn/ui                        | ✅ identical — components portable |
| Icons         | Lucide React                 | Lucide React                                     | ✅ identical                       |
| Routing       | React Router                 | React Router                                     | ✅ identical                       |
| State         | React Query v5               | Custom hooks + `sendRpc()` via `useGatewayStore` | ⚠️ different but compatible        |
| Backend       | Express + PostgreSQL         | OpenClaw Gateway (WebSocket RPC)                 | ❌ different                       |
| Storage       | PostgreSQL (Drizzle ORM)     | SQLite (`operator1.db`, `node:sqlite`)           | ❌ different engine, same role     |
| Auth          | Session cookies + BetterAuth | Gateway auth (API key / web login)               | ❌ different                       |
| Agent runtime | Heartbeat polling + adapters | Pi sessions + ACP backend                        | ❌ different model                 |

**What to borrow from Paperclip:**

- Wizard shell + step navigation patterns
- Live environment probe during setup
- Progressive disclosure (hide advanced options until relevant)
- Two-column layout (form left, context/animation right)
- Keyboard shortcuts (Ctrl+Enter to advance)
- Pre-populated first task template
- Dirty state tracking in edit mode

**What to build fresh:**

- All RPC integration (Gateway WebSocket, not REST)
- SQLite state persistence (not PostgreSQL)
- Matrix agent hierarchy setup (not generic adapter config)
- Channel configuration (Telegram, Discord, etc. — Operator1-specific)

---

## 3. Onboarding Steps — Detailed Design

### Step 0: Resume & Migration Detection (Pre-check)

Before rendering any step, the wizard runs a pre-check:

```typescript
// onboarding-wizard.tsx — on mount
// Uses sendRpc from useGatewayStore (see ui-next/src/hooks/use-chat.ts for pattern)
async function initWizard(sendRpc: SendRpc) {
  let onboardingState: { status: string; currentStep: number } | null = null;

  try {
    onboardingState = await sendRpc("onboarding.status");
  } catch {
    // Gateway not reachable yet, or op1_onboarding table empty (fresh install).
    // Fall through to fresh mode — Step 1 will handle gateway connection.
    return { mode: "fresh", step: 1 };
  }

  // 1. Resume: if browser crashed mid-wizard, offer to continue
  if (onboardingState.status === "in_progress" && onboardingState.currentStep > 1) {
    // Show: "Continue from Step X?" with Resume / Start Over buttons
    return { mode: "resume", step: onboardingState.currentStep };
  }

  // 2. Migration detection: skip wizard for already-configured installs
  try {
    const config = await sendRpc("config.get");
    const isAlreadyConfigured =
      hasProvider(config) && // at least one API key set
      hasActiveAgents(config) && // agents loaded and running
      hasChannels(config); // at least one channel configured

    if (isAlreadyConfigured && onboardingState.status === "pending") {
      // Show: "Your system is already configured. [Import Current Config] [Run Setup Anyway]"
      return { mode: "import", config };
    }
  } catch {
    // config.get failed — gateway may have just connected. Proceed fresh.
  }

  return { mode: "fresh", step: 1 };
}
```

**Import Current Config:** For existing installs, pre-populate the Step 6 summary with actual gateway state and mark onboarding as complete — no need to re-enter anything.

---

### Step 1: Gateway Connection

**Purpose:** Detect and connect to the running OpenClaw gateway.

**UI:**

```
┌─────────────────────────────────┬──────────────────────────────┐
│                                 │                              │
│  Gateway Connection             │   ┌──────────────────────┐  │
│                                 │   │  ● Gateway detected  │  │
│  Host: [localhost:18789    ]    │   │  Version: v2026.3.11 │  │
│                                 │   │  Uptime: 4h 23m      │  │
│  [🔍 Auto-detect]              │   │  Channels: 3 active  │  │
│                                 │   │  Agents: 34 loaded   │  │
│  Status: ● Connected           │   └──────────────────────┘  │
│  Version: v2026.3.11           │                              │
│                                 │   If not detected:          │
│  [Continue →]                   │   Show terminal command      │
│                                 │   to start gateway           │
└─────────────────────────────────┴──────────────────────────────┘
```

**RPC calls:**

- `gateway.status` — check if gateway is running
- `config.get` — read current configuration

**Live probe:** Auto-detect gateway on `localhost:18789`. If not found, show startup instructions. Re-probe every 3 seconds until connected.

**Multi-gateway:** If multiple gateways are detected (e.g. Sati on `:19789`, Link on `:20789`), show a gateway selector dropdown. For v1, scope to single-gateway and document the limitation — multi-gateway selection is Phase D polish.

**SQLite:** Save `onboarding_state` to `op1_onboarding` table (step, completed_at, config snapshot).

**Data collected:**

```typescript
{
  gatewayHost: string; // "localhost:18789"
  gatewayVersion: string; // "2026.3.11"
  isConnected: boolean;
}
```

---

### Step 2: AI Provider Setup

**Purpose:** Configure at least one AI provider with a valid API key.

**UI:**

```
┌─────────────────────────────────┬──────────────────────────────┐
│                                 │                              │
│  AI Provider                    │  Supported Providers:        │
│                                 │                              │
│  Provider: [Anthropic    ▼]     │  ● Anthropic (Claude)       │
│                                 │  ○ Google (Gemini)          │
│  API Key:  [sk-ant-•••••• ]     │  ○ OpenAI (GPT)             │
│                                 │  ○ AWS Bedrock              │
│  Model:    [claude-sonnet ▼]    │  ○ Google Vertex            │
│                                 │  ○ OpenRouter               │
│  [🧪 Test Connection]          │  ○ Ollama (local)           │
│                                 │                              │
│  Status: ✅ Connected           │  Tip: You can add more      │
│  Response: 0.8s                 │  providers later in Config.  │
│                                 │                              │
│  [← Back]  [Continue →]        │                              │
└─────────────────────────────────┴──────────────────────────────┘
```

**RPC calls:**

- `models.list` — load available providers/models
- `config.patch` — save provider API key
- Custom test call — send a minimal prompt to validate the key works

**Live probe:** "Test Connection" sends a 1-token prompt, measures latency, confirms auth works. Show clear pass/fail.

**Ollama branch:** If user selects Ollama (local), skip API key field. Instead show an "Ollama Status" probe that checks `http://localhost:11434/api/tags` to verify Ollama is running and list available models. If Ollama is not running, show install/start instructions.

**Error recovery:** If API key test fails 3 times, show: "Key may be invalid or provider may be down. [Try Again] [Skip for Now] [Enter Different Key]". Skipped steps get a warning badge in the progress bar.

**Data collected:**

```typescript
{
  provider: string; // "anthropic"
  apiKey: string; // stored in gateway credentials
  model: string; // "claude-sonnet-4-5-20250514"
  testLatencyMs: number; // 800
}
```

---

### Step 3: Agent Hierarchy

**Purpose:** Show the Matrix org chart, let user activate/deactivate agents, set workspace paths.

**UI:**

```
┌─────────────────────────────────┬──────────────────────────────┐
│                                 │                              │
│  Agent Hierarchy                │       CEO (You)              │
│                                 │          │                   │
│  Tier 1 — Coordinator           │      Operator1 (COO)        │
│  ☑ Operator1 (COO)     ✅      │     ┌────┼────┐              │
│                                 │     │    │    │              │
│  Tier 2 — Department Heads      │    Neo  Morph Trinity       │
│  ☑ Neo (CTO)           ✅      │   (CTO) (CMO) (CFO)        │
│  ☑ Morpheus (CMO)      ✅      │     │    │    │              │
│  ☑ Trinity (CFO)        ✅      │   10    10   10             │
│                                 │  agents agents agents       │
│  Tier 3 — Workers (30)          │                              │
│  ☑ All Engineering (10) ✅      │  Total: 34 agents           │
│  ☑ All Marketing (10)  ✅      │  Active: 34                 │
│  ☐ All Finance (10)    —       │  Workspaces: ~/dev/operator1│
│                                 │                              │
│  Workspace: [~/dev/operator1]   │                              │
│                                 │                              │
│  [← Back]  [Continue →]        │                              │
└─────────────────────────────────┴──────────────────────────────┘
```

**RPC calls:**

- `agents.list` — load all 34 agents
- `config.patch` — enable/disable agents, set workspace (no `agents.configure` RPC exists; use `config.patch` to update agent config)

**Data collected:**

```typescript
{
  activeAgents: string[];       // ["operator1", "neo", "morpheus", ...]
  disabledAgents: string[];     // ["oracle", "seraph", ...]
  workspacePath: string;        // "~/dev/operator1"
}
```

**Notes:**

- Show the mermaid-style org chart on the right panel (static SVG or simple div-based tree)
- Default: all agents enabled
- Allow quick toggle by department (Engineering, Marketing, Finance)
- Workspace path with file picker or manual entry

**Tier dependency enforcement:** Disabling a Tier 2 department head (e.g. Neo/CTO) auto-disables all their Tier 3 workers. Show a confirmation: "Disabling Neo will also disable 10 Engineering workers. Continue?" Re-enabling the head does NOT auto-enable workers — user must opt back in via a "Re-enable workers" expandable section under the head's toggle (shows the worker list with individual checkboxes). Reference: `agent-marketplace-implementation.md` for tier logic.

**Workspace path validation:** Before accepting, probe the path via RPC:

```typescript
// onboarding.validatePath RPC
{ path: "~/dev/operator1", exists: boolean, writable: boolean, diskFreeGb: number }
```

Show warning if path doesn't exist or isn't writable. Offer to create directory if missing.

---

### Step 4: Channel Setup

**Purpose:** Configure at least one messaging channel for interacting with agents.

**UI:**

```
┌─────────────────────────────────┬──────────────────────────────┐
│                                 │                              │
│  Messaging Channels             │  How channels work:          │
│                                 │                              │
│  ☑ Web Chat (built-in)  ✅     │  Channels are how you talk  │
│  ☐ Telegram              —     │  to your agents. Web Chat   │
│  ☐ Discord               —     │  is always available.       │
│  ☐ WhatsApp              —     │                              │
│  ☐ Slack                 —     │  Add Telegram or Discord    │
│  ☐ Signal                —     │  for mobile access.         │
│  ☐ iMessage              —     │                              │
│                                 │  Each channel connects to   │
│  ── Telegram Setup ──          │  the same agent system.     │
│  Bot Token: [•••••••••••]       │                              │
│  [🧪 Test Bot]                  │                              │
│  Status: ✅ Bot @mybot online   │                              │
│                                 │                              │
│  [← Back]  [Continue →]        │                              │
└─────────────────────────────────┴──────────────────────────────┘
```

**RPC calls:**

- `channels.status` — current channel states
- `config.patch` — save channel tokens
- `channels.status` with `{ probe: true }` param — test connection after config (note: `--probe` is a CLI flag; the RPC equivalent passes it as a param object, not a flag string)

**Live probe:** After entering a bot token, test it immediately. Show bot username on success, clear error on failure.

**Web Chat is always-on:** Web Chat is built-in and cannot be unchecked. Render it as a locked checkbox with "(built-in — always available)" label. This prevents a state where zero channels are active.

**Primary channel:** After configuring channels, prompt: "Which channel should receive system notifications?" Default to first configured channel. Store as `primary_channel` in onboarding state.

**Error recovery:** Invalid bot token → "Token is invalid. [Re-enter] [Skip Channel]". Gateway disconnect mid-step → show reconnection overlay with auto-retry (same 3s probe as Step 1).

**Data collected:**

```typescript
{
  enabledChannels: string[];    // ["web", "telegram"]
  channelConfigs: Record<string, {
    token?: string;
    configured: boolean;
    tested: boolean;
  }>;
}
```

---

### Step 5: First Interaction

**Purpose:** Send the first message to an agent and see the system work end-to-end.

**UI:**

```
┌─────────────────────────────────┬──────────────────────────────┐
│                                 │                              │
│  Your First Task                │  What's happening:           │
│                                 │                              │
│  Agent: [Operator1 (COO) ▼]    │  1. Message → Gateway       │
│                                 │  2. Gateway → Operator1     │
│  Message:                       │  3. Operator1 routes task   │
│  ┌─────────────────────────┐    │  4. Agent responds          │
│  │ Check system status     │    │                              │
│  │ and report what's       │    │  You can also try:          │
│  │ running.                │    │  • "List all agents"        │
│  └─────────────────────────┘    │  • "What can you do?"       │
│                                 │  • "Run diagnostics"        │
│  [📤 Send]                      │                              │
│                                 │                              │
│  ── Response ──                │                              │
│  ✅ Gateway: running            │                              │
│  ✅ Agents: 34 active           │                              │
│  ✅ Channels: web, telegram     │                              │
│  ✅ Provider: anthropic         │                              │
│                                 │                              │
│  [← Back]  [Finish Setup →]    │                              │
└─────────────────────────────────┴──────────────────────────────┘
```

**RPC calls:**

- `chat.send` — send message to agent (this is the actual method name in `server-methods-list.ts`; `sessions.send` does not exist)
- Stream response via WebSocket events — reuse the streaming infrastructure from `ui-next/src/hooks/use-chat.ts` which already handles the `chat.send` event loop, token streaming, and response assembly. Do not reimplement streaming from scratch.

**Pre-populated message:** "Check system status and report what's running." (editable)

---

### Step 6: Complete — Redirect to Dashboard

**UI:**

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│                    ✅ Setup Complete                           │
│                                                               │
│  Gateway:     ✅ Connected (v2026.3.11)                      │
│  Provider:    ✅ Anthropic (Claude Sonnet)                    │
│  Agents:      ✅ 34 active                                   │
│  Channels:    ✅ Web + Telegram                               │
│  First task:  ✅ Completed                                    │
│                                                               │
│              [→ Go to Dashboard]                              │
│                                                               │
│  You can reconfigure any of these in Config.                  │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**Actions:**

- Mark onboarding as complete in SQLite
- Redirect to `/overview`
- Don't show onboarding wizard again (unless user resets)

---

## 4. SQLite Schema — Onboarding State

Extends the existing `operator1.db` (Phases 0–3 already landed: v1 sessions/delivery/teams, v2 team extensions, v3 subagent runs/auth/pairing/allowlists/threads). This is **Migration v4** in `src/infra/state-db/schema.ts` — add it as the next entry in the `MIGRATIONS` array.

```sql
-- Migration v4: onboarding state tracking
CREATE TABLE IF NOT EXISTS op1_onboarding (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row (enforced by CHECK)
  status TEXT DEFAULT 'pending',           -- pending | in_progress | completed | skipped
  current_step INTEGER DEFAULT 1,
  completed_at INTEGER,
  gateway_host TEXT,
  gateway_version TEXT,
  provider TEXT,
  provider_model TEXT,
  active_agents_json TEXT,                 -- JSON array of agent IDs
  enabled_channels_json TEXT,              -- JSON array of channel names
  primary_channel TEXT,                    -- channel for system notifications
  workspace_path TEXT,                     -- validated workspace directory
  first_message_sent INTEGER DEFAULT 0,
  skipped_steps_json TEXT,                 -- JSON array of step numbers skipped
  config_snapshot_json TEXT,               -- full config at completion (API keys STRIPPED)
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER
);
```

**Singleton insert pattern:** SQLite does not support `DEFAULT` on `PRIMARY KEY`. Use `INSERT OR REPLACE INTO op1_onboarding (id, ...) VALUES (1, ...)` in all write operations. The `CHECK (id = 1)` constraint prevents accidental multi-row inserts.

**Handler must handle empty table:** On fresh install, `onboarding.status` will find no rows. Return `{ status: "pending", currentStep: 1 }` as the default.

**API key security:** `config_snapshot_json` must **strip all API keys and tokens** before storing. Store provider names and channel types only — never plaintext credentials. Keys live in the gateway credentials directory, not in SQLite.

**Migration dependency:** Phases 0–3 (v1 sessions/delivery/teams, v2 team extensions, v3 subagent runs/auth/pairing/allowlists/threads) must be applied first. Migration v4 has no table dependencies on v1–v3 but lives in the same sequential migration chain in `schema.ts`.

**Why SQLite, not localStorage:**

- Persists across browser sessions
- Gateway can read it (e.g. to decide whether to show onboarding)
- Consistent with the SQLite consolidation direction
- Single source of truth accessible from both ui-next and CLI

---

## 5. New RPC Endpoint — Onboarding

### 5.1 Relationship to Existing `wizard.*` System

The gateway already has a `wizard.*` RPC system (`src/gateway/server-methods/wizard.ts`) that drives the CLI and native app (macOS/iOS) onboarding via `wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`. This system uses `WizardSession` with a step-by-step prompter pattern.

**Decision: Layer on top, don't replace.**

The new `onboarding.*` namespace handles **UI-specific state persistence** (SQLite progress tracking, resume, skip). The actual configuration actions (setting API keys, enabling channels) use existing RPCs (`config.patch`, `models.list`, `chat.send`). The `wizard.*` system remains for CLI/native onboarding.

If we later want the UI wizard to drive the same wizard runner, it can call `wizard.start` internally — but for v1, the UI wizard is self-contained with direct RPC calls per step.

### 5.2 RPC Handlers

Add lightweight handlers for UI onboarding state. **Must use the `GatewayRequestHandlers` type** with `{ params, respond, context }` destructuring (see `src/gateway/server-methods/types.ts` and `wizard.ts` for canonical examples).

```typescript
// src/gateway/server-methods/onboarding.ts
import type { GatewayRequestHandlers } from "./types.js";

export const onboardingHandlers: GatewayRequestHandlers = {
  "onboarding.status": async ({ respond, context }) => {
    // Read from op1_onboarding table — return default if no row exists
    const row = context.stateDb.prepare("SELECT * FROM op1_onboarding WHERE id = 1").get();
    respond(true, row ?? { status: "pending", currentStep: 1 }, undefined);
  },

  "onboarding.update": async ({ params, respond, context }) => {
    // Update current step + persist step-specific data
    // Uses INSERT OR REPLACE (singleton pattern)
    // Sets status to 'in_progress' on first call
    respond(true, { ok: true }, undefined);
  },

  "onboarding.complete": async ({ params, respond, context }) => {
    // Mark as completed, store config snapshot (API keys stripped!)
    respond(true, { ok: true }, undefined);
  },

  "onboarding.reset": async ({ respond, context }) => {
    // Reset to step 1 (for re-onboarding)
    respond(true, { ok: true }, undefined);
  },

  "onboarding.skip": async ({ respond, context }) => {
    // Mark as 'skipped' — existing install chose not to run wizard
    respond(true, { ok: true }, undefined);
  },

  "onboarding.validatePath": async ({ params, respond }) => {
    // Check if path exists, is writable, and has disk space
    respond(true, { path: params.path, exists: true, writable: true, diskFreeGb: 0 }, undefined);
  },
};
```

**Registration checklist** (all required — see `code-guard` protected files manifest):

1. **`server-methods.ts`** — import `onboardingHandlers` and spread into `coreGatewayHandlers`
2. **`server-methods-list.ts`** — add all `onboarding.*` method names to `BASE_METHODS`
3. **`method-scopes.ts`** — add `"onboarding."` to `ADMIN_METHOD_PREFIXES` array (currently: `["exec.approvals.", "config.", "wizard.", "update."]`). Without this, all `onboarding.*` RPCs will be **default-denied** with no scope assigned.

> **Why `ADMIN_METHOD_PREFIXES`?** The existing `wizard.*` prefix is already ADMIN-scoped. Onboarding modifies system configuration, so ADMIN scope is appropriate. The pattern matches: `method.startsWith("onboarding.")` → returns `ADMIN_SCOPE`.

**Migration detection as UI helper (not RPC):** The `onboarding.detectConfig` method from the junior review is unnecessary — `config.get` already returns the full config. Keep detection as a pure UI-side helper:

```typescript
// onboarding-utils.ts
function isAlreadyConfigured(config: GatewayConfig): boolean {
  return hasProvider(config) && hasActiveAgents(config) && hasChannels(config);
}
```

---

## 6. File Structure

```
ui-next/src/
├── pages/
│   └── onboarding.tsx                  # Main wizard page (entry point)
├── components/onboarding/
│   ├── onboarding-wizard.tsx           # Step container + navigation
│   ├── step-gateway.tsx                # Step 1: Gateway connection
│   ├── step-provider.tsx               # Step 2: AI provider setup
│   ├── step-agents.tsx                 # Step 3: Agent hierarchy
│   ├── step-channels.tsx               # Step 4: Channel configuration
│   ├── step-first-task.tsx             # Step 5: First interaction
│   └── step-complete.tsx               # Step 6: Summary + redirect
├── hooks/
│   └── use-onboarding.ts              # Onboarding state hook (RPC-backed)
└── lib/
    └── onboarding-utils.ts            # Probe helpers, validation

src/gateway/server-methods/
└── onboarding.ts                      # RPC handlers for onboarding state

src/infra/state-db/
└── schema.ts                          # Add op1_onboarding migration
```

---

## 7. Routing

```tsx
// app.tsx — add before catch-all (single route, step state is internal not URL-based)
<Route path="/onboarding" element={<OnboardingPage />} />
```

**No wildcard route needed.** Step state is managed internally via SQLite (`current_step`), not via URL segments. A `/onboarding/*` wildcard would cause unexpected route matches with no benefit.

**Auto-redirect logic:** On first visit, if `onboarding.status` returns `pending`, redirect from `/overview` to `/onboarding`. After completion, never redirect automatically — add a "Re-run Setup" button in Config page.

**RPC pattern:** Use `sendRpc` from `useGatewayStore` (see `ui-next/src/hooks/use-chat.ts` for the canonical pattern: `type SendRpc = <T = unknown>(method: string, params?: unknown) => Promise<T>`). The `useGatewayStore` provides connection status via `connectionStatus === "connected"`. There is no `useRpc()` hook — the store's `sendRpc` is used directly.

---

## 8. Error Recovery & Edge Cases

| Scenario                       | Behavior                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page load, gateway not running | Show a holding state: spinner + "Waiting for gateway..." + terminal command to start it. Pre-check (Step 0) catches the RPC failure and falls through to `mode: "fresh"`. Step 1 renders the "not detected" state. |
| Browser crash mid-wizard       | On reload: detect `status === 'in_progress'`, prompt "Continue from Step X?" (see Step 0)                                                                                                                          |
| Gateway disconnects mid-step   | Overlay with "Connection lost. Reconnecting..." + 3s auto-retry. If 30s timeout, show "Gateway unreachable. [Retry] [Save & Exit]"                                                                                 |
| API key fails 3×               | Show "Key may be invalid. [Re-enter] [Skip for Now]". Skipped steps get warning badge                                                                                                                              |
| Bot token invalid              | Inline error with "Token format looks wrong" or "Bot not found". [Re-enter] [Skip Channel]                                                                                                                         |
| Path doesn't exist             | "Directory not found. [Create It] [Choose Different Path]"                                                                                                                                                         |
| Path not writable              | "No write permission. Check ownership or choose a different path."                                                                                                                                                 |
| All steps skipped              | Block completion — at minimum, gateway connection (Step 1) must succeed                                                                                                                                            |

---

## 9. Keyboard Shortcuts (from Paperclip)

| Shortcut           | Action               |
| ------------------ | -------------------- |
| `Ctrl/Cmd + Enter` | Advance to next step |
| `Escape`           | Cancel current probe |
| `Tab`              | Navigate form fields |

Implement in `onboarding-wizard.tsx` with a global `useEffect` keydown handler.

---

## 10. Sidebar Integration

Add to `app-sidebar.tsx` — only visible when onboarding is incomplete:

```typescript
// Conditionally show in sidebar
onboarding: onboardingStatus !== "completed" ? [
  {
    title: "Setup Wizard",
    url: "/onboarding",
    icon: Wand2,
    subtitle: "Complete your Operator1 setup",
  },
] : [],
```

After completion, remove from sidebar. Add "Re-run Setup" to the Config page instead.

---

## 11. Implementation Phases

### Phase A: Wizard Shell + Gateway Step (2 days)

- Create `onboarding-wizard.tsx` — step container, navigation, progress bar
- Implement Step 1 (Gateway Connection) with live auto-detect probe
- Add `op1_onboarding` table to SQLite schema (Migration v4 in `schema.ts`)
- Add `onboarding.*` RPC handlers with correct `GatewayRequestHandlers` type
- Register in `server-methods.ts`, `server-methods-list.ts`, `method-scopes.ts` (add `"onboarding."` to `ADMIN_METHOD_PREFIXES`)
- Add route and conditional sidebar entry
- Unit tests for RPC handlers + migration idempotency test (follow `state-db.test.ts` pattern)

### Phase B: Provider + Agent Steps (2 days)

- Implement Step 2 (Provider Setup) with API key validation probe + Ollama branch
- Implement Step 3 (Agent Hierarchy) with org chart visualization + tier enforcement
- Wire to `models.list`, `agents.list`, `config.patch` RPCs

### Phase C: Channels + First Task (2 days)

- Implement Step 4 (Channel Setup) with bot token testing
- Implement Step 5 (First Interaction) — reuse streaming from `use-chat.ts` hook
- Wire to `channels.status`, `chat.send` RPCs
- Web Chat locked as non-removable default channel

### Phase D: Polish + Auto-redirect (2 days)

- Step 6 (Summary) with checkmarks
- Auto-redirect logic (first visit → onboarding if incomplete)
- "Re-run Setup" button in Config page (identify and update the Config page component)
- Keyboard shortcuts
- Mobile responsive layout (separate subtasks for: two-column collapse, org chart, streaming chat)
- Multi-gateway selector dropdown (if detected)
- Update `.github/labeler.yml` with onboarding paths + create matching label

### Phase E: Tests (1 day)

- RPC handler unit tests (`onboarding.ts`)
- SQLite migration v4 idempotency test
- React hook tests (`use-onboarding.ts`)
- Target: 70% line/branch/function coverage (project requirement)

**Total estimated: 9 days**

---

## 12. What to Lift from Paperclip (Specific Files)

These Paperclip files contain reusable patterns (MIT license):

| Paperclip File                           | Borrow                                                             | Adapt For                                |
| ---------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `ui/src/components/OnboardingWizard.tsx` | Step container, navigation, two-column layout, progress indicators | `onboarding-wizard.tsx`                  |
| `ui/src/components/AgentConfigForm.tsx`  | Form layout, live validation pattern, dirty state overlay          | `step-provider.tsx`, `step-channels.tsx` |
| `ui/src/pages/InviteLanding.tsx`         | Multi-state flow (loading → form → success)                        | General wizard step pattern              |

**Do not borrow:**

- Their API client layer (REST — we use WebSocket RPC)
- Their auth system (PostgreSQL sessions — we use Gateway auth)
- Their database layer (Drizzle + PostgreSQL — we use `node:sqlite`)
- Their company/org model (multi-tenant — we're single-operator)

---

## 13. Open Questions

| #   | Question                               | Options                                              | Recommendation                                                                                                         |
| --- | -------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Show onboarding for existing installs? | Auto-detect if already configured / Always show once | **Auto-detect** — skip if gateway has providers + agents + channels. Offer "Import Current Config" button (see Step 0) |
| 2   | Allow skipping steps?                  | Strict sequential / Allow skip                       | Allow skip with warning badge, except Step 1 (gateway) which is mandatory                                              |
| 3   | Store API keys where?                  | SQLite / Gateway credentials dir                     | **Gateway credentials dir** (existing pattern) — onboarding just triggers `config.patch`                               |
| 4   | Theme for wizard?                      | Same as ui-next / Special welcome theme              | Same theme — consistency matters more than novelty                                                                     |
| 5   | Invite token system?                   | Yes (like Paperclip) / No (single operator)          | **No** — Operator1 is single-operator, invite tokens add complexity without value                                      |
| 6   | Multi-gateway support in v1?           | Full support / Single-gateway only                   | **Single-gateway only** for v1 — document limitation, add gateway selector in Phase D                                  |
| 7   | Keyboard shortcuts scope?              | All phases / Phase D polish                          | **Phase D** — optional polish, not blocking                                                                            |

---

## 14. References

- Paperclip source: `https://github.com/paperclipai/paperclip`
- Operator1 SQLite consolidation: `Project-tasks/operator1-config-sqlite.md`
- Operator1 architecture: `docs/operator1/architecture.md`
- Operator1 RPC reference: `docs/operator1/rpc.md`
- Current state-db schema: `src/infra/state-db/schema.ts`
- UI components: `ui-next/src/components/ui/` (shadcn/ui)

---

_Document created by Operator1 (COO) — OpenClaw Matrix_
