# Operator1 GUI Onboarding — Implementation Guide

**Created:** 2026-03-12
**Author:** Operator1 (COO)
**Status:** Implementation Guide
**Reference:** [paperclipai/paperclip](https://github.com/paperclipai/paperclip) — onboarding wizard patterns
**Depends on:** SQLite consolidation (Phases 0–11 landed), ui-next control panel, existing `wizard.*` RPC system

---

## 1. Goal

Build a guided, step-by-step onboarding wizard in `ui-next` that takes a fresh Operator1 installation from zero to fully operational — gateway connected, providers configured, agents activated, first message sent. No terminal required.

**Success criteria:** A user who has never used Operator1 can complete setup entirely through the browser UI.

**Non-goal:** Force existing installs through the wizard. Auto-detect and skip (see §3.0).

---

## 1.5 Critical: Operator1 Concept Preservation During Paperclip Sync

> **Paperclip's "Company" ≠ a generic company. It maps to Operator1's "Matrix Organization".**
>
> Every cherry-pick from Paperclip must wire to our existing concepts, not overwrite them. The implementation team must understand this mapping before touching any synced code.

### Concept Mapping: Paperclip → Operator1

| Paperclip concept                                           | What it does in Paperclip                                                  | Operator1 equivalent                                                                                                                                                                      | Where it lives in Operator1                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Company** (name, description, status)                     | Top-level organizational unit that scopes all agents, issues, budgets      | **Matrix Organization** — the Tier 1 agent (Operator1/COO) + `ui.assistant` config (name, avatar) + agent hierarchy                                                                       | `openclaw.json` → `agents.list[]`, `ui.assistant`; `matrix-tier-map.ts`      |
| **companyId** (FK on every entity)                          | Scopes all queries: agents, issues, goals                                  | **Not needed** — Operator1 is single-operator. There is no multi-tenant scoping. All agents belong to one org.                                                                            | Remove entirely during adaptation                                            |
| **Company creation** (Step 1 of wizard)                     | `companiesApi.create({ name, description })`                               | **Gateway connection + Matrix identity verification** — our org already exists via `matrix init` or `openclaw onboard`. Step 1 verifies the gateway is running and reads existing config. | `gateway.status` + `config.get` RPCs                                         |
| **CEO agent** (first agent, role: "ceo")                    | First agent created during onboarding, anchors the hierarchy               | **Operator1 (COO)** — Tier 1 agent, always exists, is the entry point for all tasks. Pre-configured via Matrix init.                                                                      | `agents.list[0]` (id: "main" or "operator1"), Tier 1 in `matrix-tier-map.ts` |
| **Agent creation** (`agentsApi.create(companyId, {...})`)   | Creates new agent bound to company                                         | **Agent activation/configuration** — agents already exist in the Matrix registry. Onboarding enables/disables them and sets workspace paths.                                              | `config.patch` to enable/disable agents, `agents.list` to read hierarchy     |
| **Agent hierarchy** (reportsTo FK)                          | Flat — each agent optionally reports to one other                          | **3-tier Matrix hierarchy** — Tier 1 (COO) → Tier 2 (Department Heads: Neo/CTO, Morpheus/CMO, Trinity/CFO) → Tier 3 (30 specialists grouped by department)                                | `matrix-tier-map.ts`, `types.agents.ts` (tier, department fields)            |
| **Issue creation** (Step 4: first task)                     | `issuesApi.create(companyId, {...})` with auto-numbered identifier (PAP-1) | **First message** (Step 5) — we send a chat message via `chat.send` to an agent, not create a work item. The response validates the full pipeline works.                                  | `chat.send` RPC with streaming via `use-chat.ts`                             |
| **Issue prefix** (PAP, ACME — unique per company)           | Scoped work-item numbering                                                 | **Not applicable** — Operator1 uses session-based chat, not issue trackers                                                                                                                | Remove entirely                                                              |
| **Budget tracking** (monthly cents, per-company, per-agent) | Cost guardrails per company                                                | **Not applicable in v1** — may add later, not part of onboarding                                                                                                                          | Remove entirely                                                              |
| **CompanyContext** (React context, `selectedCompanyId`)     | Global state holding which company is active                               | **useGatewayStore** — single gateway connection, no company selector needed                                                                                                               | `ui-next/src/hooks/use-gateway-store.ts`                                     |
| **Bootstrap invite** (first admin, `pcp_bootstrap_...`)     | Designates the first instance admin in authenticated mode                  | **Not applicable** — Operator1 is single-operator, no invite system                                                                                                                       | Remove entirely                                                              |
| **Company join invite** (`company_join`, 10-min TTL)        | Adds humans/agents to existing company                                     | **Not applicable** — all agents are pre-defined in the Matrix                                                                                                                             | Remove entirely                                                              |
| **Workspace** (per-agent directory)                         | Not a Paperclip concept (they use shared DB)                               | **Per-agent workspace** — each agent gets its own directory with AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, HEARTBEAT.md, MEMORY.md                                                       | `resolveAgentWorkspaceDir(config, agentId)`, default `~/.openclaw/workspace` |

### What Must Be Preserved (Operator1 Identity)

These are the pillars of Operator1's identity that **must never be overwritten** by Paperclip cherry-picks:

1. **Matrix hierarchy is pre-existing.** Paperclip creates agents during onboarding. We don't — our 34 agents already exist via `matrix init`. The wizard activates/configures them, it doesn't create them.

2. **Single-operator model.** Every Paperclip API call passes `companyId`. We have zero multi-tenant scoping. Strip all `companyId` references — no context provider, no company selector, no scoped queries.

3. **Tier-based organization.** Paperclip has a flat agent list with optional `reportsTo`. Operator1 has a rigid 3-tier Matrix: COO → Department Heads → Specialists. The org chart in Step 3 must show our tier/department structure, not Paperclip's flat list.

4. **RPC-based state, not REST.** Paperclip calls `companiesApi.create()`, `agentsApi.create()`, `issuesApi.create()` — all REST. We use `config.patch`, `agents.list`, `chat.send` — all WebSocket RPC via `sendRpc()`.

5. **Workspace is filesystem-based.** Paperclip stores everything in PostgreSQL. Our agent workspace files (AGENTS.md, SOUL.md, etc.) live on disk. The wizard validates workspace paths, not database records.

6. **Gateway is the identity anchor.** Paperclip's identity is the Company record. Ours is the running gateway + its config. Step 1 connects to the gateway and reads its config — that IS our "company registration".

### Per-Phase Wiring Guidance

This section tells the implementation team exactly what to wire to at each phase, to prevent accidental Paperclip concept leakage.

#### Phase 0 (Paperclip Sync)

**Risk:** Cherry-picked code will have `companyId` params, `companiesApi` calls, and `CompanyContext` imports everywhere.
**Action:** Code-guard's adaptation rules (§2.5) handle the mechanical rewrite. But the implementation team must **verify after adaptation** that:

- Zero references to `companyId`, `company`, `CompanyContext` remain
- All `companiesApi.*` calls are replaced with operator1 RPCs or removed
- No `InviteToken` or bootstrap logic survives

#### Phase A (Wizard Shell + Gateway Step)

**Paperclip Step 1 collects:** company name + description → creates Company record.
**Operator1 Step 1 collects:** gateway host → verifies gateway is running → reads existing config.
**Wiring:**

- Replace `companiesApi.create()` with `gateway.status` + `config.get` RPCs
- The "company name" concept becomes the gateway version and status display
- Pre-check logic (resume, migration detection) stays — it's framework, not company-specific
- `onboarding.status` RPC (our new handler) replaces Paperclip's company creation check

#### Phase B (Provider + Agent Steps)

**Paperclip Step 2 collects:** agent name, adapter type, adapter config → creates first Agent.
**Operator1 Step 2 collects:** AI provider, API key, model → configures the provider (not an agent).
**Operator1 Step 3 shows:** existing Matrix hierarchy → user activates/deactivates agents.
**Wiring:**

- Replace `agentsApi.create(companyId, {...})` with `config.patch` to set provider keys
- Replace `agentsApi.adapterModels(companyId, adapterType)` with `models.list` RPC
- Replace `agentsApi.adapterEnvironmentTest()` with our own test-connection probe (send minimal prompt)
- The "CEO as first agent" concept → does not apply. Operator1/COO already exists. Step 3 shows the full hierarchy and lets user toggle agents, not create them.
- Tier enforcement logic (disabling a Tier 2 head auto-disables Tier 3 workers) is **Operator1-only** — Paperclip has nothing like this.

#### Phase C (Channels + First Task)

**Paperclip Step 3-4 collects:** task title + description → creates Issue.
**Operator1 Step 4 collects:** channel configs (Telegram bot token, Discord token, etc.).
**Operator1 Step 5 sends:** first chat message to an agent → validates pipeline.
**Wiring:**

- Replace `issuesApi.create(companyId, {...})` with `chat.send` RPC
- Channel setup is entirely Operator1-specific — Paperclip has no channel concept
- Streaming response uses existing `use-chat.ts` hook — no Paperclip code involved
- The "first task" concept maps to "first message" — same user intent, different mechanism

#### Phase D (Polish)

**Risk:** Auto-redirect logic must check our `onboarding.status` RPC, not Paperclip's company existence.
**Wiring:**

- Sidebar conditional uses `onboarding.status` → `status !== "completed"`
- "Re-run Setup" in Config page resets our SQLite `op1_onboarding` table, not a company record
- Multi-gateway selector is Operator1-only (Paperclip is single-instance)

---

## 2. Stack Comparison — Paperclip vs Operator1

| Layer         | Paperclip                    | Operator1                                        | Notes                              | Sync Strategy                            |
| ------------- | ---------------------------- | ------------------------------------------------ | ---------------------------------- | ---------------------------------------- |
| Frontend      | React 19, Vite 6, shadcn/ui  | React 19, Vite, shadcn/ui                        | ✅ identical — components portable | Cherry-pick + minor path remap           |
| Icons         | Lucide React                 | Lucide React                                     | ✅ identical                       | Direct sync                              |
| Routing       | React Router                 | React Router                                     | ✅ identical                       | Direct sync                              |
| State         | React Query v5               | Custom hooks + `sendRpc()` via `useGatewayStore` | ⚠️ different but compatible        | Adapt: `useQuery` → `sendRpc`            |
| Backend       | Express + PostgreSQL         | OpenClaw Gateway (WebSocket RPC)                 | ❌ different                       | **Skip entirely** — out of scope         |
| Storage       | PostgreSQL (Drizzle ORM)     | SQLite (`operator1.db`, `node:sqlite`)           | ❌ different engine, same role     | **Skip entirely** — our RPCs handle this |
| Auth          | Session cookies + BetterAuth | Gateway auth (API key / web login)               | ❌ different                       | **Skip entirely**                        |
| Agent runtime | Heartbeat polling + adapters | Pi sessions + ACP backend                        | ❌ different model                 | **Skip entirely**                        |

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

## 2.5 Upstream Sync Strategy — Paperclip as Second Upstream

**Model:** Same cherry-pick pipeline as OpenClaw upstream sync (see `Project-tasks/Done/upstream-selective-sync-process.md` and `.claude/skills/upstream-sync/SKILL.md`). Paperclip becomes a second upstream remote, synced using the same phased PR workflow, agent coordination (sync-lead → code-guard → qa-runner), and human-in-the-loop approval gates.

### Why fork-sync instead of manual copy

- **Traceability:** Every adopted change gets `cherry-pick -x` attribution back to Paperclip SHAs
- **Repeatability:** As Paperclip evolves (new wizard patterns, form components, accessibility improvements), we re-sync the same way — no manual diffing
- **Human-in-the-loop:** Same 3-gate approval model as OpenClaw sync (classify → PR review → hands-on testing)
- **Consistency:** One pipeline for all upstreams; agents already know the process

### Remote setup

```bash
git remote add paperclip https://github.com/paperclipai/paperclip.git
git remote set-url --push paperclip FETCH_ONLY_NO_PUSH  # safety: never push to Paperclip
```

### Tracking

State tracked in `.claude/skills/upstream-sync/state/sync-state.json` under a new `paperclip` key:

```json
{
  "paperclip": {
    "lastSyncedCommit": null,
    "lastSyncedAt": null,
    "currentSync": null,
    "history": []
  }
}
```

Unlike OpenClaw (which uses date-based release tags), Paperclip doesn't have a formal release cadence. Syncs target specific commits or HEAD of their `main` branch.

### Scope filter (directories in-scope for sync)

| Paperclip path                        | What we take                                       | Maps to                                  |
| ------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| `ui/src/components/OnboardingWizard*` | Wizard shell, step navigation, progress indicators | `ui-next/src/components/onboarding/`     |
| `ui/src/components/AgentConfigForm*`  | Form layout, live validation, dirty state tracking | `step-provider.tsx`, `step-channels.tsx` |
| `ui/src/pages/InviteLanding*`         | Multi-state flow (loading → form → success)        | General wizard step pattern              |
| `ui/src/components/ui/*`              | shadcn/ui component updates (if newer)             | `ui-next/src/components/ui/`             |

Everything else is **out of scope** — their backend, DB, auth, multi-tenant model, API client.

### Adaptation rules (code-guard strategies for Paperclip)

| Paperclip pattern               | Operator1 adaptation                             |
| ------------------------------- | ------------------------------------------------ |
| `useQuery()` / React Query v5   | Rewrite to `sendRpc()` via `useGatewayStore`     |
| `fetch("/api/...")` REST calls  | Rewrite to `sendRpc("method.name", params)`      |
| `useMutation()` / React Query   | Rewrite to `sendRpc()` with error handling       |
| PostgreSQL/Drizzle imports      | Remove — our RPCs handle persistence server-side |
| `Company`/`Organization` models | Remove — single-operator, no multi-tenant        |
| `InviteToken` / invite flows    | Remove — no invite system in Operator1           |
| Their component import paths    | Remap to `ui-next/src/components/` equivalents   |
| `tailwindcss` class patterns    | Keep — both use Tailwind via shadcn/ui           |

### Phase categories (Paperclip-specific)

Paperclip syncs use a simplified 3-phase model (vs OpenClaw's 6-phase):

| Phase | Category          | Branch pattern                    | Description                               |
| ----- | ----------------- | --------------------------------- | ----------------------------------------- |
| 1     | **Onboarding UI** | `sync/paperclip-<sha>-onboarding` | Wizard shell, step components, navigation |
| 2     | **Form Patterns** | `sync/paperclip-<sha>-forms`      | Form components, validation, dirty state  |
| 3     | **UI Components** | `sync/paperclip-<sha>-ui`         | Shared shadcn/ui updates, design patterns |

### Protected files (never overwrite from Paperclip)

- All `src/**` (our entire backend — Paperclip has zero backend overlap)
- `ui-next/src/hooks/use-chat.ts` (our streaming infra)
- `ui-next/src/hooks/use-gateway-store.ts` (our WebSocket state)
- `ui-next/src/app.tsx` (our routes)
- `ui-next/src/components/app-sidebar.tsx` (our navigation)
- Any file under `src/infra/`, `src/gateway/`

### Human-in-the-loop gates (same 3-gate model)

1. **Classification approval** — sync-lead presents which Paperclip commits to adopt per phase, user approves
2. **PR review** — after code-guard cherry-picks and qa-runner validates, user reviews PR
3. **Hands-on testing** — after merge to main, user smoke-tests the onboarding flow in browser

### Invocation

```bash
/upstream-sync --source paperclip                    # sync latest from Paperclip main
/upstream-sync --source paperclip <commit-sha>       # sync up to specific commit
/upstream-sync --source paperclip --review           # classify only, don't pick
/upstream-sync --source paperclip --phase onboarding # run specific phase
```

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

**Ollama branch:** If user selects Ollama (local), skip API key field. Instead show an "Ollama Status" probe that calls `models.list` with the Ollama provider selected — this probes Ollama via the gateway (server-side), not via browser `fetch`. Do NOT call `http://localhost:11434/api/tags` directly from the browser — this will fail if the gateway runs on a remote host (the browser's `localhost` is not the gateway's `localhost`). The gateway already knows how to reach Ollama via its configured Ollama base URL. If Ollama is not running or unreachable from the gateway, show install/start instructions.

**Error recovery:** If API key test fails 3 times, show: "Key may be invalid or provider may be down. [Try Again] [Skip for Now] [Enter Different Key]". Skipped steps get a warning badge in the progress bar.

**Back-navigation + mutation semantics:** Steps 2–4 call `config.patch` immediately when the user submits (API key, channel tokens). If the user navigates back and changes values:

- **Provider (Step 2):** Re-submitting overwrites the previous `config.patch` for the same provider key. This is safe — `config.patch` is idempotent for the same key path.
- **Channels (Step 4):** Re-submitting overwrites the previous token for the same channel. If the user switches from Telegram to Discord on back-nav, the old Telegram token remains in config (it was already `config.patch`-ed). This is acceptable — unused tokens don't cause harm and can be removed later in the Config page. The wizard does NOT revert previously-patched config on back-nav.
- **General rule:** The wizard is write-forward. `config.patch` calls are fire-and-forget. No undo/rollback on back-navigation. The onboarding SQLite state tracks wizard progress only, not a transaction log of config changes.

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

**Primary channel (deferred to Phase D):** The schema stores `primary_channel` for future use as the default channel for system notifications (gateway alerts, agent status changes, scheduled reports). In v1, this field is collected and stored but **not consumed** — no gateway behavior reads it yet. The consumer will be implemented when the notification routing system is built. For now, the UI collects the preference and stores it in `op1_onboarding.primary_channel` so we don't need to re-ask later.

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

Extends the existing `operator1.db`. All migrations v1–v11 are already applied as of 2026-03-13:

| Version | Description                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------- |
| v1      | P0: sessions, delivery queue, teams                                                                                       |
| v2      | P2: extend team tables (leader, duplicate agent_id, extra task/message columns)                                           |
| v3      | P3: subagent runs, auth profiles, pairing, allowlists, thread bindings                                                    |
| v4      | P4: `core_settings` KV, cron jobs/runs, channel state (tg/dc), auth credentials, exec approvals, workspace state, clawhub |
| v5      | P5A-C: device/node pairing, sandbox container/browser registries                                                          |
| v6      | P6: gateway config `op1_config` singleton (replaces `openclaw.json`)                                                      |
| v7      | P4E/5D: MCP registries, agent marketplace registries, agent locks                                                         |
| v8      | P8.5: projects registry, telegram topic bindings, `project_id` on workspace_state                                         |
| v9      | P3: audit_state table + INSERT/UPDATE/DELETE triggers for security-sensitive tables                                       |
| v10     | P8A: promote `project_id` column on `session_entries` (was in `extra_json`)                                               |
| v11     | Slash commands: `op1_commands` registry + `op1_command_invocations` log + builtin seeds                                   |

This is **Migration v12** in `src/infra/state-db/schema.ts` — add it as the next entry in the `MIGRATIONS` array.

```sql
-- Migration v12: onboarding state tracking
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

**API key security:** `config_snapshot_json` must **strip all API keys and tokens** before storing. Store provider names and channel types only — never plaintext credentials. Keys live in the gateway credentials directory, not in SQLite. Implementation: add a `stripConfigSecrets(config: object): object` helper in `onboarding-sqlite.ts` that deep-clones the config and replaces any value whose key matches `/key|token|secret|password|credential/i` with `"[REDACTED]"`. Call this in `markOnboardingComplete()` before writing `config_snapshot_json`.

**Migration dependency:** Migrations v1–v11 are already applied on all existing installs. Migration v12 has no table dependencies on prior migrations but lives in the same sequential migration chain in `schema.ts`. The migration runner is idempotent and will skip v1–v11 on startup.

**Why SQLite, not localStorage:** All operator1 state lives in `operator1.db` (migrations v1–v11 already migrated every prior JSON file). Onboarding state follows the same pattern: persists across browser sessions, readable by the gateway (e.g. to gate the auto-redirect), and accessible from both ui-next and CLI. localStorage is not an option — it is browser-scoped and invisible to the gateway process.

---

## 5. New RPC Endpoint — Onboarding

### 5.1 Relationship to Existing `wizard.*` System

The gateway already has a `wizard.*` RPC system (`src/gateway/server-methods/wizard.ts`) that drives the CLI and native app (macOS/iOS) onboarding via `wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`. This system uses `WizardSession` with a step-by-step prompter pattern.

**Decision: Layer on top, don't replace.**

The new `onboarding.*` namespace handles **UI-specific state persistence** (SQLite progress tracking, resume, skip). The actual configuration actions (setting API keys, enabling channels) use existing RPCs (`config.patch`, `models.list`, `chat.send`). The `wizard.*` system remains for CLI/native onboarding.

If we later want the UI wizard to drive the same wizard runner, it can call `wizard.start` internally — but for v1, the UI wizard is self-contained with direct RPC calls per step.

### 5.2 RPC Handlers

Add lightweight handlers for UI onboarding state. **Must use the `GatewayRequestHandlers` type** with `{ params, respond }` destructuring (see `src/gateway/server-methods/commands.ts` for the canonical pattern used by the slash commands system).

**TypeBox param schemas required:** Create `src/gateway/protocol/schema/onboarding.ts` with TypeBox schemas for each handler's params (follow `src/gateway/protocol/schema/wizard.ts` pattern). All mutating handlers (`onboarding.update`, `onboarding.complete`, `onboarding.validatePath`) must call `assertValidParams()` from `src/gateway/server-methods/validation.ts` before touching state — this is the standard pattern used by 10+ existing handlers. Do not spread raw `params` into DB calls.

**Param schemas (define in `src/gateway/protocol/schema/onboarding.ts`):**

```typescript
import { Type } from "@sinclair/typebox";

// onboarding.update — advances wizard state, one step at a time
export const OnboardingUpdateSchema = Type.Object({
  currentStep: Type.Optional(Type.Number({ minimum: 1, maximum: 6 })),
  gatewayHost: Type.Optional(Type.String()),
  gatewayVersion: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  providerModel: Type.Optional(Type.String()),
  activeAgentsJson: Type.Optional(Type.String()), // JSON array
  enabledChannelsJson: Type.Optional(Type.String()), // JSON array
  primaryChannel: Type.Optional(Type.String()),
  workspacePath: Type.Optional(Type.String()),
  firstMessageSent: Type.Optional(Type.Number()), // 0 or 1
  skippedStepsJson: Type.Optional(Type.String()), // JSON array
});
export type OnboardingUpdateParams = typeof OnboardingUpdateSchema.static;

// onboarding.complete — finalizes onboarding with config snapshot
export const OnboardingCompleteSchema = Type.Object({
  configSnapshotJson: Type.Optional(Type.String()), // stripped config
});
export type OnboardingCompleteParams = typeof OnboardingCompleteSchema.static;

// onboarding.validatePath — checks workspace path viability
export const OnboardingValidatePathSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
});
```

**Note:** All fields in `OnboardingUpdateSchema` are optional because the UI sends partial updates per step (Step 1 sends `gatewayHost` + `gatewayVersion` + `currentStep`, Step 2 sends `provider` + `providerModel` + `currentStep`, etc.). The handler merges the patch into the existing singleton row.

**Important:** `GatewayRequestContext` (see `src/gateway/server-methods/types.ts`) does **not** expose a `stateDb` field. DB access must go through a dedicated `src/infra/state-db/onboarding-sqlite.ts` module that calls `getStateDb()` internally — exactly like `commands-sqlite.ts`. This also enables test isolation via `setOnboardingDbForTest` / `resetOnboardingDbForTest` (same pattern as `setCommandsDbForTest`).

```typescript
// src/infra/state-db/onboarding-sqlite.ts  (new file — follow commands-sqlite.ts pattern)
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "./connection.js";

