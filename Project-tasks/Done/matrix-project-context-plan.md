# Matrix Project Context Plan

> How Operator1 and the agent team handle multiple projects seamlessly

**Related docs:**

- `Project-tasks/matrix-planning-first-workflow.md` — Planning-first workflow (implemented)
- `Project-tasks/project-management-proposal.md` — SQLite-based task management (separate scope)
- `docs/reference/templates/matrix/matrix-agents.template.json` — Agent config template

---

## The Problem

The CEO (Rohit) works on multiple projects:

- **Operator1** — OpenClaw agent framework
- **Subzero App** — Mobile application
- **ui-next** — Dashboard frontend
- And potentially more in the future

Interactions happen in chat sessions with Operator1 (the COO agent). The challenge: how do we work across multiple projects without context mixing or repeating "this is for project X" every time — while also being able to **lock a session to a specific project** when focus is needed?

The agent team now includes **34 agents** across 4 tiers (Operator1, 3 department heads, 30 tier-3 specialists). Project context must flow correctly through the full spawn chain — up to 4 hops deep for engineering tasks involving ACP coding sessions.

---

## Core Principles

**Agents are employees. Projects are assignments.**

Neo (CTO) can do engineering work for any project. The project is _where_ the work happens — it's context, not a separate agent. We don't need "Subzero Neo" and "Operator1 Neo." We need **one Neo** who knows which project he's on.

**Operator1 is the Project Manager.** Operator1 has a dual role: (1) the CEO's conversational counterpart for all interactions, and (2) the project manager across all active projects. At any given time, Operator1 can be managing multiple projects simultaneously — tracking status, coordinating agents, and routing work to the right project context.

**Workspace = context.** Point an agent at a project folder, and they inherit everything in that project's `.openclaw/` directory automatically. No separate CONTEXT.md needed — the project's own workspace files (`SOUL.md`, `MEMORY.md`, `AGENTS.md`, `TOOLS.md`) _are_ the context.

**PROJECTS.md is a registry, not documentation.** The registry is lightweight — just IDs, paths, types, and status. Full project details (conventions, architecture, history) live in each project's own `.openclaw/` folder. Agents read project details on demand from the project folder itself.

**Agents are tagged to projects per session.** When an agent is spawned for a project task, they are "tagged" to that project for the duration of that session. They don't get project context re-injected per task — they carry it. This means Neo working on subzero across 3 tasks in one session doesn't need `[Project: subzero]` repeated each time.

---

## Operator1's Dual Role

### Role 1: Chat Counterpart (always active)

Operator1 is the CEO's primary interface. Handles conversations, answers questions, routes tasks, manages agent coordination. This role is always on regardless of project context.

### Role 2: Project Manager (when projects are active)

When projects are registered in PROJECTS.md, Operator1 also acts as PM:

- **Maintains PROJECTS.md** as the living registry of all projects
- **Tracks active work** — knows which agents are working on which projects (via session registry)
- **Reports project status** on request ("What's happening on subzero?")
- **Prioritizes across projects** when agent resources conflict
- **Coordinates cross-project work** when a task spans multiple projects
- **Manages project lifecycle** — adding, pausing, archiving projects

