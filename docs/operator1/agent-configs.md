---
summary: "Agent workspace file reference — SOUL.md, AGENTS.md, IDENTITY.md, MEMORY.md, and other files that define each agent's persona and behavior."
updated: "2026-03-16"
title: "Agent Configs"
---

# Agent Configs

Each agent has a workspace folder with Markdown files that define its personality, memory, rules, and how it works.

## Workspace directory

Agent workspaces live at `~/.openclaw/workspace-{agentId}/`:

```
~/.openclaw/workspace-neo/
   +-- SOUL.md          # Persona, values, decision framework
   +-- AGENTS.md        # Workspace rules, delegation, memory structure
   +-- IDENTITY.md      # Name, role, emoji, department
   +-- MEMORY.md        # Curated long-term memory
   +-- TOOLS.md         # Tool notes, credential references
   +-- HEARTBEAT.md     # Periodic task checklist
   +-- USER.md          # Human preferences and context
   +-- BOOTSTRAP.md     # First-run setup ritual
   +-- memory/          # Daily notes directory
      +-- 2026-03-01.md
      +-- 2026-03-02.md
```

Operator1 uses `~/.openclaw/workspace/` (no suffix) as its workspace.

## File reference

### SOUL.md (required)

Defines the agent's core persona, values, and decision-making framework. This is the most important file — it shapes how the agent thinks and acts.

**Contents:**

- Agent personality and communication style
- Core values and priorities
- Decision framework (how to evaluate trade-offs)
- Boundaries (what the agent should and should not do)
- Relationship to other agents in the hierarchy

**Example structure:**

```markdown
# Neo — CTO

## Personality

Direct, technical, systems-thinking. Prefers structured approaches.

## Values

1. Code quality over speed
2. Architecture clarity
3. Test coverage
4. Security by default

## Decision Framework

- Small tasks (< 30 min): assign directly to best-fit worker
- Medium tasks (30 min - 2 hr): create requirements brief, then assign
- Large tasks (> 2 hr): break down, create sub-tasks, assign in sequence

## Boundaries

- Never deploy to production without human approval
- Always run tests before marking a task complete
- Escalate security concerns to Operator1 immediately
```

### AGENTS.md (required)

Workspace rules that govern the agent's operational behavior, memory management, and delegation patterns.

**Contents:**

- Workspace structure and file locations
- Memory management rules (when to write daily notes, when to update MEMORY.md)
- Delegation rules (which agents to spawn for which tasks)
- Group chat behavior
- Heartbeat configuration
- Tool usage guidelines

**Example structure:**

```markdown
# Workspace Rules

## Memory

- Write daily notes to `memory/YYYY-MM-DD.md` after each session
- Update MEMORY.md weekly with distilled insights
- Use QMD for semantic search across past sessions

## Delegation

- Backend tasks → Tank
- DevOps tasks → Dozer
- QA/research → Mouse
- Frontend → Spark
- Security → Cipher

## Heartbeat

- Run heartbeat checks every 24 hours
- Check: workspace health, memory freshness, pending tasks
```

### IDENTITY.md (required)

Short file that declares the agent's identity metadata — read by the system and other agents.

**Contents:**

- Agent name and display emoji
- Role and department
- Creature type (thematic flavor)
- Communication vibe

**Example:**

```markdown
# Identity

- **Name:** Neo
- **Emoji:** :robot:
- **Role:** CTO
- **Department:** Engineering
- **Creature:** Digital phoenix
- **Vibe:** Precise, architectural, forward-thinking
```

### MEMORY.md (required)

Curated long-term memory — distilled from daily session notes. This file is the agent's persistent knowledge base.

**Contents:**

- Key decisions and their rationale
- Project-specific knowledge
- Learned patterns and preferences
- Important context that should survive across sessions

**Update process:**

