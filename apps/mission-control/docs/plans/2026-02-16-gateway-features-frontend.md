# Gateway Features Frontend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface all missing OpenClaw gateway backend features in the Mission Control frontend with clear descriptions, emojis, and ease-of-use focus.

**Architecture:** All API routes and client methods already exist. This is purely frontend work — creating new views and enhancing existing ones to display data from the gateway.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, Tailwind CSS 4, Radix UI, Lucide icons

**UX Requirements:** Our own UI design. Extremely easy to use. Emojis for visual clarity. Descriptions explaining what each feature is and how to leverage it.

---

### Task 1: Add "channels" ViewId to Sidebar + page.tsx

**Files:**
- Modify: `src/components/layout/sidebar.tsx`
- Modify: `src/app/page.tsx`

**Step 1: Add "channels" to VALID_VIEWS and NAV_ITEMS in sidebar.tsx**

In the VALID_VIEWS array, add `"channels"` after `"integrations"`.
In NAV_ITEMS, add a channels entry with `Radio` icon and label "Channels".
In NAV_GROUPS, add `"channels"` to the "Configure" group after "integrations".

**Step 2: Import ChannelsView in page.tsx and add render case**

Add: `import { ChannelsView } from "@/components/views/channels-view";`
Add render case: `{activeView === "channels" && <ChannelsView />}`

