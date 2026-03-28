# Feature Landscape

**Domain:** AI-agent-integrated markdown-based project management
**Researched:** 2026-03-26
**Confidence:** MEDIUM-HIGH (based on design spec analysis + competitive landscape research)

## Competitive Context

The feature landscape is informed by analysis of these systems:

| System               | Category                 | Key Differentiator                                                |
| -------------------- | ------------------------ | ----------------------------------------------------------------- |
| Linear               | SaaS PM tool             | AI triage, agent-as-teammate, coding agent deeplinks              |
| GitHub Projects      | Code-native PM           | Sub-issues, agentic workflows in Actions, repo-integrated         |
| Trello               | Visual PM                | Simple kanban, Power-Ups ecosystem, low learning curve            |
| Taskmaster AI        | AI task orchestrator     | PRD parsing into dependency-aware tasks, MCP tools, autopilot TDD |
| GSD                  | Spec-driven dev workflow | Fresh subagent contexts, atomic plans, context rot prevention     |
| Cursor               | AI coding IDE            | Plan mode, parallel agents, cloud agents, automations             |
| backlog.md           | Markdown PM              | Git-native, markdown files as tasks, React kanban UI              |
| MDTM (Roo Commander) | Markdown task mgmt       | TOML frontmatter, status-driven files in repo                     |
| taskmd               | Markdown task mgmt       | YAML frontmatter, AI-agent-first design                           |

---

## Table Stakes

Features users expect. Missing any of these and the system feels incomplete or broken for a PM tool built into an AI agent platform.

| Feature                                      | Why Expected                                                                                                                                                        | Complexity | Notes                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Task CRUD** (create, read, update, delete) | Every PM tool has this. Agents and humans must be able to create and modify tasks.                                                                                  | Low        | CLI + agent writes to markdown. Already in design spec.                                                                                |
| **Task status tracking**                     | Users need to know what state work is in. Universal across all competitors.                                                                                         | Low        | YAML frontmatter `status` field. Already in design spec.                                                                               |
| **Kanban board view**                        | Visual status at a glance. Linear, Trello, GitHub Projects, backlog.md all have this.                                                                               | Medium     | Read-only Phase 1 is fine, but it must exist. Already in spec.                                                                         |
| **Task priority levels**                     | Without priority, agents and humans cannot triage. Every competitor has this.                                                                                       | Low        | Already in spec: low/medium/high/critical.                                                                                             |
| **Project list/overview**                    | Users with multiple projects need a summary view. Every PM tool has this.                                                                                           | Low        | Already in spec.                                                                                                                       |
| **Sub-tasks / checklists**                   | Breaking work into smaller units is fundamental. GitHub has sub-issues, Taskmaster has subtasks, Trello has checklists.                                             | Low        | Already in spec as checkbox sub-tasks within task files.                                                                               |
| **Task dependencies**                        | Taskmaster's core value prop. Linear and GitHub Projects support this. Without dependencies, agents work out of order.                                              | Medium     | Not explicitly in Phase 1 spec. Must add at minimum a `depends_on` frontmatter field and "next available task" logic that respects it. |
| **CLI interface**                            | Developers expect CLI access. Taskmaster, backlog.md, GSD all are CLI-first.                                                                                        | Low        | Already in spec: `openclaw projects create/list/status/reindex`.                                                                       |
| **Agent task claiming**                      | Core to the product's value proposition. If agents cannot autonomously pick up work, this is just another kanban board.                                             | Medium     | Already in spec via heartbeat + queue.md + capability matching.                                                                        |
| **Interruption/resume**                      | Context compaction and session ends are inevitable. GSD solves this with fresh contexts; Taskmaster ignores it. OpenClaw's checkpoint approach is the right answer. | Medium     | Already in spec via checkpoint sections and logs.                                                                                      |
| **Activity log/history**                     | Users need to see what happened. Linear has activity feeds, GitHub has timeline.                                                                                    | Low        | Already in spec as `## Log` section in task files.                                                                                     |
| **File-on-disk persistence**                 | The markdown-first promise. backlog.md, MDTM, taskmd, GSD all use files. If state lives only in memory or a database, the core value prop is broken.                | Low        | Already the foundational architecture decision.                                                                                        |

