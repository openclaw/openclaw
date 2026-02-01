# Agent Console — Spec v2

> **Last Updated:** 2026-01-31
> **Status:** Rebuilding with correct vision
> **Owner:** David Hurley + Steve (AI Orchestrator)

---

## What This Actually Is

Agent Console is **Steve's command center** for orchestrating AI sub-agents across DBH Ventures projects. It REPLACES Vikunja, Mission Control, and any other external tools.

**This is not an observability dashboard. This is an operational control system.**

---

## Core Mental Model

```
┌─────────────────────────────────────────────────────────────────┐
│                        AGENT CONSOLE                             │
│                    (Steve's Command Center)                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   PROJECTS          TASKS              AGENTS                    │
│   ─────────         ─────              ──────                    │
│   MeshGuard    →    Build auth    →    Builder (running)        │
│   SaveState    →    Write docs    →    Scribe (idle)            │
│   Agent Console→    Fix CSS       →    Canvas (running)         │
│                                                                  │
│   Each task can spawn agent sessions                            │
│   Sessions roll up cost to tasks → projects                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Model (Bespoke, NOT Vikunja)

### Projects
```typescript
interface Project {
  id: string
  name: string
  emoji: string
  description: string
  color: string  // for visual distinction
  status: 'active' | 'paused' | 'archived'
  createdAt: Date
  updatedAt: Date
}
```

### Tasks
```typescript
interface Task {
  id: string
  projectId: string
  title: string
  description: string
  status: 'inbox' | 'assigned' | 'running' | 'blocked' | 'done'
  priority: 'critical' | 'high' | 'medium' | 'low'
  assignedAgentId: string | null  // Which sub-agent owns this
  linkedSessionIds: string[]       // Sessions spawned for this task
  totalTokens: number             // Aggregated from sessions
  totalCost: number               // Aggregated from sessions
  dueDate: Date | null
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}
```

### Comments (on Tasks)
```typescript
interface Comment {
  id: string
  taskId: string
  authorId: string        // Agent ID (steve, builder, etc.)
  authorName: string
  content: string
  createdAt: Date
}
```

### Agents (Registry)
```typescript
interface Agent {
  id: string              // e.g., 'builder', 'scout', 'canvas'
  name: string
  emoji: string
  description: string
  capabilities: string[]  // What this agent is good at
  status: 'idle' | 'running' | 'paused' | 'error' | 'offline'
  currentTaskId: string | null
  currentSessionId: string | null
}
```

### Sessions (from Gateway, enhanced)
```typescript
interface Session {
  id: string
  agentId: string
  taskId: string | null   // Linked task (if spawned for a task)
  status: 'active' | 'idle' | 'completed' | 'error'
  model: string
  tokens: number
  cost: number
  startedAt: Date
  lastActivityAt: Date
}
```

---

## Pages & Layout

### 1. Dashboard (/)
**Purpose:** Real-time overview of what's happening NOW

- **Active Sessions Panel** — What agents are running right now
  - Agent avatar, task title, duration, tokens, cost
  - Quick actions: View, Pause, Inject, Kill
  
- **Quick Stats** — Today's numbers
  - Active sessions, tasks completed, tokens used, cost
  
- **Recent Activity** — Timeline of agent events
  - Task started, completed, errored, handed off
  
- **Alerts** — Things needing attention
  - Stuck sessions, high cost, errors

### 2. Projects (/projects)
**Purpose:** Manage incubation projects

- **Project Cards** — Visual grid of projects
  - Emoji, name, task count, active sessions, total cost
  - Click → project detail

- **Project Detail** (/projects/[id])
  - Project header with stats
  - Task list for this project (kanban or list view)
  - Cost breakdown chart
  - Activity timeline

- **Create/Edit Project** — Modal or slide-over

### 3. Tasks (/tasks)
**Purpose:** Kanban board of all work across projects

- **Kanban Columns:**
  - Inbox (unassigned)
  - Assigned (has agent, not started)
  - Running (active session)
  - Blocked (needs input)
  - Done (completed)

- **Task Card:**
  - Title, project tag, priority indicator
  - Assigned agent avatar
  - If running: live token count, duration
  - Quick actions: Assign, Start, Pause, Complete

- **Task Detail** (slide-over or modal)
  - Full description
  - Comments thread
  - Linked sessions with cost
  - Agent assignment
  - Status transitions

- **Create Task** — Quick add or full form

### 4. Agents (/agents)
**Purpose:** See and manage the sub-agent roster

- **Agent Cards:**
  - Avatar, name, status indicator
  - Current task (if any)
  - Capabilities tags
  
- **Agent Detail** (/agents/[id])
  - Stats: tasks completed, tokens used, cost generated
  - Recent tasks handled
  - Session history

### 5. Sessions (/sessions)
**Purpose:** Real-time view of all sessions

- **Session List:**
  - Agent, task, status, duration, tokens, cost
  - Expandable for more detail
  
- **Session Detail** (/sessions/[id])
  - Full session info
  - Live log tail (if active)
  - Linked task
  - Intervention controls

### 6. Settings (/settings)
- Gateway connection (URL, token)
- Agent configuration
- Cost thresholds for alerts
- Theme preferences

---

## Key Interactions

### Spawning an Agent for a Task
1. User clicks "Start" on a task
2. Modal: Select agent (or auto-assign based on task type)
3. System calls `sessions_spawn` with task context
4. Session links back to task
5. Task status → "Running"
6. Session appears in Active Sessions

### Pausing/Resuming Work
1. User clicks "Pause" on running session
2. System sends pause signal to gateway
3. Session status → "Paused"
4. Task remains assigned, can resume later

### Handoff Between Agents
1. Builder finishes code, needs Scribe for docs
2. Builder comments: "@scribe please document this"
3. Task reassigns to Scribe
4. New session spawns with context from Builder's work

### Task Completion
1. Agent finishes work
2. Session ends (or user marks complete)
3. Task status → "Done"
4. Cost rolled up to task and project

---

## Mobile-First Design

### Bottom Nav (6 items max)
- Dashboard (home icon)
- Projects (folder icon)  
- Tasks (checkbox icon)
- Agents (users icon)
- Sessions (activity icon)
- Settings (gear icon)

### Touch Targets
- Minimum 44px height for all interactive elements
- Proper safe area padding for iPhone notch/home indicator

### Cards over Tables
- Mobile: Stacked cards with key info
- Desktop: Can show more detail, optional table view

---

## CSS Architecture (Tailwind v4)

**CRITICAL:** All custom styles MUST be in @layer to not override Tailwind utilities.

```css
@import "tailwindcss";