let _dbOverride: DatabaseSync | null = null;
export function setOnboardingDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}
export function resetOnboardingDbForTest(): void {
  _dbOverride = null;
}
function resolveDb(): DatabaseSync {
  return _dbOverride ?? getStateDb();
}

export function getOnboardingState(): OnboardingRow | null {
  return resolveDb()
    .prepare("SELECT * FROM op1_onboarding WHERE id = 1")
    .get() as OnboardingRow | null;
}
export function upsertOnboardingState(patch: Partial<OnboardingRow>): void {
  // INSERT OR REPLACE — singleton row enforced by CHECK (id = 1)
  // ... full implementation goes here
}
// ... other helpers: markComplete, markSkipped, resetOnboarding

// IMPORTANT: DB columns are snake_case (current_step, completed_at, etc.)
// but RPC responses must be camelCase (currentStep, completedAt, etc.).
// Add a rowToState() mapping function — follow the rowToEntry() pattern
// in commands-sqlite.ts (lines 73–91).
```

```typescript
// src/gateway/server-methods/onboarding.ts
import {
  getOnboardingState,
  upsertOnboardingState,
  markOnboardingComplete,
  markOnboardingSkipped,
  resetOnboardingState,
} from "../../infra/state-db/onboarding-sqlite.js";
import { assertValidParams } from "./validation.js";
import {
  OnboardingUpdateSchema,
  type OnboardingUpdateParams,
  OnboardingCompleteSchema,
  type OnboardingCompleteParams,
  OnboardingValidatePathSchema,
} from "../protocol/schema/onboarding.js";
import type { GatewayRequestHandlers } from "./types.js";