1. Daily notes capture raw session data in `memory/YYYY-MM-DD.md`
2. Periodically, the agent (or a consolidation script) distills daily notes into MEMORY.md
3. Outdated entries are pruned

See [Memory System](/operator1/memory-system) for the full memory architecture.

### TOOLS.md (optional)

Notes on available tools, skill configurations, and credential references.

**Contents:**

- Available CLI tools and their locations
- Credential references (never store actual secrets — reference paths or env vars)
- Tool-specific configuration notes
- Skill inventory

### HEARTBEAT.md (optional)

Periodic check-in template that runs on a schedule. Defines what the agent should verify regularly.

**Contents:**

- Health checks to run
- Status items to report
- Maintenance tasks
- Frequency and timing

**Example:**

```markdown
# Heartbeat

## Every 24 hours

- [ ] Check workspace file integrity
- [ ] Verify memory freshness (last daily note < 48h old)
- [ ] Review pending delegated tasks
- [ ] Report status to Operator1

## Weekly

- [ ] Consolidate daily notes into MEMORY.md
- [ ] Review and prune stale memory entries
```

### USER.md (optional)

Context about the human operator — preferences, timezone, communication style.

**Contents:**

- Human name and preferred address
- Timezone and working hours
- Communication preferences
- Project priorities

### BOOTSTRAP.md (optional)

First-run ritual for when an agent is initialized on a new machine or after a reset.

**Contents:**

- Discovery steps (read SOUL.md, IDENTITY.md, etc.)
- Channel setup verification
- Memory initialization
- First heartbeat

## Project memory directories

In addition to agent workspace memory, each project has its own isolated memory directory:

```
~/.openclaw/workspace/projects/{projectId}/memory/
   +-- MEMORY.md           # Project-specific long-term memory
   +-- 2026-03-10.md       # Project daily notes
   +-- decisions.md        # Any project-specific files
```

Project memory is always centralized under `~/.openclaw/workspace/projects/` — it is never created inside external repository directories. This keeps external repos clean while providing persistent project context that any bound agent can access.

When an agent session is bound to a project, this path is provided via system prompt injection. Memory search (`memory.search`) auto-discovers these directories and includes them in search results.

## Templates

### Generic templates

Base templates for all workspace files live at:

```
docs/reference/templates/
   +-- SOUL.md
   +-- AGENTS.md
   +-- IDENTITY.md
   +-- BOOTSTRAP.md
   +-- HEARTBEAT.md
   +-- USER.md
   +-- TOOLS.md
```

### Matrix-specific templates

Role-specific overrides for each agent:

```
docs/reference/templates/matrix/
   +-- neo/         # CTO templates (SOUL.md, AGENTS.md, etc.)
   +-- morpheus/    # CMO templates
   +-- trinity/     # CFO templates
   +-- tank/        # Backend Engineer templates
   +-- dozer/       # DevOps templates
   +-- ...          # All 30+ Tier 3 agents
```

### Bootstrapping a new agent

1. Create the workspace directory:

   ```bash
   mkdir -p ~/.openclaw/workspace-{agentId}
   ```

2. Copy matrix-specific templates (if they exist):

   ```bash
   cp docs/reference/templates/matrix/{agentId}/* ~/.openclaw/workspace-{agentId}/
   ```

3. Fall back to generic templates for missing files:

   ```bash
   cp docs/reference/templates/HEARTBEAT.md ~/.openclaw/workspace-{agentId}/
   ```

4. Create the memory directory:

   ```bash
   mkdir -p ~/.openclaw/workspace-{agentId}/memory
   ```

5. Add the agent to `matrix-agents.json` (see [Configuration](/operator1/configuration))

## Related

- [Agent Hierarchy](/operator1/agent-hierarchy) — all agents and their roles
- [Memory System](/operator1/memory-system) — how memory files are managed
- [Configuration](/operator1/configuration) — JSON config for agent definitions
- [Deployment](/operator1/deployment) — full setup walkthrough
