# Mission Control — Project Directory

> Complete map of the codebase with naming standards and conventions.

**Last updated:** 2026-02-16
**Total source lines:** ~38,000
**Main entry:** `page.tsx` (565 lines — fully refactored)

---

## Folder Structure

```
apps/dashboard/
├── bin/
│   └── cli.mjs                    # npx entry point, setup wizard
├── data/
│   └── mission-control.db         # SQLite database (auto-created)
├── public/                        # Static assets
├── resources/                     # Screenshots, design refs
├── scripts/                       # Utility scripts
├── src/
│   ├── app/
│   │   ├── api/                   # API routes (52+ endpoints)
│   │   ├── globals.css            # Tailwind + design tokens
│   │   ├── layout.tsx             # Root layout
│   │   └── page.tsx               # Main dashboard (565 LOC)
│   ├── components/
│   │   ├── ui/                    # Shadcn primitives (9 components)
│   │   ├── layout/                # Layout components (sidebar, header)
│   │   └── views/                 # Feature view components (22 views)
│   └── lib/                       # Utilities & services (28 modules + hooks)
├── CHANGELOG.md
├── DIRECTORY.md                   # This file
└── README.md                      # User documentation
```

---

## File Index by Size

### View Components (`src/components/views/`) — 22 files, ~20,000 LOC

| File | Lines | Purpose |
|------|-------|---------|
| `ai-specialists.tsx` | 2,965 | AI specialist management and recommendations |
| `chat-panel.tsx` | 1,618 | Agent chat interface with sessions |
| `learning-hub.tsx` | 1,506 | Curated AI tips, lessons, notifications |
| `approval-center.tsx` | 1,385 | Command approval queue |
| `settings-panel.tsx` | 1,279+ | Config, preferences, integrations, API keys, local models |
| `agent-chat.tsx` | 1,196 | Direct agent conversation UI |
| `employees-view.tsx` | 1,169 | Employee management, org chart, access control |
| `tools-playground.tsx` | 1,071 | RPC testing interface |
| `quick-actions.tsx` | 1,027 | Action buttons, shortcuts |
| `orchestrator.tsx` | 871 | Parallel task orchestration |
| `plugins-registry.tsx` | — | Plugin Registry view (browse 26+ plugins by category) |
| `cron-scheduler.tsx` | 656 | Scheduled jobs UI |
| `cost-dashboard.tsx` | 621 | Usage & cost tracking |
| `logs-viewer.tsx` | 434 | Gateway log stream |
| `skills-dashboard.tsx` | 396+ | Agent skills overview (gateway + plugin skills) |
| `overview-command-center.tsx` | 374 | Dashboard command center |
| `channels-view.tsx` | 374 | Communication channels |
| `agents-view.tsx` | 326 | Agent listing and status |
| `integrations-view.tsx` | 322 | Integration management |
| `all-tools.tsx` | 216+ | Full ecosystem directory (tools, plugins, MCP, specialists) |
| `missions-view.tsx` | 134 | Mission listing |

### API Routes (`src/app/api/`) — 52+ endpoints, ~6,200 LOC

