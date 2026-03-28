# Comparison: OpenClaw PM System vs ClawTeam

**Context:** Evaluating HKUDS/ClawTeam as a reference implementation for our OpenClaw Project Management System
**Researched:** 2026-03-26
**Recommendation:** Our existing design is sound. ClawTeam validates several core decisions but is solving a different problem (standalone agent orchestration vs integrated platform feature). Adopt specific patterns; do not pivot to their architecture.

## Quick Comparison

| Criterion              | OpenClaw PM (Planned)                    | ClawTeam (Shipping)                          |
| ---------------------- | ---------------------------------------- | -------------------------------------------- |
| **Primary user**       | Humans + agents (collaborative)          | Agents (agent-first, humans monitor)         |
| **Integration model**  | Platform feature in existing gateway     | Standalone Python CLI tool                   |
| **State format**       | Markdown + YAML frontmatter              | JSON files                                   |
| **State location**     | `~/.openclaw/projects/`                  | `~/.clawteam/`                               |
| **UI**                 | Integrated Lit web components            | Standalone web server + terminal dashboard   |
| **Agent coordination** | Hook-based context injection + heartbeat | CLI command injection into agent prompts     |
| **Process isolation**  | Existing gateway sessions                | tmux + git worktrees                         |
| **Concurrency**        | mkdir-based file locks                   | tmp+rename atomic writes + fcntl/mkdir locks |
| **Task dependencies**  | `depends_on` frontmatter field           | `--blocked-by` CLI flag                      |
| **Transport**          | WebSocket (existing)                     | File-based inbox + optional ZeroMQ P2P       |
| **Agent messaging**    | v2 scope                                 | Built-in (inbox send/receive/broadcast)      |
| **Team templates**     | Not planned                              | TOML-based team archetypes                   |
| **Language**           | TypeScript (ESM)                         | Python 3.10+                                 |
| **Maturity**           | Design phase                             | Alpha (v0.2.0), 3.7K stars                   |
| **License**            | Part of OpenClaw                         | MIT                                          |

## Detailed Analysis

### OpenClaw PM System (Our Approach)

**Strengths:**

- Markdown as source of truth means agents read/write state natively without learning new commands
- Two-layer architecture (markdown source + JSON index) serves both agents and UI optimally
- Integrated into existing gateway lifecycle -- no separate processes to manage
- Hook-based context injection is clean and does not pollute agent prompts
- Heartbeat-based task pickup is automatic -- agents do not need to explicitly poll
- Capability-based routing (agent IDENTITY.md tags) enables sophisticated task matching
- Checkpoint/resume sections handle context compaction gracefully
- Web UI is a first-class integrated experience, not an afterthought monitoring dashboard

**Weaknesses:**