**Step 3: Verify TypeScript compiles** (will fail until Task 2 creates the component — that's OK)

**Step 4: Commit**

```
git add src/components/layout/sidebar.tsx src/app/page.tsx
git commit -m "feat: add channels view to sidebar navigation"
```

---

### Task 2: Channels Dashboard View

**Files:**
- Create: `src/components/views/channels-view.tsx`

**Purpose:** Show all messaging channels managed by the gateway (Telegram, WhatsApp, Discord, Slack, Signal, iMessage, Google Chat, Teams, Matrix, LINE) with real-time status, profile mapping, and setup guidance.

**Layout:**
1. **Header** — Title with 📡 emoji, description explaining what channels are and how to use them, Refresh button
2. **Stats ribbon** — Total channels, Connected count, Disconnected count, Profile-mapped count
3. **Channel grid** (2 columns on desktop) — One card per channel type showing:
   - Channel icon + name + status badge (Connected/Disconnected/Error)
   - Account info if configured
   - Last activity timestamp
   - "Configure in Gateway" link to :18789
   - Profile mapping indicator (which profile uses this channel)
4. **Setup guide panel** — Collapsible panel explaining: "Channels are managed by the OpenClaw gateway. To add a new channel: 1) Open the gateway dashboard 2) Configure your account 3) Come back here to map it to your profile"
5. **Degraded state** — Warning banner when gateway is offline

**Data source:** `GET /api/openclaw/channels` (already exists, returns `{ channels: [...], degraded?: boolean }`)

**Profile integration:** Fetch active profile's `profile_integrations` to show which channels are mapped.

Follow the glass-panel design system. Use `ai-specialists.tsx` as the reference for layout patterns.

**Step 1: Create the component**

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```
git add src/components/views/channels-view.tsx
git commit -m "feat: add Channels Dashboard view with status, profile mapping, and setup guide"
```

---

### Task 3: Add "skills" ViewId to Sidebar + page.tsx

**Files:**
- Modify: `src/components/layout/sidebar.tsx`
- Modify: `src/app/page.tsx`

Same pattern as Task 1 but for "skills":
- Add `"skills"` to VALID_VIEWS after `"tools"`
- Add NAV_ITEM with `Wrench` icon and label "Skills"
- Add to "Configure" group after "tools"
- Import `SkillsDashboard` in page.tsx and add render case

**Step 1: Commit**

```
git add src/components/layout/sidebar.tsx src/app/page.tsx
git commit -m "feat: add skills view to sidebar navigation"
```

---

### Task 4: Skills Dashboard View

**Files:**
- Create: `src/components/views/skills-dashboard.tsx`

**Purpose:** Show all platform-level skills/capabilities available in the gateway — what agents can do, which skills are active, and how to leverage them.

**Layout:**
1. **Header** — Title with ⚡ emoji, description: "Skills are the capabilities your AI agents can use — from web browsing to code execution. Each skill extends what your agents can do."
2. **Stats ribbon** — Total skills, Enabled, Disabled, Categories
3. **Search + category filter bar**
4. **Skill cards** (3 columns on desktop) — Each card:
   - Skill name + version badge
   - Status indicator (enabled/disabled)
   - Description of what the skill does
   - Category badge
   - Which agents use this skill (if determinable)
5. **Empty state** — "No skills detected. Make sure the OpenClaw gateway is running."
6. **Degraded state** — Warning banner

**Data source:** `GET /api/openclaw/skills` (already exists)

Follow glass-panel design. Reference `ai-specialists.tsx` for grid + filter patterns.

**Step 1: Create the component**

**Step 2: Verify TypeScript compiles**

**Step 3: Commit**

```
git add src/components/views/skills-dashboard.tsx
git commit -m "feat: add Skills Dashboard view with search, categories, and agent associations"
```

---

### Task 5: TTS in Tools Playground

**Files:**
- Modify: `src/app/api/openclaw/tools/route.ts` (add TTS methods to whitelist)
- Modify: `src/components/views/tools-playground.tsx` (add TTS tools to catalog)

**Step 1: Add TTS methods to ALLOWED_METHODS whitelist**

Add to the Set: `"tts.status"`, `"tts.providers"`, `"tts.convert"`

**Step 2: Add TTS tools to TOOL_CATALOG**

Add a new "TTS" category with 3 tools:
- `tts_status` — "🔊 Check text-to-speech engine status and availability"
- `tts_providers` — "🎙️ List available TTS providers (OpenAI, ElevenLabs, etc.)"
- `tts_convert` — "🗣️ Convert text to speech audio" (with text and provider params)

**Step 3: Verify TypeScript compiles**

**Step 4: Commit**

```
git add src/app/api/openclaw/tools/route.ts src/components/views/tools-playground.tsx
git commit -m "feat: add TTS tools to Tools Playground"
```

---

### Task 6: Nodes Section in Settings Panel

**Files:**
- Modify: `src/components/views/settings-panel.tsx`

**Purpose:** Show cluster node information in the Settings panel for infrastructure visibility.

**Implementation:**
1. Add a new collapsible section "🖥️ Cluster Nodes" after the "Gateway Connection" section
2. Description: "View the OpenClaw gateway nodes in your cluster. Each node handles agent workloads independently."
3. Fetch from `GET /api/openclaw/nodes` on section open
4. Show each node as a card with: node ID, status badge, health indicator
5. Add "View Details" button that shows full node description
6. Handle empty state: "No nodes found — the gateway may be running in standalone mode."
7. Handle loading/error states

**Step 1: Add the section**

**Step 2: Verify TypeScript compiles**

**Step 3: Commit**

```
git add src/components/views/settings-panel.tsx
git commit -m "feat: add Cluster Nodes section to Settings panel"
```

---

### Task 7: Cron Run History

**Files:**
- Modify: `src/components/views/cron-scheduler.tsx`

**Purpose:** Show execution history for each scheduled job.

**Implementation:**
1. When a cron job card is expanded, add a "📜 Recent Runs" section below the existing metadata
2. Fetch run history from `GET /api/openclaw/cron?runs={jobId}` on expand
3. Show last 5 runs with: status badge (success/failed/running), timestamp, duration
4. Color coding: green for success, red for failed, amber for running
5. "No runs yet" empty state
6. Add cron system status (from `cronStatus()`) to the scheduler header — "X jobs active, scheduler running"

**Step 1: Add the run history section**

**Step 2: Verify TypeScript compiles**

**Step 3: Commit**

```
git add src/components/views/cron-scheduler.tsx
git commit -m "feat: add cron run history and scheduler status display"
```

---

### Task 8: Agent Files Editor

**Files:**
- Create: `src/app/api/agents/files/route.ts`
- Modify: `src/components/views/agents-view.tsx`

**Purpose:** Allow viewing and editing agent configuration files (SOUL.md, etc.) directly from the Agents view.

**Implementation:**

**API Route (new):**
- GET `/api/agents/files?agentId=X&name=Y` — fetch file content via `client.getAgentFile()`
- POST `/api/agents/files` — save file content via `client.setAgentFile()`

**UI Enhancement:**
1. Make agent cards in AgentsView clickable to open a detail dialog
2. Dialog shows tabbed file editor with known file types (SOUL.md, INSTRUCTIONS.md)
3. Textarea editor with monospace font
4. Save button that calls POST API
5. Description: "📝 Edit your agent's personality and instructions. Changes take effect immediately."

**Step 1: Create the API route**

**Step 2: Add the editor dialog to agents-view**

**Step 3: Verify TypeScript compiles**

**Step 4: Commit**

```
git add src/app/api/agents/files/route.ts src/components/views/agents-view.tsx
git commit -m "feat: add agent file editor to Agents view"
```

---

### Task 9: Final Verification

**Step 1: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: Start dev server and test each feature in browser**

Test checklist:
- Channels view appears in sidebar, shows channel cards with status
- Skills view appears in sidebar, shows skill cards with search
- TTS tools appear in Tools Playground
- Nodes section appears in Settings (collapsible)
- Cron run history loads when job is expanded
- Agent file editor opens from Agents view
- All views handle gateway-offline gracefully
- Profile switcher still works correctly
- All descriptions/emojis render properly

**Step 3: Commit and push**

```
git add -A
git commit -m "feat: surface all gateway backend features in Mission Control frontend"
git push
```