Operator1 does **not** do task-level tracking (that's the separate project-management-proposal). PM role here means project-level awareness and coordination.

---

## Two Session Modes

Every Operator1 session runs in one of two modes:

### Mode 1: Project-Focused Session

A session is explicitly linked to one project. Operator1 behaves as if that project is the only thing that exists in this conversation.

**Behaviour:**

- All tasks default to the linked project — no need to mention the project name
- All subagents spawned automatically receive the project context and are **tagged** to that project for the session
- Operator1 pushes back on clearly off-topic tasks: "This session is focused on Subzero. Want me to handle that in a separate session?"

**How a session gets linked:**

- The CEO triggers it via the UI (a project selector in the chat interface — to be implemented)
- Or by saying: "Focus this session on Subzero" / "Link to operator1 project"
- Operator1 acknowledges and confirms: "Got it. This session is now focused on **Subzero** (`~/dev/subzero-app`). I'll keep all work scoped to that project."

### Mode 2: Generic Session (No Project Linked)

No project is set. Operator1 operates as the cross-project command center — free to work across any project or handle non-project work (standups, strategy, etc.).

**Behaviour:**

- Operator1 detects project from message content (see Project Detection below)
- Confirms project before delegating: "I'll treat this as a Subzero task — is that right?"
- Non-project interactions (standup, strategy, general questions) handled directly

**When to use:**

- Morning standups, strategic planning, cross-project coordination
- CEO hasn't decided what to work on yet
- Task spans multiple projects

---

## Architecture

| Component            | Purpose                                                          | Location                            |
| -------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| `PROJECTS.md`        | Lightweight registry — project ID, path, type, status            | Operator1's workspace (auto-loaded) |
| Project `.openclaw/` | Full project context — conventions, history, tools, agent config | Each project's own folder           |

**No CONTEXT.md.** Each project already has (or can have) its own `.openclaw/` directory with `SOUL.md`, `MEMORY.md`, `AGENTS.md`, `TOOLS.md`. That _is_ the context. Duplicating it into a separate CONTEXT.md creates maintenance burden for zero benefit.

---

## Project Folder Conventions

Projects live in two places depending on how they originate:

### Internal Projects (new, created via Operator1)

When a new project is started from scratch through Operator1, it gets created under a standard location inside the operator1 repo:

```
~/dev/operator1/Projects/{project-id}/
  .openclaw/
    SOUL.md       # Project identity, goals, architecture overview
    MEMORY.md     # Project history, decisions, blockers
    AGENTS.md     # Coding conventions, workflow rules, team assignments
    TOOLS.md      # Project-specific tools, scripts, ACP harness preference
  src/            # Project source code
  ...
```

**Default projects folder:** `~/dev/operator1/Projects/`

This folder is **gitignored in the operator1 repo** but each project inside it manages its own git repository independently. This keeps projects organized and discoverable without polluting the operator1 repo history.

The `matrix project add` command (or Operator1 directly) scaffolds the `.openclaw/` directory with sensible defaults when creating a new project.

### External Projects (existing repos)

Projects that already exist elsewhere on disk (e.g. `~/dev/subzero-app`) stay where they are. The system handles this by:

1. **PROJECTS.md points to the actual path** — no need to move anything
2. **`.openclaw/` is scaffolded on first use** — when Operator1 first spawns an agent for an external project without `.openclaw/`, it asks the CEO: "Project doesn't have a workspace yet. Create default `.openclaw/` files?" No auto-creation without confirmation.
3. **Agent workspace switching** — when spawning an agent for an external project, the task string includes the project path and the agent navigates there via shell

Both scenarios are first-class. PROJECTS.md is the single source of truth for where each project lives.

---

## Project `.openclaw/` Scaffolding

When a project gets its `.openclaw/` directory (whether internal or external), these files are created. **Step 6 in the implementation order is manual creation** using the templates below — no CLI scaffolding command exists yet.

### SOUL.md (Project Identity)

```markdown
# {Project Name}

## What This Project Is

[One-paragraph description of the project, its purpose, and target users]

## Architecture Overview

[High-level architecture — key modules, data flow, deployment model]

## Current Phase

[MVP / Active Development / Maintenance / etc.]

## Key Decisions

[Major architectural or technical decisions and why they were made]
```

### AGENTS.md (Coding Conventions & Workflow)

```markdown
# {Project Name} — Agent Conventions

## Tech Stack

[Languages, frameworks, key dependencies, package manager]

## Code Conventions

[Naming, file organization, import style, test patterns]

## Build & Test

[How to build, run, test — exact commands]

## Deployment

[How to deploy, environments, CI/CD notes]

## Team Assignments

[Which agents/departments handle which areas of this project]
```

### MEMORY.md (Project History)

```markdown
# {Project Name} — Project Memory

## Decisions Log

<!-- Project-level decisions with date and rationale -->

## Known Issues

<!-- Active bugs, tech debt, or blockers -->

## Key Learnings

<!-- What worked, what didn't, patterns discovered -->
```

### TOOLS.md (Project Tools & ACP Preference)

```markdown
# {Project Name} — Tools

## ACP Harness Preference

Default: `claude` (Claude Code)
[Why this harness, when to use alternatives]

## Scripts

[Project-specific scripts, dev commands, utility tools]
```

---

## Components

### 1. Project Registry

**Location:** Operator1's workspace — `~/.openclaw/workspace/PROJECTS.md`

This file lives in Operator1's workspace directory so it is automatically loaded into his system prompt on every session. No code needed — Operator1 always knows what projects exist.

**Contents per project (keep it light):**

- Name and short ID (used for matching)
- Path (where the project lives on disk)
- Type (web app, mobile, API, framework, etc.)
- Tech stack (one line — languages, frameworks)
- Status (active, paused, MVP, etc.)
- Default flag — marks the fallback project when context is ambiguous
- Keywords (optional) — additional matching terms for project detection

**Size guidance:** Keep each project entry to ~4-6 lines. This is a registry index — full details live in the project's own `.openclaw/` folder. Total file should stay under 200 lines.

**Example:**

```markdown
# Active Projects

## operator1

- **Path:** ~/dev/operator1
- **Type:** Agent framework (CLI + gateway)
- **Tech:** TypeScript, ESM, Bun, Vitest, pnpm
- **Status:** Active development
- **Default:** true
- **Keywords:** gateway, CLI, agent, matrix, ACP

## subzero

- **Path:** ~/dev/subzero-app
- **Type:** Mobile app (iOS + Android)
- **Tech:** React Native, Expo, TypeScript
- **Status:** MVP phase
- **Keywords:** mobile, iOS, Android, app store

## ui-next

- **Path:** ~/dev/operator1/ui-next
- **Type:** Web dashboard
- **Tech:** Next.js, React, TypeScript, Tailwind
- **Status:** Feature development
- **Keywords:** dashboard, admin panel, settings, canvas
```

For details like primary agent, ACP harness preference, conventions — agents read from the project's own `.openclaw/TOOLS.md` and `.openclaw/AGENTS.md`.

**Project discovery:** When Operator1 encounters a project folder with `.openclaw/` during work (e.g., via a path reference or during file operations), it should offer to register it:

> "I found a project workspace at ~/dev/new-project/.openclaw/. Want me to add it to PROJECTS.md?"

This keeps the registry current without manual maintenance.

---

### 2. Project Detection (Prompt-Driven, Not Code)

Operator1 detects the active project through its own reasoning — this is an LLM behaviour configured in SOUL.md/AGENTS.md, not a code module.

**Detection signals (in priority order):**

1. **Session is project-focused** — Skip detection entirely. Project is already set.
2. **Explicit mention** — "On Subzero, do X" → project = subzero
3. **Path reference** — "In ~/dev/subzero-app" → project = subzero
4. **Keyword/type match** — "The mobile app needs..." → match against project `type` and `keywords` fields in PROJECTS.md. Keywords provide finer-grained matching (e.g., "dashboard" → ui-next, "gateway" → operator1).
5. **Default project** — Marked `default: true` in PROJECTS.md. Used only when signal is too weak to determine project confidently.
6. **Ask** — When still ambiguous, Operator1 asks before proceeding.

**When to ask vs. use default — concrete examples:**

| User Says                       | Action                      | Rationale                                                                                |
| ------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| "Fix the login bug"             | **Use default** (operator1) | Generic but clearly engineering; default project is safe                                 |
| "Update the landing page copy"  | **Ask**                     | Could be operator1 marketing site or subzero onboarding — ambiguous across projects      |
| "Add a new API endpoint"        | **Use default** (operator1) | "API endpoint" is engineering, default is correct                                        |
| "Run the tests"                 | **Ask**                     | Every project has tests — genuinely ambiguous, no signal to differentiate                |
| "The app is crashing on launch" | **Ask**                     | "App" could be mobile (subzero) or desktop (operator1 mac app) — type match is ambiguous |

**Rule of thumb:** Use default when the task maps to one project type unambiguously. Ask when multiple registered projects could match the keywords or when the task is generic enough to apply to any project.

---

### 3. Context Flow (Workspace = Context)

When Operator1 spawns a subagent for a project task, context flows through three mechanisms depending on agent tier and workspace type:

**Mechanism A: Agent's own workspace (automatic)**

If the agent's `workspace` in `openclaw.json` points to the project folder, all `.openclaw/*.md` files auto-load. This is the zero-effort path for an agent's primary project.

> **Current state:** All agents currently have dedicated workspaces under `~/.openclaw/` (e.g., `workspace-neo`, `workspace-tank`), not project-pointed workspaces. This means Mechanism A does **not** provide project context today — it provides the agent's identity/role context. Project context flows via Mechanism B for all agents.

**Mechanism B: Task string injection (primary mechanism)**

The spawning agent includes the project path in the task string. This is the **universal mechanism** — it works for all agent tiers:

```
[Project: subzero | Path: ~/dev/subzero-app]
[Task]: Add push notifications to the iOS app.

Read the project's .openclaw/AGENTS.md for conventions before starting.
When you spawn sub-agents, pass the project path forward.
```

The spawned agent reads the project's `.openclaw/` files on demand via `read`. This handles the "project is outside the agent's workspace" scenario.

**Mechanism C: ACP `cwd` parameter (engineering tier-3 → coding agent)**

When engineering tier-3 agents (Tank, Spark, Cipher, etc.) spawn coding sessions via ACP, the `cwd` parameter **is** the project path:

```
sessions_spawn({
  runtime: "acp",
  agentId: "claude",
  task: "Add push notification service worker...",
  cwd: "~/dev/subzero-app",    <- project path becomes cwd
  label: "tank-push-notifications"
})
```

**`cwd` limitation:** The `sessions_spawn` tool's `cwd` parameter only applies to ACP runtime, not the default subagent runtime. The agent's working directory is fixed by their `workspace` in `openclaw.json`. This is why Mechanism B must explicitly state the project path — subagents use shell tools to navigate there.

### Context Flow by Agent Tier

| Tier   | Agent Type                                | How They Get Project Context                                  |
| ------ | ----------------------------------------- | ------------------------------------------------------------- |
| Tier 1 | Operator1 (COO/PM)                        | PROJECTS.md auto-loads; session focus or detection            |
| Tier 2 | Department heads (Neo, Morpheus, Trinity) | Task string from Operator1 (Mechanism B) — tagged for session |
| Tier 3 | All 30 specialists                        | Task string from Tier 2 (Mechanism B) — tagged for session    |
| ACP    | Claude Code, Codex, etc.                  | `cwd` parameter (Mechanism C) + task brief                    |

### Context Recovery on Agent Restart

If a Tier 2 or Tier 3 agent's session times out or crashes, the project context from the original task string is lost. Two recovery mechanisms:

**1. Memory-based recovery (agents with workspaces):**

Agents with workspaces should write their current project tag to `MEMORY.md` on first spawn:

```markdown
## Active Session

- Project: subzero
- Path: ~/dev/subzero-app
- Tagged: 2026-03-05 14:32
```

If the agent session restarts and loads this memory, it recovers the project context automatically.

**2. Re-injection by parent (all agents):**

When Operator1 or a department head detects a restarted agent session (via `sessions_list` or spawn failure/retry), it must re-inject the `[Project: ...]` header in the next task message. This is a prompt instruction for the parent agent:

> "If you detect that a spawned agent session has restarted (new session ID for the same agent), re-inject the full project context header in your next message to that agent."

---

### 4. Agent Project Tagging & Session Registry

When an agent is spawned for a project, they are **tagged** to that project for the entire session. This means:

- The initial task string sets the project context once
- Subsequent tasks from the same parent in the same session don't need to re-inject `[Project: ...]`
- The agent maintains project awareness across multiple tasks within their session
- When reporting results, agents include the project tag in their reports

**Tagging happens at spawn time.** The first task string includes the project context header:

```
[Project: subzero | Path: ~/dev/subzero-app]
[Tagged for this session]
[Task]: Add push notifications to the iOS app.
```

After this, follow-up tasks from the same parent can omit the project header — the agent already knows.

**Cross-project is not supported within a single agent session.** If Neo is tagged to subzero and a new task comes in for operator1, the parent (Operator1) should spawn a new Neo session for operator1. One agent session = one project.

**Cross-project spawn rule:** When the user requests work on a different project while an agent is already active on another project, Operator1 follows this rule:

> "If an agent session is active on project A and a new task arrives for project B, ask the user: 'Neo is currently working on [project A task]. Should I wait for completion, or start a parallel session for [project B]?'"

This prevents silent resource conflicts and lets the user decide the priority.

#### Session Registry

Operator1 must track which agent sessions are tagged to which projects. Without this, Operator1 can't route correctly when multiple sessions of the same agent are open (e.g., neo-session-A for subzero, neo-session-B for operator1).

**Format:** Operator1 maintains a session registry in working memory (not persisted):

```
## Active Agent Sessions

| Agent | Session Label         | Project    | Spawned    |
| ----- | --------------------- | ---------- | ---------- |
| neo   | neo-subzero-1709654320 | subzero    | 14:32      |
| neo   | neo-operator1-1709654890 | operator1 | 14:41      |
| tank  | tank-subzero-push-1709654400 | subzero | 14:33   |
```

**Routing rule:** When a new task arrives for a project and a matching agent session already exists for that project, Operator1 routes to the existing session via `message()`. When no matching session exists, Operator1 spawns a new one.

**This is a prompt convention, not infrastructure.** Operator1's AGENTS.md will include instructions to maintain this mental registry. It does not require gateway storage — it lives in Operator1's context window for the current session.

---

### 5. Subagent Context Inheritance

In a project-focused session, **every spawn in the chain** must carry the project context forward. Context survives up to **4 hops**:

**The full chain (engineering task with ACP):**

```
CEO → Operator1 (project-focused: subzero)     <- Hop 1: session focus
      → Neo (spawned with subzero path + task)  <- Hop 2: tagged to subzero
        → Tank (spawned by Neo with sub-task)   <- Hop 3: tagged to subzero
          → Claude Code via ACP                 <- Hop 4: cwd = ~/dev/subzero-app
```

**Context propagation at each hop:**

**Hop 1 → 2: Operator1 → Department Head**

```
[Project: subzero | Path: ~/dev/subzero-app]
[Task]: Implement push notifications.
Read the project's .openclaw/AGENTS.md for conventions.
When you spawn sub-agents, pass the project info forward.
For ACP sessions, use cwd: ~/dev/subzero-app.
```

**Hop 2 → 3: Department Head → Tier 3 Specialist**

```
[Project: subzero | Path: ~/dev/subzero-app]
[Task]: Add push notification service with Firebase Cloud Messaging.
- Register for push tokens on app launch
- Handle foreground/background notifications

For ACP sessions, use cwd: ~/dev/subzero-app.
Acceptance criteria: tests pass, no lint errors.
Report findings to me (Neo) with [subzero] tag.
```

**Hop 3 → 4: Tier 3 Specialist → ACP Coding Agent**

```
sessions_spawn({
  runtime: "acp",
  agentId: "claude",
  task: "Add push notification service with Firebase Cloud Messaging...",
  cwd: "~/dev/subzero-app",
  label: "tank-subzero-push-notifications"
})
```

Each agent in the chain is explicitly told to propagate the context. The `cwd` at the ACP level is where the project path becomes a real working directory.

---

### 6. Gateway RPC — Project Awareness

The gateway should be aware of project context so the UI and API consumers can interact with projects programmatically.

#### ProjectStore Interface

To avoid coupling RPC handlers directly to PROJECTS.md parsing, define a storage interface that can be swapped from file-based to SQLite later:

```typescript
interface ProjectEntry {
  id: string; // Short ID (e.g., "subzero")
  name: string; // Display name (e.g., "Subzero App")
  path: string; // Absolute path on disk
  type: string; // "web app", "mobile", "api", "framework"
  tech: string; // One-line tech stack
  status: string; // "active", "paused", "mvp", "archived"
  isDefault: boolean; // Fallback project when ambiguous
  keywords: string[]; // Additional matching terms for detection (e.g., ["dashboard", "admin"])
}

interface ProjectDetails extends ProjectEntry {
  soul: string | null; // Contents of .openclaw/SOUL.md (null if missing)
  agents: string | null; // Contents of .openclaw/AGENTS.md
  tools: string | null; // Contents of .openclaw/TOOLS.md
}

interface ProjectStore {
  list(): Promise<ProjectEntry[]>;
  get(id: string): Promise<ProjectDetails>;
  add(entry: ProjectEntry): Promise<void>;
  update(id: string, patch: Partial<ProjectEntry>): Promise<void>;
  archive(id: string): Promise<void>;
}
```

**Phase 1 implementation:** `MarkdownProjectStore` — reads/writes `PROJECTS.md` in Operator1's workspace. Parses the markdown headings and bullet points into `ProjectEntry` objects.

**Phase 2 migration:** `SqliteProjectStore` — backed by `~/.openclaw/projects/registry.db` (per `project-management-proposal.md`). Same interface, swap the constructor. RPC handlers don't change.

#### Gateway Methods

```typescript
// Project registry
"projects.list"; // → ProjectEntry[]
"projects.get"; // → ProjectDetails (reads .openclaw/ from project path)
"projects.add"; // → void (creates registry entry + optional scaffolding)
"projects.update"; // → void (updates registry entry)
"projects.archive"; // → void (sets status = "archived")

// Session-project binding
"projects.bindSession"; // → { projectId, path, injectedMessage }
"projects.unbindSession"; // → void
"projects.getContext"; // → ProjectEntry | null
```

#### Error Contracts

| Method                 | Error Case                           | Error Code          | Message                                                        |
| ---------------------- | ------------------------------------ | ------------------- | -------------------------------------------------------------- |
| `projects.get`         | Project ID not found in registry     | `PROJECT_NOT_FOUND` | `"No project with id '{id}'"`                                  |
| `projects.get`         | Path exists but `.openclaw/` missing | `NO_WORKSPACE`      | `"Project '{id}' has no .openclaw/ directory at {path}"`       |
| `projects.add`         | Duplicate project ID                 | `DUPLICATE_ID`      | `"Project '{id}' already exists"`                              |
| `projects.add`         | Path does not exist on disk          | `PATH_NOT_FOUND`    | `"Path '{path}' does not exist"`                               |
| `projects.update`      | Multiple projects set as default     | `MULTIPLE_DEFAULTS` | `"Only one project can be default; '{id}' is already default"` |
| `projects.archive`     | Project ID not found                 | `PROJECT_NOT_FOUND` | `"No project with id '{id}'"`                                  |
| `projects.bindSession` | Project ID not found                 | `PROJECT_NOT_FOUND` | `"No project with id '{id}'"`                                  |
| `projects.getContext`  | No project bound to session          | _(not an error)_    | Returns `null`                                                 |

#### `projects.getContext` Response

When no project is bound to the session, returns `null` (not an error). The UI uses this to show the "no project selected" state:

```typescript
// Bound session:
{ id: "subzero", name: "Subzero App", path: "~/dev/subzero-app", ... }

// Unbound session:
null
```

#### `projects.bindSession` — Concrete Data Flow

This is the mechanism that links a chat session to a project:

```
1. UI calls projects.bindSession({ sessionKey, projectId: "subzero" })
           |
2. Gateway handler:
   a. Looks up project in ProjectStore → gets path, type, tech
   b. Stores binding: sessionBindings.set(sessionKey, projectId)
      Storage: in-memory Map<string, string> (not persisted across gateway restarts)
   c. Constructs init message string:
      "[Session Init] Active project: subzero | Path: ~/dev/subzero-app"
   d. Returns: { projectId: "subzero", path: "~/dev/subzero-app", injectedMessage: "..." }
           |
3. UI injects the init message as a system message in the chat stream
   (same mechanism as existing system messages — appended to the message list)
           |
4. Operator1 reads the init message on next turn → sends confirmation:
   "[Session Init Acknowledged] Project: subzero | Ready for tasks"
5. UI waits for acknowledgment before showing "project locked" state
```

**Confirmation handshake:** The UI should not show "project locked" until Operator1 has actually processed the init message. Operator1's confirmation message (`[Session Init Acknowledged]`) signals that it has read the project context and is ready. The UI listens for this pattern before updating the project badge.

**Where the binding lives:** `sessionBindings` is an in-memory `Map<string, string>` on the gateway process, keyed by `sessionKey`. It is **not persisted** — if the gateway restarts, bindings are lost and must be re-established. Persistent binding is future work (see `project-management-proposal.md`).

**CLI path (no UI):** The user says "Focus on subzero." Operator1 handles this entirely in-prompt — no gateway call needed. The binding is implicit in Operator1's context window.

---

## Agent Config — Department and Role Fields

All 34 agents in `openclaw.json` should have `department` and `role` fields. These fields serve one purpose: **enabling Operator1 to route tasks by role via `agents_list` without hardcoding agent names.**

When Operator1 calls `agents_list`, it gets back each agent's `department` and `role`. This lets it route "I need a backend engineer" to Tank without knowing Tank by name — it finds the agent with `role: "Backend Engineer"` in `department: "engineering"`.

**Current state:** The config has all 34 agents but `department` and `role` are not set on any. This needs to be added.

**RPC impact:** The existing `agents_list` gateway method reads agent config and returns it to the caller. Check whether `agents_list` already passes through arbitrary config fields or if the response schema needs updating to include `department` and `role`. If the response schema is explicit (allowlist of fields), add `department` and `role` to the returned object. If it passes through all config fields, no RPC change is needed — just the config update.

**Target config structure (abbreviated):**

```json5
{
  agents: {
    list: [
      { id: "main", role: "COO", department: "operations" },
      { id: "neo", role: "CTO", department: "engineering" },
      { id: "morpheus", role: "CMO", department: "marketing" },
      { id: "trinity", role: "CFO", department: "finance" },
      { id: "tank", role: "Backend Engineer", department: "engineering" },
      { id: "spark", role: "Frontend Engineer", department: "engineering" },
      { id: "cipher", role: "Security Engineer", department: "engineering" },
      // ... all 34 agents
    ],
  },
}
```

---

## Session Linking via UI

The UI will expose a project selector per chat session. When a project is selected:

1. UI calls `projects.list` to populate the project dropdown
2. User selects a project → UI calls `projects.bindSession({ sessionKey, projectId })`
3. Gateway looks up the project, stores the binding, returns `{ projectId, path, injectedMessage }`
4. UI injects `injectedMessage` as a system message into the chat stream
5. UI shows "binding..." state (project name with spinner)
6. Operator1 reads the init message → sends `[Session Init Acknowledged]` confirmation
7. UI detects acknowledgment → shows "project locked" state
8. All subsequent messages in the session are treated as project-scoped

**UI states:**

| State       | What the UI Shows                                                     |
| ----------- | --------------------------------------------------------------------- |
| **Unbound** | "Generic Mode" label, project selector dropdown visible and prominent |
| **Binding** | Project name with spinner, selector disabled                          |
| **Bound**   | Project name with lock icon, selector collapsed/secondary             |

For the CLI path (no UI), the CEO can say "Focus this session on subzero" and Operator1 handles the same initialization flow entirely in-prompt — no gateway call needed.

**Session state is held in Operator1's working memory for the session** — it is not persisted across session restarts. If a session is restarted, the project link must be re-established.

> **Note:** Persistent session-to-project binding (surviving restarts) is covered in `project-management-proposal.md` — out of scope for this plan.

### UI API Contract (for parallel development)

The UI can be developed independently from the gateway implementation using these request/response shapes:

**`projects.list`**

```typescript
// Request
{
} // no params

// Response
{
  projects: [
    {
      id: "operator1",
      name: "Operator1",
      path: "~/dev/operator1",
      type: "Agent framework",
      tech: "TypeScript, ESM, Bun",
      status: "active",
      isDefault: true,
      keywords: ["gateway", "CLI", "agent", "matrix", "ACP"],
    },
    {
      id: "subzero",
      name: "Subzero App",
      path: "~/dev/subzero-app",
      type: "Mobile app",
      tech: "React Native, Expo, TypeScript",
      status: "mvp",
      isDefault: false,
      keywords: ["mobile", "iOS", "Android", "app store"],
    },
  ];
}
```

**`projects.bindSession`**

```typescript
// Request
{ sessionKey: "session-abc-123", projectId: "subzero" }

// Response (success)
{
  projectId: "subzero",
  path: "~/dev/subzero-app",
  injectedMessage: "[Session Init] Active project: subzero | Path: ~/dev/subzero-app"
}

// Response (error)
{ error: { code: "PROJECT_NOT_FOUND", message: "No project with id 'subzero'" } }
```

**`projects.getContext`**

```typescript
// Request
{ sessionKey: "session-abc-123" }

// Response (bound)
{ id: "subzero", name: "Subzero App", path: "~/dev/subzero-app", ... }

// Response (unbound)
null
```

---

## Memory System — Project Context

### Operator1 (Tier 1)

Operator1's memory should have a dedicated project section in `MEMORY.md`:

```markdown
## Active Projects

### operator1

- Status: Active development
- Last worked: 2026-03-05
- Current focus: Matrix project context system
- Notes: Main repo, default project

### subzero

- Status: MVP phase
- Last worked: 2026-03-03
- Current focus: Auth flow + push notifications
- Notes: External repo at ~/dev/subzero-app
```

This is maintained by Operator1 as part of its PM role. Updated when project work happens.

**Daily project summary:** In addition to the `## Active Projects` section, Operator1 should maintain a daily cross-project summary in `memory/YYYY-MM-DD.md`:

```markdown
## 2026-03-05 — Project Summary

- **operator1:** Config panel redesign (Spark), API rate limiting (Tank)
- **subzero:** Push notifications (Tank), auth flow audit (Cipher)
- **ui-next:** No work today
```

This gives the CEO a quick cross-project view when asking "What happened today?"

### Department Heads (Tier 2)

Neo, Morpheus, and Trinity should tag all memory entries with the project ID. Their MEMORY.md templates get a dedicated section:

```markdown
## Project Work Log

### [operator1] Config Panel Redesign — 2026-03-05

- Agent: Spark
- Task: Rebuild settings UI with new design system
- Result: Pass
- Files: ui-next/src/components/settings/\*

### [subzero] Push Notifications — 2026-03-05

- Agent: Tank
- Task: Add FCM push notification service
- Result: Pass — 8 tests passing
- Files: src/services/push.ts, src/services/push.test.ts
```

The `[project-id]` tag makes it easy to grep/filter when reviewing memory across projects.

### Tier 3 Specialists (with workspaces)

**All** Tier 3 agents with workspaces should maintain a lightweight project log — not just engineering specialists. Content agents (Niobe, Ink, Vibe) benefit equally from "last content I wrote for subzero." Not detailed — just enough to remember what they last did on each project:

```markdown
## Project Context

### operator1

- Last task: API rate limiting middleware (2026-03-04)
- Notes: Uses express middleware pattern, tests in src/middleware/\*.test.ts

### subzero

- Last task: Push notification service (2026-03-05)
- Notes: Uses Firebase Cloud Messaging, Expo notifications API
```

This helps specialists maintain continuity when they're re-spawned for the same project. They can pick up where they left off without re-reading the entire codebase.

### Tier 3 Specialists (ephemeral)

Ephemeral agents have no memory. Their project context comes entirely from the spawn task string. They report to Tier 2, who logs it. This is by design — no change needed.

---

## Memory Template Updates

The following memory templates need a `## Project Work Log` or `## Project Context` section **appended** to existing content. Do **not** replace existing MEMORY.md files — append the new section to whatever is already there.

### Neo MEMORY.md template

```markdown
# Neo — Engineering Memory

## Architecture Decisions

<!-- No entries yet -->

## Tech Debt Register

<!-- No entries yet -->

## Project Work Log

<!-- Tagged entries: [project-id] Task — Date -->
<!-- No entries yet -->

## Key Learnings

<!-- No entries yet -->
```

### Morpheus MEMORY.md template

```markdown
# Morpheus — Marketing Memory

## Brand Voice

<!-- No entries yet -->

## Audience Insights

<!-- No entries yet -->

## Content Performance

<!-- No entries yet -->

## Project Work Log

<!-- Tagged entries: [project-id] Task — Date -->
<!-- No entries yet -->

## Key Learnings

<!-- No entries yet -->
```

### Trinity MEMORY.md template

```markdown
# Trinity — Finance Memory

## Budget Envelopes

<!-- No entries yet -->

## Financial Goals

<!-- No entries yet -->

## Vendor Tracking

<!-- No entries yet -->

## Project Work Log

<!-- Tagged entries: [project-id] Task — Date -->
<!-- No entries yet -->

## Key Learnings

<!-- No entries yet -->
```

### Tier 3 Specialist MEMORY.md template (for agents with workspaces)

```markdown
# {Agent Name} — {Role} Memory

## Project Context

<!-- Per-project notes: last task, key patterns discovered -->
<!-- No entries yet -->

## Key Learnings

<!-- No entries yet -->
```

> **Important:** When implementing Step 5, check each agent's live workspace MEMORY.md first. If it already has content, append the new `## Project Work Log` / `## Project Context` section — do not overwrite existing entries.

---

## Implementation Order

| Step | What                                                                                                                                                        | How                                 | Status                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| 1    | Add `department` and `role` fields to all 34 agents in config. Check if `agents_list` RPC schema needs updating to expose these fields.                     | Config + possible RPC schema update | ✅ Done — fields already existed; Operator1 role fixed to COO. RPC already exposes them. |
| 2    | Create `Projects/` folder in operator1 repo + add to `.gitignore`                                                                                           | Folder setup                        | ✅ Done                                                                                  |
| 3    | Create `PROJECTS.md` in Operator1's workspace (with `keywords` field)                                                                                       | Markdown editing                    | ✅ Done — operator1 registered as default                                                |
| 4    | Stub `ProjectStore` interface + `projects.*` API contracts (types + error codes only, no implementation)                                                    | Code — types only                   | ✅ Done — `src/gateway/server-methods/projects.types.ts`                                 |
| 5    | Update Operator1's `SOUL.md`/`AGENTS.md` with PM role + project detection + session focus + session registry + cross-project spawn rule + project discovery | Prompt engineering                  | ✅ Done                                                                                  |
| 6    | **Append** project sections to memory templates (Neo, Morpheus, Trinity + **all** Tier 3 with workspaces) — do not replace existing content                 | Template update                     | ✅ Done — 3 Tier 2 templates + 14 Tier 3 templates + 3 live Tier 2 + 14 live Tier 3      |
| 7    | Manually scaffold `.openclaw/` in active projects (operator1, subzero, ui-next) using templates from this doc                                               | Manual file creation                | ✅ Done (operator1 only — subzero/ui-next not yet real projects)                         |
| 8    | Implement `MarkdownProjectStore` + full `projects.*` gateway methods                                                                                        | Code                                | ✅ Done — `src/gateway/server-methods/projects.ts`, 8 methods registered                 |
| 9    | Test: generic session task routing                                                                                                                          | Manual testing                      | ⬜ Ready for testing                                                                     |
| 10   | Test: project-focused session with full spawn chain                                                                                                         | Manual testing                      | ⬜ Ready for testing                                                                     |
| 11   | Build UI project selector (can start after Step 4 contract is stubbed)                                                                                      | UI work                             | ⬜ Separate task                                                                         |

**Why this order:** Step 4 stubs the API contract before Step 5 (Operator1 prompts), so prompt instructions reference real method names and shapes. UI work (Step 11) can start in parallel after Step 4.

### Test Criteria

**Step 8 — Generic session task routing:**

1. Send "Fix the login bug" in generic session → Operator1 routes to default project (operator1) without asking
2. Send "Update the landing page copy" → Operator1 asks which project before routing
3. Send "Run the tests" → Operator1 asks which project
4. Send "On subzero, add a splash screen" → Operator1 routes to subzero without asking
5. Verify Operator1's session registry updates after each spawn

**Step 9 — Project-focused session with full spawn chain:**

1. Say "Focus on subzero" → Operator1 confirms and locks session
2. Send "Add push notifications" → Operator1 spawns Neo with `[Project: subzero]` in task string
3. Neo spawns Tank with project context forwarded in task string
4. Tank spawns Claude Code via ACP with `cwd: ~/dev/subzero-app`
5. Verify ACP `cwd` matches the registered project path in PROJECTS.md
6. Send a second task in the same session → verify Neo does NOT re-ask for project
7. Send an off-topic task → Operator1 pushes back ("This session is focused on Subzero")

---

## Benefits

1. **No duplication** — Project context lives in the project's `.openclaw/`, not in a separate CONTEXT.md
2. **Session focus** — Lock a session to one project and never repeat the project name
3. **Agent tagging** — Agents are tagged to a project per session, maintaining context across multiple tasks
4. **Full chain inheritance** — Project path flows through all 4 hops via task strings + `cwd`
5. **Lightweight registry** — PROJECTS.md is a slim index; details live in each project
6. **Dual-role Operator1** — Chat counterpart + PM, managing multiple projects simultaneously
7. **Gateway-aware** — Project context flows through RPC for UI and API integration
8. **Memory-integrated** — All tiers log project-tagged entries for continuity
9. **Both internal and external projects** — `~/dev/operator1/Projects/` or anywhere on disk
10. **Migration-ready** — `ProjectStore` interface decouples RPC handlers from storage format

---

## What This Is Not

- This is **not** a task management system — tasks, statuses, and persistence are covered in `project-management-proposal.md`
- Session-to-project binding does **not** persist across gateway restarts (future work)
- Context is **not** automatically injected to cross-project agents — Operator1 passes the path via task strings, the agent reads `.openclaw/` files on demand
- This does **not** restrict which agents can work on which projects — any head can spawn any tier-3 specialist for any project (shared pool)

---

## Project Lifecycle

### Adding a Project

1. User says "Add ~/dev/new-project as a project" or uses `matrix project add`
2. Operator1 checks if path exists and has `.openclaw/` directory
3. If `.openclaw/` missing → asks user: "Create default workspace files?"
4. Adds entry to PROJECTS.md with ID, path, type, tech, status
5. Confirms: "Registered **new-project** at ~/dev/new-project"

### Archiving a Project

When a project is no longer actively worked on:

1. User says "Archive the subzero project" or Operator1 suggests archiving dormant projects
2. Operator1 checks for active agent sessions tagged to this project
   - If sessions exist → warns: "Tank is still working on subzero. Wait for completion or force archive?"
3. Clears any session bindings for this project
4. Moves PROJECTS.md entry from `## Active Projects` to `## Archived Projects`
5. Removes `isDefault` flag if it was set (and warns if no other default remains)
6. Project's `.openclaw/` folder is left intact — archiving is a registry operation, not a data deletion

```markdown
## Archived Projects

## subzero

- **Path:** ~/dev/subzero-app
- **Type:** Mobile app (iOS + Android)
- **Status:** Archived (2026-04-15)
- **Reason:** MVP shipped, on hold
```

### Reactivating a Project

Move entry back from `## Archived Projects` to `## Active Projects` and set status to active.

---

## Appendix: Per-Project ACP Harness Preferences

Different projects may benefit from different coding harnesses. The project's `.openclaw/TOOLS.md` specifies the preferred ACP harness:

```markdown
# TOOLS.md — Subzero

## ACP Harness Preference

Default: `claude` (Claude Code)

This is a large React Native + Expo codebase with complex navigation and state management.
Claude Code is preferred for its ability to reason about multi-file dependencies.

For simple component scaffolding or boilerplate, `codex` is acceptable.
```

Engineering tier-3 agents should check the project's `.openclaw/TOOLS.md` (if it exists) when choosing which ACP harness to spawn. This is advisory — the agent uses their judgment if no preference is specified.

---

_Created: 2026-03-02_
_Updated: 2026-03-05 (v4 — Steps 1-8 implemented)_
_Author: Neo (CTO) + Operator1 (COO)_