- No agent-to-agent messaging in v1 (ClawTeam has this from day one)
- No project/team templates (ClawTeam's TOML templates are convenient)
- Read-only UI in Phase 1 means humans cannot interact with the board directly
- Single-machine design (no distributed/P2P transport option)
- Not framework-agnostic -- tightly coupled to OpenClaw platform

**Best for:** Teams using OpenClaw as their AI platform who want integrated project management with human oversight

### ClawTeam

**Strengths:**

- Framework-agnostic -- works with Claude Code, Codex, OpenClaw, nanobot, Cursor, any CLI agent
- Agent-to-agent messaging (inbox) enables rich coordination from day one
- TOML team templates allow one-command team creation for common patterns
- tmux + git worktree isolation provides strong process and code isolation
- Proven at scale: 8 agents across 8 H100 GPUs running 2,430+ ML experiments
- Active community (3.7K stars, 511 forks, OpenClaw-specific fork exists)
- Cost tracking per agent (useful for API-heavy workloads)
- Lifecycle management (idle/active reporting) enables graceful cleanup

**Weaknesses:**

- Agents must learn CLI commands injected into their prompts (context pollution)
- JSON state files are not naturally readable/writable by agents without the CLI
- Hard dependency on tmux (platform-specific, not available in all environments)
- Web UI is a separate server, not integrated into any agent platform
- No checkpoint/resume for agent context compaction
- No capability-based routing -- task assignment is manual or leader-directed
- State format (JSON) is not human-friendly for direct editing
- No structured data indexing -- queries go through CLI, not pre-computed indexes

**Best for:** Orchestrating ad-hoc multi-agent swarms across any CLI agent, especially for research/ML workloads

## Pattern-by-Pattern Comparison

### Task Management

| Aspect          | OpenClaw PM                                                             | ClawTeam                                     |
| --------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| Task creation   | Write markdown file with YAML frontmatter                               | `clawteam task create <team> <title>` CLI    |
| Task storage    | `tasks/TASK-NNN.md` per project                                         | JSON files in `~/.clawteam/tasks/{team-id}/` |
| Status values   | Configurable columns (default: Backlog/In Progress/Review/Done/Blocked) | Fixed: pending/in_progress/completed/blocked |
| Dependencies    | `depends_on: [TASK-001]` in frontmatter                                 | `--blocked-by TASK-ID` flag on create        |
| Auto-unblocking | Planned: check deps on task completion                                  | Yes: automatic unblock when deps complete    |
| ID format       | TASK-NNN (sequential per project)                                       | Numeric IDs per team                         |

**Verdict:** Similar core models. ClawTeam's auto-unblocking is a pattern we should implement. Our configurable columns are more flexible.

### Concurrency

| Aspect           | OpenClaw PM                    | ClawTeam                              |
| ---------------- | ------------------------------ | ------------------------------------- |
| Write protection | mkdir-based atomic lock        | fcntl (fork) or tmp+rename (upstream) |
| Lock scope       | Per-project queue.md           | Per-team task store                   |
| Stale detection  | PID + timestamp, 60s timeout   | PID + timestamp, similar timeout      |
| Atomic writes    | tmp+rename for .index/ JSON    | tmp+rename for all state files        |
| Validation       | Re-read after write to confirm | Not documented                        |

**Verdict:** Very similar approaches. ClawTeam validates our design. Our validate-after-write (CONC-05) is an extra safety net they lack.

### Agent Coordination

| Aspect                       | OpenClaw PM                                 | ClawTeam                                                |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| How agents learn about tasks | Hook-based PROJECT.md injection + heartbeat | Auto-injected CLI commands in prompt                    |
| Task discovery               | Automatic via heartbeat scan                | Agent calls `clawteam task list`                        |
| Task claiming                | Automatic via heartbeat + capability match  | Agent calls `clawteam task update --status in_progress` |
| Status reporting             | Implicit via task file updates              | Explicit `clawteam task update` + `clawteam inbox send` |
| Idle detection               | v2 (PM agent)                               | `clawteam lifecycle idle` (agent must call)             |
| Capability matching          | Agent IDENTITY.md tags vs task capabilities | None (manual/leader-assigned)                           |

**Verdict:** Fundamentally different philosophies. ClawTeam makes agents responsible for coordination (via CLI). We make the platform responsible (via hooks + heartbeat). Our approach is cleaner for agents but less flexible for ad-hoc swarms.

### Communication

| Aspect            | OpenClaw PM                  | ClawTeam                              |
| ----------------- | ---------------------------- | ------------------------------------- |
| Agent-to-agent    | v2 scope                     | Inbox (send/receive/broadcast)        |
| Agent-to-UI       | WebSocket events via gateway | Web dashboard polls state             |
| Human-to-agent    | Existing chat channels       | Leader agent prompts (or manual tmux) |
| Transport options | WebSocket only               | File-based + optional ZeroMQ P2P      |

**Verdict:** ClawTeam has richer agent-to-agent communication. Our UI integration is stronger. Their inbox pattern is worth studying for our v2 COLLAB-02 feature.

### Monitoring

| Aspect          | OpenClaw PM                      | ClawTeam                                |
| --------------- | -------------------------------- | --------------------------------------- |
| Board view      | Lit-based kanban in sidebar      | Terminal (rich) + standalone web server |
| Live indicators | Pulsing badges + session peek    | Tiled tmux view                         |
| Dashboard       | Configurable widgets per project | Fixed monitoring dashboard              |
| Visualization   | Kanban + project list            | Kanban + Gource commit visualization    |

**Verdict:** Our integrated UI is superior for daily use. ClawTeam's tmux tiling is good for watching agents work in real-time.

## Recommendation

**Do not change our architecture.** ClawTeam solves a different problem (ad-hoc multi-agent swarms) with a different philosophy (agents drive coordination via CLI). Our design (platform-integrated, human-agent collaborative, markdown-native) is better for our use case.

**Adopt these specific patterns from ClawTeam:**

1. **Auto-unblocking on dependency completion** -- When a task completes, automatically scan for and unblock tasks whose `depends_on` are now satisfied. ClawTeam does this; our design should too. Add to AGNT-09 implementation.

2. **Atomic tmp+rename for all state writes** -- ClawTeam uses this consistently, not just for JSON. Apply to queue.md writes too, not just .index/ files.

3. **Lifecycle/idle signaling concept** -- For our v2 PM agent (PMA-01), ClawTeam's `lifecycle idle` pattern is a good reference. Agents signaling completion enables graceful cleanup.

4. **Team templates concept for v2** -- ClawTeam's TOML templates for pre-configured teams (hedge fund, research, engineering) are a compelling pattern. For our v2, consider PROJECT.md templates that pre-populate task structures for common project types.

**Do not adopt:**

1. CLI command injection into agent prompts -- our hook system is cleaner
2. JSON as agent-readable state -- our markdown approach is better for agent accessibility
3. tmux/git worktree isolation -- unnecessary given our gateway session model
4. Standalone monitoring server -- our integrated UI is superior
5. File-based inbox messaging -- our WebSocket infrastructure is more capable

**Choose our approach when:** Building an integrated platform feature with human oversight, where agents work within an existing ecosystem and humans actively manage projects through a web UI.

**Choose ClawTeam when:** Orchestrating ad-hoc multi-agent swarms across diverse CLI agents, especially for research/ML workloads where you want framework independence and don't need a polished UI.

## Sources

- [HKUDS/ClawTeam GitHub](https://github.com/HKUDS/ClawTeam)
- [ClawTeam PyPI page](https://pypi.org/project/clawteam/)
- [win4r/ClawTeam-OpenClaw fork](https://github.com/win4r/ClawTeam-OpenClaw)
- [MarkTechPost ClawTeam implementation analysis](https://www.marktechpost.com/2026/03/20/a-coding-implementation-showcasing-clawteams-multi-agent-swarm-orchestration-with-openai-function-calling/)
- [Medium: ClawTeam repo analysis](https://medium.com/@terminalchai/came-across-an-interesting-repo-while-browsing-github-clawteam-9fc9626e8d10)
- [Chao Huang (ClawTeam author) announcement](https://x.com/huang_chao4969/status/2033959058945020041)