### Table Stakes Gap: Task Dependencies

The current Phase 1 spec does not include task dependencies. This is a significant gap. Taskmaster AI's entire value proposition is dependency-aware task sequencing ("what's the next task?"). Without dependencies, agents will work on tasks out of order, and the system cannot answer "what should I do next?" intelligently.

**Recommendation:** Add `depends_on: [TASK-XXX]` to task frontmatter and ensure heartbeat pickup logic skips tasks whose dependencies are not in `done` status. Complexity: Medium. This is table stakes, not a differentiator.

---

## Differentiators

Features that set OpenClaw apart from competitors. Not expected by default, but create significant competitive advantage.

| Feature                                                         | Value Proposition                                                                                                                                                                                                                   | Complexity | Notes                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| **Markdown as single source of truth with auto-generated JSON** | No other tool does this exact pattern. backlog.md is close but uses its own CLI to manage state. MDTM stores files but has no JSON index layer. The two-layer approach (agents write markdown, UI reads JSON) is novel and correct. | Medium     | Already in spec. This is the architecture differentiator. Protect it.                |
| **Capability-based agent routing**                              | No competitor does capability matching for task assignment. Taskmaster assigns to "the agent" (singular). Linear assigns to humans. OpenClaw can match task requirements to agent skills automatically.                             | Medium     | Already in spec. This is a major differentiator vs. Taskmaster's single-agent model. |
| **Multi-agent concurrent work**                                 | Cursor supports parallel agents but in isolated worktrees, not on a shared project board. OpenClaw's file-lock + queue approach enables multiple agents working on different tasks in the same project simultaneously.              | High       | Already in spec. The concurrency model (file-level .lock) is the hard part.          |
| **Live agent indicators on kanban**                             | No competitor shows real-time agent activity on a project board. Linear shows assignees but not live working state. This creates a "mission control" feel that is genuinely new.                                                    | Medium     | Already in spec. Pulsing indicators + session peek. High visual impact.              |
| **Context injection via PROJECT.md**                            | Unique to OpenClaw's agent architecture. When an agent enters a project directory or receives a message on a project channel, it automatically gets project context. No other tool has this "ambient project awareness."            | Medium     | Already in spec via two paths (cwd pickup + channel hook).                           |
| **Configurable dashboard widgets**                              | Linear has a fixed dashboard. GitHub Projects has configurable views but not widgets. Per-project widget configuration is a nice touch for power users.                                                                             | Low        | Already in spec. Good differentiator at low cost.                                    |
| **Configurable kanban columns**                                 | Most tools have this (Linear, GitHub Projects). But markdown-based tools generally do not. Columns in YAML frontmatter is clean.                                                                                                    | Low        | Already in spec.                                                                     |
| **Project-scoped agent channels**                               | Each project gets a communication channel. Humans can message agents in the context of a specific project. This bridges the gap between "chat with agent" and "manage project" that no competitor bridges well.                     | Medium     | In spec via channel hook. Powerful when combined with context injection.             |
| **Sub-project hierarchy**                                       | One level deep. backlog.md is flat. Taskmaster is flat. GitHub has sub-issues but not sub-projects. Linear has projects within teams but different semantics.                                                                       | Low        | Already in spec. Keep it one level.                                                  |
| **Graceful degradation (delete .index/, regenerate)**           | The "if JSON corrupts, just delete it" promise. No database migrations, no state corruption anxiety. This is a developer confidence feature.                                                                                        | Low        | Already in spec. Market this.                                                        |

---

## Anti-Features

Features to explicitly NOT build. Each has a clear reason.

