# Agent Console v2 — Complete Redesign Spec

> **Status:** Draft  
> **Author:** Steve (with David's direction)  
> **Date:** January 31, 2026  
> **Purpose:** Define what Agent Console actually needs to be — the real ops system for managing AI agent fleets

---

## 1. Why Redesign?

The MVP was a proof of concept. It had:
- Pretty landing page ✓
- Basic dashboard with agent cards ✓
- Vikunja integration for tasks ✓

But it lacked:
- Real task/session/agent relationships (just Vikunja labels as workaround)
- Any intervention capabilities (can't pause, inject, redirect)
- Commenting, tagging, activity feeds
- Proper tracking and visibility
- A coherent UX with clear page purposes
- Correct CSS (Tailwind v4 styles being overridden)

**The core problem:** It was designed as a dashboard to look at, not a system to operate from.

---

## 2. What I Actually Need (Steve's Perspective)

As the orchestrator of a sub-agent fleet (Builder, Scout, Canvas, Scribe, Sentinel, Analyst, Tester), here's what I need:

### 2.1 Fleet Visibility

**Question I ask constantly:** "What is everyone working on right now?"

I need to see at a glance:
- Which agents are idle vs. running
- What task each running agent is on
- How long they've been running
- Any errors or stuck states
- Cost accumulating in real-time

### 2.2 Task Management

**Question:** "What needs to get done, and who should do it?"

I need:
- Create tasks with clear objectives
- Assign to specific agent(s)
- Set priority, due dates, dependencies
- Tag/categorize (project, type, urgency)
- Track status: backlog → assigned → in_progress → review → done
- Link tasks to sessions (the actual work)

### 2.3 Session Tracking

**Question:** "What actually happened when the agent worked on this?"

Each task spawns session(s). I need:
- See all sessions for a task
- Session metadata: start time, duration, tokens, cost, model
- Transcript access (or summary)
- Outcome: success, partial, failed, needs_review

### 2.4 Intervention

**Question:** "Something's wrong — what can I do?"

When an agent is stuck, going off-track, or needs guidance:
- **Pause** — Stop work, hold state
- **Inject** — Send additional context/instructions mid-session
- **Redirect** — Change task or approach
- **Kill** — Terminate session
- **Handoff** — Transfer to different agent or escalate to human

### 2.5 Communication

**Question:** "What's the history and discussion around this task?"

- Comments on tasks (human or agent)
- @mentions to notify
- Activity feed showing all changes
- Status updates from agents

### 2.6 Project Organization

**Question:** "How is [MeshGuard/UndercoverAgent/etc.] progressing overall?"

- Group tasks into projects
- Project-level stats (tasks done, in progress, blocked)
- Project timeline view
- Archive completed projects

---

## 3. Data Model

### 3.1 Core Entities

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Project   │────<│    Task     │────<│   Session   │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           │
                    ┌──────┴──────┐
                    │             │
               ┌────┴────┐  ┌─────┴─────┐
               │  Agent  │  │  Comment  │
               └─────────┘  └───────────┘
```

### 3.2 Entity Details

#### Project
```typescript
interface Project {
  id: string
  name: string
  description: string
  status: 'active' | 'paused' | 'archived'
  color: string  // For visual identification
  createdAt: Date
  updatedAt: Date
  
  // Computed
  taskCount: number
  completedTaskCount: number
  activeSessionCount: number
  totalCost: number
}
```

#### Task
```typescript
interface Task {
  id: string
  projectId: string
  title: string
  description: string  // Markdown, can be detailed
  status: 'backlog' | 'assigned' | 'in_progress' | 'review' | 'done' | 'blocked'
  priority: 'low' | 'medium' | 'high' | 'urgent'
  
  assignedAgentId: string | null
  assignedAt: Date | null
  
  tags: string[]
  dueDate: Date | null
  
  // Dependencies
  blockedBy: string[]  // Task IDs this depends on
  blocks: string[]     // Task IDs that depend on this
  
  // Relationships
  parentTaskId: string | null  // For subtasks
  
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  
  // Computed
  sessionCount: number
  totalTokens: number
  totalCost: number
  totalDuration: number  // seconds
}
```

#### Session
```typescript
interface Session {
  id: string
  taskId: string
  agentId: string
  
  status: 'running' | 'paused' | 'completed' | 'failed' | 'killed'
  
  startedAt: Date
  endedAt: Date | null
  pausedAt: Date | null
  
  // Metrics
  tokensIn: number
  tokensOut: number
  cost: number
  model: string
  
  // Outcome
  outcome: 'success' | 'partial' | 'failed' | 'needs_review' | null
  outcomeNotes: string | null
  
  // For intervention
  injectedMessages: InjectedMessage[]
  
  // Link to actual session data
  openclawSessionKey: string | null
  transcriptPath: string | null
}

interface InjectedMessage {
  id: string
  content: string
  injectedAt: Date
  injectedBy: 'human' | 'agent'
}
```

#### Agent
```typescript
interface Agent {
  id: string
  name: string
  role: string
  description: string
  icon: string  // Emoji or icon name
  color: string
  
  status: 'idle' | 'running' | 'paused' | 'offline' | 'error'
  currentSessionId: string | null
  currentTaskId: string | null
  
  // Capabilities
  capabilities: string[]  // e.g., ['code', 'research', 'design']
  
  // Config
  model: string
  maxConcurrentSessions: number
  
  // Stats (computed)
  totalSessions: number
  totalTokens: number
  totalCost: number
  avgSessionDuration: number
  successRate: number
}
```

#### Comment
```typescript
interface Comment {
  id: string
  taskId: string
  authorType: 'human' | 'agent'
  authorId: string
  authorName: string
  
  content: string  // Markdown
  
  createdAt: Date
  updatedAt: Date | null
  
  // For threading
  parentCommentId: string | null
}
```

#### Activity
```typescript
interface Activity {
  id: string
  entityType: 'project' | 'task' | 'session' | 'agent'
  entityId: string
  
  action: string  // 'created', 'updated', 'assigned', 'completed', etc.
  actorType: 'human' | 'agent' | 'system'
  actorId: string
  actorName: string
  
  details: Record<string, any>  // Action-specific data
  
  createdAt: Date
}
```

---

## 4. Pages & UX

### 4.1 Navigation Structure

```
┌─────────────────────────────────────────────┐
│  Agent Console                    [User] ⚙️  │
├─────────────────────────────────────────────┤
│                                             │
│  📊 Dashboard        ← Fleet overview       │
│  📋 Tasks            ← All tasks, filters   │
│  🤖 Agents           ← Agent management     │
│  📁 Projects         ← Project list         │
│  📈 Analytics        ← Cost, performance    │
│                                             │
│  ─────────────────                          │
│  Projects:                                  │
│  • MeshGuard                                │
│  • UndercoverAgent                          │
│  • SaveState                                │
│  • Agent Console                            │
│                                             │
└─────────────────────────────────────────────┘
```

### 4.2 Page Purposes

#### Dashboard (`/`)
**Purpose:** Real-time fleet status at a glance

**Contains:**
- Agent status cards (running/idle/error counts)
- Active sessions with progress
- Recent activity feed
- Quick stats (tasks today, cost today, sessions today)
- Alerts/notifications

**NOT:** Task management, detailed analytics

#### Tasks (`/tasks`)
**Purpose:** Manage all tasks across projects

**Contains:**
- Task list with filters (status, project, agent, priority, tags)
- Kanban view option (backlog → in_progress → review → done)
- Quick-add task
- Bulk actions

**Detail view (`/tasks/[id]`):**
- Full task details
- Session history for this task
- Comments thread
- Activity log
- Actions: assign, change status, add comment

#### Agents (`/agents`)
**Purpose:** Agent configuration and individual agent views

**Contains:**
- Agent cards with current status
- Quick actions (pause all, resume all)

**Detail view (`/agents/[id]`):**
- Agent profile and config
- Current session (if running)
- Session history
- Performance stats
- Assigned tasks

#### Projects (`/projects`)
**Purpose:** Project-level organization and tracking

**Contains:**
- Project cards with progress indicators
- Create new project

**Detail view (`/projects/[id]`):**
- Project overview and stats
- Task list for this project
- Timeline/Gantt view
- Team (which agents work on this)

#### Analytics (`/analytics`)
**Purpose:** Cost tracking, performance metrics, trends

**Contains:**
- Cost over time (by agent, by project)
- Token usage
- Session success rates
- Agent utilization
- Trends and forecasts

### 4.3 Key Interactions

#### Assigning a Task
1. Create or select task
2. Click "Assign" → Agent picker
3. Agent receives task → Status becomes "assigned"
4. Agent starts work → Session created, status "in_progress"

#### Intervening in a Session
1. See running session on Dashboard or Agent page
2. Click session → Intervention panel slides in
3. Options:
   - **Inject:** Text input → sends message into session
   - **Pause:** Stops session, holds state
   - **Resume:** Continues paused session
   - **Redirect:** Change task/instructions
   - **Kill:** Terminate immediately

#### Completing a Task
1. Agent finishes session → Outcome recorded
2. Task status → "review" (if needs_review) or "done" (if success)
3. Human can review, add comments, reopen if needed

---

## 5. Technical Architecture

### 5.1 Stack

- **Frontend:** Next.js 15, React 19, Tailwind CSS v4
- **Real-time:** Server-Sent Events (SSE) for status updates
- **Database:** PostgreSQL (Neon serverless)
- **Auth:** Better Auth or Clerk
- **API:** Next.js API routes + tRPC or REST

### 5.2 OpenClaw Integration

Agent Console connects to OpenClaw gateway(s) to:
- Get real-time session status
- Send intervention commands
- Receive session completion events
- Access session transcripts

**Integration points:**
```
Agent Console ←→ OpenClaw Gateway
                    │
                    ├── GET /api/sessions (list active)
                    ├── GET /api/sessions/:id (status, transcript)
                    ├── POST /api/sessions/:id/inject (send message)
                    ├── POST /api/sessions/:id/pause
                    ├── POST /api/sessions/:id/resume
                    ├── POST /api/sessions/:id/kill
                    └── SSE /api/sessions/stream (real-time updates)
```

### 5.3 CSS Fix (Tailwind v4)

**Problem:** Global CSS overriding Tailwind utilities

**Solution:** Ensure all custom CSS is in appropriate layers:
```css
@import "tailwindcss";

@layer base {
  /* Theme variables, html/body styles */
}

@layer components {
  /* Custom component classes */
}

@layer utilities {
  /* Custom utilities */
}

/* NO unlayered CSS - it overrides everything! */
```

---

## 6. Implementation Phases

### Phase 1: Foundation (Week 1)
- [ ] Fix CSS/Tailwind issues
- [ ] Set up PostgreSQL schema
- [ ] Implement core entities (Project, Task, Agent, Session)
- [ ] Basic CRUD API
- [ ] Redesign Dashboard with real data

### Phase 2: Task Management (Week 2)
- [ ] Tasks page with filters
- [ ] Task detail view
- [ ] Comments system
- [ ] Activity feed
- [ ] Kanban view

### Phase 3: Agent Operations (Week 3)
- [ ] Agents page redesign
- [ ] OpenClaw gateway integration
- [ ] Real-time session status (SSE)
- [ ] Intervention controls (pause, inject, kill)

### Phase 4: Projects & Analytics (Week 4)
- [ ] Projects page
- [ ] Project detail with timeline
- [ ] Analytics dashboard
- [ ] Cost tracking

### Phase 5: Polish & Launch
- [ ] Mobile optimization
- [ ] Onboarding flow
- [ ] Documentation
- [ ] Stripe integration
- [ ] Public launch

---

## 7. Open Questions

1. **Multi-gateway support?** Should one Agent Console connect to multiple OpenClaw instances?

2. **Human tasks?** Should tasks be assignable to humans too, or agents only?

3. **Approval workflows?** Should some task completions require human approval?

4. **Notifications?** How to notify humans of important events (Telegram, email, in-app)?

5. **API access?** Should Agent Console expose an API for external integrations?

6. **Self-hosting?** Will this be SaaS-only or also self-hostable?

---

## 8. Success Metrics

- **Adoption:** Daily active users, sessions monitored
- **Engagement:** Tasks created, interventions made
- **Value:** Time saved, errors caught via monitoring
- **Revenue:** MRR from paid tiers

---

*This is the system I want to operate from. Let's build it right.*