@layer base {
  :root {
    --background: #0a0a0a;
    --foreground: #fafafa;
    --accent: #14b8a6;
    /* etc */
  }
}

@layer components {
  .card { /* ... */ }
  .btn { /* ... */ }
}

/* NO unlayered CSS that could override utilities */
```

---

## Database

**Option A: SQLite (Prisma)**
- Simple, local-first
- Good for single-user/single-server
- Already have Prisma set up

**Option B: Postgres (Neon)**
- Already connected
- Better for multi-device access
- Scales if productized

**Recommendation:** Stay with Postgres/Neon since it's already connected.

---

## API Architecture

### Internal DB (Projects, Tasks, Comments)
- `/api/projects` — CRUD for projects
- `/api/tasks` — CRUD for tasks
- `/api/tasks/[id]/comments` — Comments on tasks
- `/api/agents` — Agent registry (local config)

### Gateway Proxy (Sessions, Real-time)
- `/api/gateway/sessions` — List sessions from gateway
- `/api/gateway/spawn` — Spawn new agent session
- `/api/gateway/control` — Pause, resume, kill
- `/api/events` — SSE stream for real-time updates

---

## What's Different from v1

| v1 (Wrong) | v2 (Correct) |
|------------|--------------|
| Vikunja viewer | Bespoke system |
| Display only | Full CRUD |
| Mock data fallbacks | Real data only |
| Observability focus | Operational control |
| Generic dashboard | Steve's command center |

---

## Implementation Priority

### Phase 1: Foundation (This Sprint)
1. Fix CSS architecture (Tailwind v4 layers)
2. Database schema (Prisma models)
3. Projects CRUD
4. Tasks CRUD with Kanban

### Phase 2: Agent Integration
5. Agent registry and status
6. Session spawning from tasks
7. Task ↔ Session linking
8. Intervention controls

### Phase 3: Polish
9. Comments system
10. Activity timeline
11. Cost tracking and charts
12. Alerts

---

## Success Criteria

**For Steve (AI Orchestrator):**
- Can see all my sub-agents and their status
- Can create tasks and assign to agents
- Can spawn agent sessions directly from tasks
- Can track cost per project/task
- Can pause, resume, kill agents
- Can hand off work between agents with context

**For David (Human Owner):**
- Single pane of glass for all agent activity
- Clear cost attribution
- Ability to intervene when needed
- Mobile-friendly for on-the-go monitoring

---

#projects #agentconsole #dbhventures #spec