| Anti-Feature                                      | Why Avoid                                                                                                                                                               | What to Do Instead                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Database/SQLite for project state**             | Breaks the markdown-as-source-of-truth promise. Agents cannot natively read/write SQLite. Adds migration complexity. backlog.md and taskmd prove files work.            | Keep markdown + auto-generated JSON. The .index/ pattern is the right answer.                                 |
| **Drag-and-drop kanban in Phase 1**               | Adds significant UI complexity before the data model is validated. Read-only board proves the architecture first. Phase 2 item.                                         | Agents manage board state via markdown. Humans interact via CLI or project channel messages.                  |
| **Real-time collaborative editing of task files** | CRDTs or OT for markdown files is enormous complexity. Multiple agents writing the same file simultaneously is a recipe for corruption.                                 | File-level .lock for queue writes. Each agent works on its own task file. No contention by design.            |
| **Complex workflow state machine (Phase 1)**      | Premature abstraction. Need to validate that the basic task/queue model works before adding workflow branching, conditions, and step dependencies.                      | Keep it to simple status transitions (backlog -> in-progress -> review -> done -> blocked). Phase 2.          |
| **Gantt charts / timeline views**                 | Over-engineering for an agent-first tool. Agents do not need visual timelines. Humans who need Gantt charts should use Linear or GitHub Projects.                       | Kanban board + task list + dashboard widgets cover the visual needs.                                          |
| **Time tracking / estimation**                    | Scope creep. AI agents do not track time. Human time tracking belongs in dedicated tools (Toggl, Harvest). Adding it muddies the product focus.                         | If needed later, it is a simple frontmatter field addition, not an architecture decision.                     |
| **Sprint/iteration management**                   | Sprints are a human ceremony concept. AI agents work continuously. Forcing sprint boundaries on agent workflows adds friction with no benefit.                          | Projects have status (active/paused/complete). Tasks have priority. That is sufficient for agent-driven work. |
| **External integrations (Jira, Linear sync)**     | Phase 1 distraction. Syncing state between OpenClaw markdown and external tools is a maintenance nightmare. Each sync direction has edge cases.                         | Build a great standalone system first. Integrations can come later as plugins if there is demand.             |
| **User permission/role system**                   | This is a local tool, not a SaaS platform. The filesystem IS the permission model. Adding RBAC to a local markdown tool is over-engineering.                            | Trust the filesystem. The `.lock` file prevents concurrent writes. That is sufficient.                        |
| **AI-generated task suggestions (Phase 1)**       | Requires approval UI, trust calibration, and a mechanism to prevent agents from flooding the queue with low-quality tasks. Phase 2 item after the basic flow is proven. | Humans and orchestration agents (Phase 2) create tasks deliberately.                                          |
| **Notification system**                           | Push notifications, email alerts, etc. are SaaS features. OpenClaw agents discover work via heartbeat. Humans check the dashboard or CLI.                               | Dashboard widgets (blockers, recent activity) serve the "what needs attention" use case.                      |
| **Task templates**                                | Premature. See what patterns emerge from real usage before templating them. Templates added too early calcify bad patterns.                                             | Copy-paste a task file. Markdown makes this trivial.                                                          |

---

## Feature Dependencies

```
File Structure (folders, PROJECT.md, queue.md, tasks/)
  |
  +-- Task CRUD (create/read/update/delete task files)
  |     |
  |     +-- Task Status Tracking (frontmatter status field)
  |     |     |
  |     |     +-- Task Dependencies (depends_on field + resolution logic)
  |     |
  |     +-- Sub-tasks (checkbox items within task body)
  |
  +-- Sync Process (file watcher -> .index/ JSON generation)
  |     |
  |     +-- WebSocket Events (gateway emits change events)
  |     |     |
  |     |     +-- Project List View (reads .index/project.json)
  |     |     |     |
  |     |     |     +-- Project Dashboard (widget rendering)
  |     |     |     |
  |     |     |     +-- Kanban Board (reads .index/board.json)
  |     |     |           |
  |     |     |           +-- Live Agent Indicators (heartbeat -> UI badge)
  |     |     |
  |     |     +-- Near-Real-Time UI Updates
  |     |
  |     +-- CLI: reindex command
  |
  +-- File-Level .lock (concurrency primitive)
  |     |
  |     +-- Agent Task Claiming (queue.md write with lock)
  |           |
  |           +-- Capability Matching (agent IDENTITY.md tags vs task capabilities)
  |           |
  |           +-- Heartbeat Task Pickup (periodic scan + claim cycle)
  |
  +-- Context Injection: cwd-based PROJECT.md pickup
  |
  +-- Context Injection: channel hook PROJECT.md injection
  |
  +-- Checkpoint/Resume (## Checkpoint + ## Log sections)
  |
  +-- CLI: create, list, status commands
```