export const onboardingHandlers: GatewayRequestHandlers = {
  "onboarding.status": ({ respond }) => {
    // Read from op1_onboarding — return default if no row exists yet
    const row = getOnboardingState();
    respond(true, row ?? { status: "pending", currentStep: 1 }, undefined);
  },

  "onboarding.update": ({ params, respond }) => {
    // Validate params against OnboardingUpdateSchema before touching DB
    assertValidParams(params, OnboardingUpdateSchema);
    const validated = params as OnboardingUpdateParams;
    // Update current step + persist step-specific data
    // Uses INSERT OR REPLACE (singleton pattern)
    // Sets status to 'in_progress' on first call
    upsertOnboardingState({ status: "in_progress", ...validated });
    respond(true, { ok: true }, undefined);
  },

  "onboarding.complete": ({ params, respond }) => {
    // Validate params against OnboardingCompleteSchema
    assertValidParams(params, OnboardingCompleteSchema);
    // Mark as completed, store config snapshot (API keys stripped!)
    markOnboardingComplete(params as OnboardingCompleteParams);
    respond(true, { ok: true }, undefined);
  },

  "onboarding.reset": ({ respond }) => {
    // Reset to step 1 (for re-onboarding)
    resetOnboardingState();
    respond(true, { ok: true }, undefined);
  },

  "onboarding.skip": ({ respond }) => {
    // Mark as 'skipped' — existing install chose not to run wizard
    markOnboardingSkipped();
    respond(true, { ok: true }, undefined);
  },

  "onboarding.validatePath": ({ params, respond }) => {
    // Validate params against OnboardingValidatePathSchema
    assertValidParams(params, OnboardingValidatePathSchema);
    // Check if path exists, is writable, and has disk space
    // Use fs.accessSync / fs.statSync — no DB needed here
    respond(true, { path: params.path, exists: true, writable: true, diskFreeGb: 0 }, undefined);
  },
};
```

**Registration checklist** (all required — see `code-guard` protected files manifest):

1. **`server-methods.ts`** — import `onboardingHandlers` and spread into `coreGatewayHandlers`
2. **`server-methods-list.ts`** — add all `onboarding.*` method names to `BASE_METHODS`
3. **`method-scopes.ts`** — register scopes in `METHOD_SCOPE_GROUPS` (not just prefix-based). Read-only endpoints (`onboarding.status`, `onboarding.validatePath`) → `READ_SCOPE`. Mutating endpoints (`onboarding.update`, `onboarding.complete`, `onboarding.reset`, `onboarding.skip`) → `ADMIN_SCOPE`. Do NOT blanket the entire `onboarding.*` prefix as ADMIN — the UI needs `onboarding.status` to work with READ_SCOPE sessions (e.g. for the sidebar conditional and auto-redirect check).

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

src/gateway/protocol/schema/
└── onboarding.ts                      # TypeBox param schemas for onboarding.* RPCs

src/infra/state-db/
├── onboarding-sqlite.ts               # DB helpers + test isolation (setOnboardingDbForTest)
└── schema.ts                          # Add op1_onboarding migration (v12)

# Existing files to modify:
# ui-next/src/pages/overview.tsx       — add auto-redirect to /onboarding when status=pending
# ui-next/src/app.tsx                  — add /onboarding route
# ui-next/src/components/app-sidebar.tsx — conditional "Setup Wizard" entry
```