| Route | Lines | Purpose |
|-------|-------|---------|
| `learning-hub/lessons/route.ts` | 485 | Lesson CRUD and progress |
| `openclaw/approvals/route.ts` | 417 | Approval queue management |
| `tasks/route.ts` | 303 | Task CRUD |
| `tasks/dispatch/route.ts` | 285 | Dispatch task to agent |
| `orchestrator/route.ts` | 248 | Parallel task dispatch |
| `search/route.ts` | 213 | Global search |
| `chat/route.ts` | 210 | Agent conversation |
| `openclaw/events/route.ts` | 201 | Gateway event stream |
| `models/route.ts` | 199 | Available AI models |
| `employees/seed/route.ts` | 187 | Employee seed data |
| `chat/attachments/route.ts` | 174 | Chat file attachments |
| `chat/sessions/route.ts` | 166 | Chat session management |
| `workspaces/route.ts` | 146 | Workspace CRUD |
| `openclaw/restart/route.ts` | 139 | Gateway restart |
| `missions/route.ts` | 133 | Mission CRUD |
| `profiles/route.ts` | 130 | User profile management |
| `employees/route.ts` | 126 | Employee CRUD |
| `chat/council/route.ts` | 120 | Multi-agent council chat |
| `employees/access/route.ts` | 105 | Employee access control |
| `agents/specialists/feedback/route.ts` | 96 | Specialist feedback |
| `openclaw/cron/route.ts` | 92 | Cron job management |
| `tasks/rework/route.ts` | 87 | Re-dispatch task |
| `openclaw/tools/route.ts` | 83 | RPC call passthrough |
| `profiles/workspaces/route.ts` | 78 | Profile workspace mapping |
| `openclaw/connectivity/route.ts` | 75 | Gateway connectivity check |
| `agents/specialists/route.ts` | 68 | AI specialist listing |
| `accounts/route.ts` | 68 | Account management |
| `tasks/comments/route.ts` | 66 | Task comments |
| `auth/session/route.ts` | 66 | Auth session management |
| `openclaw/usage/route.ts` | 61 | Token usage stats |
| `integrations/route.ts` | 58 | Integration config |
| `employees/hierarchy/route.ts` | 58 | Employee org hierarchy |
| `agents/specialists/recommend/route.ts` | 56 | Specialist recommendations |
| `openclaw/sessions/route.ts` | 53 | Gateway sessions |
| `agents/route.ts` | 44 | Agent listing from gateway |
| `openclaw/status/route.ts` | 41 | Gateway status |
| `openclaw/nodes/route.ts` | 40 | Gateway node listing |
| `agents/files/route.ts` | 39 | Agent file management |
| `tasks/check-completion/route.ts` | 38 | Poll task status |
| `openclaw/config/route.ts` | 31 | Gateway config |
| `agents/specialists/suggestions/route.ts` | 27 | Specialist suggestions |
| `activity/route.ts` | 23 | Activity feed |
| `openclaw/skills/route.ts` | 22 | Skill listing |
| `openclaw/logs/route.ts` | 22 | Gateway logs |
| `openclaw/channels/route.ts` | 22 | Channel listing |
| `csrf-token/route.ts` | 8 | CSRF token endpoint |
| `plugins/route.ts` | — | Plugin catalog (skills, agents, MCP servers) |
| `settings/api-keys/route.ts` | — | API key CRUD (GET/POST/PATCH/DELETE) |
| `settings/models/route.ts` | — | Local model CRUD (GET/POST/PATCH/DELETE) |

### Library (`src/lib/`) — 28 modules + hooks, ~12,000 LOC

| File | Lines | Purpose |
|------|-------|---------|
| `agent-registry.ts` | 2,841+ | Agent registry and management (11 specialists: 6 engineering + 5 business) |
| `db.ts` | 1,407+ | SQLite schema, CRUD, migrations (includes api_keys and local_models tables) |
| `openclaw-client.ts` | 866 | WebSocket client, RPC methods |
| `approvals.ts` | 705 | Approval logic and workflows |
| `file-utils.ts` | 538 | File handling utilities |
| `specialist-intelligence.ts` | 515 | AI specialist matching |
| `schemas.ts` | 505 | Zod validation schemas |
| `specialist-suggestions.ts` | 417 | Specialist recommendation engine |
| `agent-task-monitor.ts` | 378 | Background completion checker |
| `model-catalog.ts` | 308 | AI model catalog |
| `plugin-scanner.ts` | — | Plugin directory scanner (scans Claude Code plugins for skills, agents, MCP servers) |
| `errors.ts` | 181 | Error handling utilities |
| `shared.ts` | 167 | Shared utilities (timeAgo, formatTime, etc.) |
| `model-fallback.ts` | 150 | Model fallback logic |
| `rate-limit.ts` | 149 | Rate limiting |
| `csrf.ts` | 131 | CSRF protection |
| `validation.ts` | 129 | Input validation |
| `integrations.ts` | 129 | Integration client |
| `auth.ts` | 98 | Authentication logic |
| `undo-manager.ts` | 92 | Undo/redo state management |
| `api-guard.ts` | 59 | API authentication guard |
| `task-workflow.ts` | 40 | Task state machine |
| `sanitize.ts` | 41 | Input sanitization |
| `workspaces-server.ts` | 28 | Server-side workspace utils |
| `workspaces.ts` | 12 | Client-side workspace utils |
| `utils.ts` | 6 | Tailwind merge helper |

**Hooks (`src/lib/hooks/`):**

| File | Lines | Purpose |
|------|-------|---------|
| `use-tasks.ts` | 365 | Task state & actions |
| `use-polling.ts` | 330 | Polling intervals |
| `use-gateway-events.ts` | 189 | Gateway event listener |
| `use-profiles.ts` | 132 | Profile management |
| `use-gateway-telemetry.ts` | 68 | Gateway telemetry |

### Layout Components (`src/components/layout/`)

| File | Purpose |
|------|---------|
| `sidebar.tsx` | Main navigation sidebar (updated: includes Plugins nav item) |

### UI Primitives (`src/components/ui/`) — 9 components