**Critical path:** File Structure -> Task CRUD -> Sync Process -> WebSocket Events -> UI Views. Everything else can be developed in parallel once the file structure and sync process exist.

**Parallel workstreams after file structure:**

1. Agent integration (claiming, capability matching, heartbeat) -- independent of UI
2. UI (project list, dashboard, kanban) -- depends on sync process only
3. Context injection (cwd + channel hook) -- independent of both UI and claiming
4. CLI commands -- independent, can develop alongside everything

---

## MVP Recommendation

### Must ship (Phase 1 MVP):

1. **File structure + Task CRUD** -- Foundation everything builds on
2. **Sync process (.index/ JSON generation)** -- Enables UI without coupling to markdown parsing
3. **Task status + priority + dependencies** -- Table stakes for any PM tool (add `depends_on` to spec)
4. **Agent task claiming via heartbeat** -- Core differentiator; without this, it is just another kanban tool
5. **Capability-based routing** -- Second core differentiator
6. **CLI commands** (create, list, status, reindex) -- Developer-facing interface
7. **Project list view + kanban board (read-only)** -- Visual proof the system works
8. **Context injection (at least cwd path)** -- Agents need project awareness to work effectively
9. **Checkpoint/resume** -- Agents WILL be interrupted; without this, work is lost

### Defer to Phase 1.5 or Phase 2:

- **Dashboard with configurable widgets** -- Nice but not blocking; a simple project overview page suffices initially
- **Live agent indicators** -- High visual impact but requires WebSocket plumbing that can come after the board itself works
- **Channel hook context injection** -- cwd path is sufficient for Phase 1; channel hook adds convenience
- **Sub-project support** -- Users need to validate the single-project model before nesting

### Defer to Phase 2:

- Drag-and-drop kanban
- Workflow state machine
- Orchestration agent
- Stale detection (PM agent)
- Agent-proposed tasks
- Workflow templates

---

## Sources

- [Taskmaster AI (claude-task-master)](https://github.com/eyaltoledano/claude-task-master) -- PRD parsing, dependency-aware tasks, MCP tools, autopilot
- [Taskmaster AI Capabilities](https://www.sidetool.co/post/taskmaster-ai-capabilities-streamline-your-development-workflows/) -- Feature deep-dive
- [Linear AI Features 2026](https://www.eesel.ai/blog/linear-ai) -- AI triage, agent-as-teammate, coding deeplinks
- [Linear Agent announcement](https://www.theregister.com/2026/03/26/linear_agent/) -- "Issue tracking is dead," agentic workflows
- [GitHub Projects: Issues](https://github.com/features/issues) -- Sub-issues, task lists, flexible views
- [GitHub Agentic Workflows](https://github.blog/ai-and-ml/automate-repository-tasks-with-github-agentic-workflows/) -- Markdown-authored agent automations in Actions
- [Cursor Product Page](https://cursor.com/product) -- Agent mode, plan mode, parallel agents
- [Cursor Beta Features 2026](https://markaicode.com/cursor-beta-features-2026/) -- Automations, cloud agents, MCP plugins
- [GSD Framework (v2)](https://github.com/gsd-build/gsd-2) -- Spec-driven development, fresh subagent contexts, context rot prevention
- [GSD Beginner's Guide](https://dev.to/alikazmidev/the-complete-beginners-guide-to-gsd-get-shit-done-framework-for-claude-code-24h0) -- Slash command workflow, .planning/ directory
- [backlog.md](https://dev.to/thedavestack/transform-project-management-with-git-and-ai-backlogmd-28d0) -- Git-native markdown PM, React kanban
- [MDTM (Roo Commander)](https://github.com/jezweb/roo-commander/wiki/02_Core_Concepts-03_MDTM_Explained) -- TOML frontmatter, status-driven task files
- [taskmd](https://medium.com/@driangle/taskmd-task-management-for-the-ai-era-92d8b476e24e) -- YAML frontmatter, AI-agent-first markdown tasks