---

## 7. Routing

```tsx
// app.tsx — add before catch-all (single route, step state is internal not URL-based)
<Route path="/onboarding" element={<OnboardingPage />} />
```

**No wildcard route needed.** Step state is managed internally via SQLite (`current_step`), not via URL segments. A `/onboarding/*` wildcard would cause unexpected route matches with no benefit.

**Auto-redirect logic:** On first visit, if `onboarding.status` returns `pending`, redirect from `/overview` to `/onboarding`. After completion, never redirect automatically — add a "Re-run Setup" button in Config page.

**Implementation:** Add a `useEffect` mount hook in `overview.tsx` (not a route guard or loader — those would block rendering). The hook calls `sendRpc("onboarding.status")` on mount, and if `status === "pending"`, calls `navigate("/onboarding")`. This uses `READ_SCOPE` (per §5.2) so it works for all session types. Wrap in a try/catch — if the RPC fails (gateway unreachable), do nothing (don't redirect).

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

### Phase 0: Paperclip Fork Sync Setup (0.5 day)

- Add `paperclip` git remote (`git remote add paperclip https://github.com/paperclipai/paperclip.git`)
- Set push-safety: `git remote set-url --push paperclip FETCH_ONLY_NO_PUSH`
- Initialize Paperclip tracking in `sync-state.json` (see §2.5)
- Run `/upstream-sync --source paperclip --review` to classify available commits
- Human approval gate: review classification, approve Phase 1 (onboarding UI) commits
- Cherry-pick onboarding wizard shell + step components via code-guard
- Adapt imports (React Query → sendRpc, REST → RPC, remove Drizzle/multi-tenant)
- qa-runner validates: `cd ui-next && pnpm build` must pass
- Human approval gate: review PR, merge, hands-on test in dev server
- Result: adapted Paperclip wizard shell rendering in ui-next, ready for operator1 wiring
- **Concept preservation checkpoint (§1.5):** Verify zero references to `companyId`, `companiesApi`, `CompanyContext`, `InviteToken`, `bootstrap`, `company_join` remain in adapted code. All data fetching must use `sendRpc()`, not REST. Org chart must use Matrix tier map, not Paperclip's flat agent list.

### Phase A: Wizard Shell + Gateway Step (2 days)

- Create `onboarding-wizard.tsx` — step container, navigation, progress bar
- Implement Step 1 (Gateway Connection) with live auto-detect probe
- Add `op1_onboarding` table to SQLite schema (Migration v12 in `schema.ts`)
- Create `src/infra/state-db/onboarding-sqlite.ts` (DB helpers + `setOnboardingDbForTest` / `resetOnboardingDbForTest` for test isolation — follow `commands-sqlite.ts` pattern)
- Create `src/gateway/protocol/schema/onboarding.ts` with TypeBox param schemas (follow `wizard.ts` pattern)
- Add `onboarding.*` RPC handlers with correct `GatewayRequestHandlers` type; use `assertValidParams()` for all mutating handlers; import DB helpers from `onboarding-sqlite.ts` (do NOT use `context.stateDb` — it does not exist)
- Register in `server-methods.ts`, `server-methods-list.ts`, `method-scopes.ts` (per-method scoping: `onboarding.status` + `onboarding.validatePath` → `READ_SCOPE`, all mutating methods → `ADMIN_SCOPE` — see §5.2 for rationale; do NOT blanket the prefix as ADMIN)
- Add route and conditional sidebar entry
- **Tests (inline, not deferred):** RPC handler unit tests (`onboarding.test.ts`) + migration v12 idempotency test + `onboarding-sqlite.test.ts` — write these in Phase A alongside the handlers. Phase E only adds UI hook tests and fills coverage gaps to 70%. Do not defer backend tests to Phase E.

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
- Mobile responsive layout:
  - Two-column collapse: stack form above context panel on <768px
  - Org chart: switch to vertical tree or accordion on mobile
  - Streaming chat: full-width chat area, collapsible "what's happening" panel
  - Touch targets: minimum 44px for all interactive elements
- Multi-gateway selector dropdown (if detected)
- Update `.github/labeler.yml` with onboarding paths + create matching label

### Phase E: Tests — Coverage Gap Fill (1 day)

**Note:** Backend tests (RPC handlers, SQLite migration, `onboarding-sqlite.ts`) are written inline in Phase A alongside the handlers — not deferred here. Phase E covers:

- React hook tests (`use-onboarding.ts`) — mock `sendRpc`, test state transitions, error states
- UI component integration tests (wizard step navigation, back-nav behavior, skip logic)
- End-to-end flow test: fresh install → wizard → complete → no re-redirect
- Coverage gap analysis: identify untested branches from Phases A–D and fill to 70%
- Test file locations: `src/gateway/server-methods/onboarding.test.ts` (Phase A), `src/infra/state-db/onboarding-sqlite.test.ts` (Phase A), `ui-next/src/hooks/use-onboarding.test.ts` (Phase E), `ui-next/src/components/onboarding/onboarding-wizard.test.ts` (Phase E)
- Target: 70% line/branch/function coverage (project requirement)

### Ongoing: Paperclip Sync Cadence

- Periodic sync (as-needed) when Paperclip ships wizard improvements, new form patterns, or accessibility fixes
- Same pipeline: `/upstream-sync --source paperclip` → sync-lead → code-guard → qa-runner
- Scope limited to UI components only — Paperclip backend never syncs
- Human-in-the-loop at every gate — no auto-merge

**Total estimated: 9.5 days** (including Phase 0)

---

## 12. Paperclip Sync Scope & Exclusions

> **Read §1.5 first.** Every cherry-pick must wire to Operator1's Matrix organization concepts. Paperclip's company-centric logic (`companyId`, `companiesApi`, `CompanyContext`) must be fully stripped and replaced with our gateway RPC + agent hierarchy model. See the per-phase wiring guidance in §1.5 for exact replacement mappings.

Paperclip features are adopted via the upstream cherry-pick sync pipeline (see §2.5), not by manual copy. The scope filter and adaptation rules below guide `code-guard` during cherry-picks.

### In-scope (cherry-pick and adapt)

| Paperclip path                        | What we sync                                                          | Adaptation needed                                                          |
| ------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ui/src/components/OnboardingWizard*` | Wizard shell, step navigation, progress indicators, two-column layout | Path remap to `ui-next/src/components/onboarding/`; `useQuery` → `sendRpc` |
| `ui/src/components/AgentConfigForm*`  | Form layout, live validation, dirty state overlay                     | Path remap; remove Drizzle schema refs; wire to `config.patch` RPC         |
| `ui/src/pages/InviteLanding*`         | Multi-state flow pattern (loading → form → success)                   | Remove invite token logic; adapt as general wizard step template           |
| `ui/src/components/ui/*`              | shadcn/ui component updates                                           | Direct sync if newer than our versions                                     |

### Exclusions (never sync from Paperclip)

| Paperclip area                                   | Why excluded                                            |
| ------------------------------------------------ | ------------------------------------------------------- |
| API client layer (`ui/src/lib/api*`)             | REST-based — we use WebSocket RPC via `useGatewayStore` |
| Auth system (`ui/src/lib/auth*`, `server/auth*`) | PostgreSQL sessions + BetterAuth — we use Gateway auth  |
| Database layer (`server/db/*`, `drizzle/*`)      | Drizzle + PostgreSQL — we use `node:sqlite`             |
| Company/org model (`server/models/company*`)     | Multi-tenant — Operator1 is single-operator             |
| Backend (`server/**`)                            | Express + PostgreSQL — entirely different architecture  |

### License

Paperclip is MIT licensed. Cherry-pick `-x` attribution preserves provenance in commit messages.

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
- **Upstream sync skill:** `.claude/skills/upstream-sync/SKILL.md` (multi-upstream: OpenClaw + Paperclip)
- **Sync-lead agent:** `.claude/agents/sync-lead.md` (orchestrator with Paperclip variant)
- **Code-guard agent:** `.claude/agents/code-guard.md` (cherry-pick + Paperclip adaptation rules)
- **Sync state:** `.claude/skills/upstream-sync/state/sync-state.json` (Paperclip tracking under `paperclip` key)
- **OpenClaw sync process:** `Project-tasks/Done/upstream-selective-sync-process.md`
- Operator1 SQLite consolidation (completed): `Project-tasks/Done/operator1-config-sqlite.md`
- Operator1 architecture: `docs/operator1/architecture.md`
- Operator1 RPC reference: `docs/operator1/rpc.md`
- Current state-db schema: `src/infra/state-db/schema.ts`
- UI components: `ui-next/src/components/ui/` (shadcn/ui)

---

_Document created by Operator1 (COO) — OpenClaw Matrix_