| File | Source | Purpose |
|------|--------|---------|
| `badge.tsx` | shadcn | Status badges |
| `button.tsx` | shadcn | Button variants |
| `card.tsx` | shadcn | Card container |
| `dialog.tsx` | shadcn | Modal dialogs |
| `popover.tsx` | shadcn | Popover menus |
| `scroll-area.tsx` | shadcn | Custom scrollbars |
| `select.tsx` | shadcn | Dropdown select |
| `separator.tsx` | shadcn | Divider line |
| `tooltip.tsx` | shadcn | Hover tooltips |

---

## New & Updated Files (Plugin Ecosystem, API Keys, Local Models)

### New Files

| File | Purpose |
|------|---------|
| `src/lib/plugin-scanner.ts` | Scans Claude Code plugin directories for installed plugins, skills, agents, and MCP servers |
| `src/components/views/plugins-registry.tsx` | Plugin Registry view — browse all 26+ installed plugins organized by category |
| `src/app/api/plugins/route.ts` | Plugin catalog API endpoint — returns aggregated plugin data with skills, agents, MCP servers |
| `src/app/api/settings/api-keys/route.ts` | API key management endpoint — CRUD for 11+ AI provider keys with connection testing |
| `src/app/api/settings/models/route.ts` | Local model management endpoint — CRUD for Ollama and self-hosted model configurations |

### Updated Files

| File | Changes |
|------|---------|
| `src/lib/db.ts` | Added `api_keys` and `local_models` database tables with migrations |
| `src/components/views/settings-panel.tsx` | Added API Keys management section and Local Models configuration section |
| `src/components/views/skills-dashboard.tsx` | Integrated plugin skills alongside gateway skills for a unified view |
| `src/components/views/all-tools.tsx` | Expanded to full ecosystem directory (gateway tools + plugin skills + MCP servers + AI specialists) |
| `src/components/layout/sidebar.tsx` | Added Plugins navigation item to the sidebar |
| `src/lib/agent-registry.ts` | Added 5 new business/leadership AI specialists (total: 11 — 6 engineering + 5 business) |

---

## Naming Standards

### Files

| Type | Convention | Example |
|------|------------|---------|
| View components | `kebab-case.tsx` | `cost-dashboard.tsx` |
| API routes | `route.ts` in folder | `api/tasks/route.ts` |
| Library modules | `kebab-case.ts` | `openclaw-client.ts` |
| UI primitives | `kebab-case.tsx` | `scroll-area.tsx` |

### Components

| Type | Convention | Example |
|------|------------|---------|
| React components | `PascalCase` | `CostDashboard` |
| Hooks | `useCamelCase` | `usePolling` |
| Utilities | `camelCase` | `getOpenClawClient()` |

### API Patterns

| Action | Method | Route Pattern |
|--------|--------|---------------|
| List | GET | `/api/{resource}` |
| Create | POST | `/api/{resource}` |
| Update | PATCH | `/api/{resource}` |
| Delete | DELETE | `/api/{resource}` |
| Action | POST | `/api/{resource}/{action}` |

### Database

| Type | Convention | Example |
|------|------------|---------|
| Tables | `snake_case` plural | `task_comments` |
| Columns | `snake_case` | `assigned_agent_id` |
| Foreign keys | `{table}_id` | `mission_id` |
| Timestamps | `*_at` | `created_at`, `updated_at` |

---

## Database Schema

**Location:** `data/mission-control.db` (SQLite)

### Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `missions` | Task groupings | id, name, status |
| `tasks` | Individual work items | id, title, status, priority, assigned_agent_id, employee_id |
| `task_comments` | Agent/user comments | id, task_id, content, author_type |
| `activity_log` | Audit trail | id, type, message, metadata |
| `employees` | AI employees | id, name, role_key, department, manager_id, workspace_id |
| `employee_access` | Account permissions | id, employee_id, account_id, mode |
| `accounts` | Connected accounts | id, service, label, region, workspace_id |
| `workspaces` | Workspace config | id, name, gateway_url |
| `profiles` | User profiles | id, display_name, workspace_id |
| `chat_sessions` | Chat history | id, agent_id, title |
| `api_keys` | AI provider API keys | id, provider, key (encrypted), enabled, last_tested_at |
| `local_models` | Locally-running models | id, name, provider, base_url, model_id, status |

---

## Dependencies

### Runtime

| Package | Version | Purpose |
|---------|---------|---------|
| `next` | 16.1.6 | Framework |
| `react` | 19.2.3 | UI |
| `better-sqlite3` | 12.6.2 | Database |
| `ws` | 8.19.0 | WebSocket client |
| `@dnd-kit/*` | 6.3+ | Drag-and-drop |
| `radix-ui` | 1.4.3 | UI primitives |
| `lucide-react` | 0.563.0 | Icons |
| `uuid` | 13.0.0 | ID generation |
| `zod` | latest | Schema validation |

---

*This directory is manually maintained. Update when adding new files.*
