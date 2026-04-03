---
name: hermes-learning-loop
description: Self-improving learning loop inspired by Hermes Agent. Automatically extracts successful workflows, creates skills, and persists knowledge across sessions.
tags: learning, self-improvement, memory, skill-creation, automation, hermes
version: 1.0.0
---

# Hermes Learning Loop for OpenClaw

**Inspired by**: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (Self-improving AI agent)

Implements Hermes Agent's core learning loop in OpenClaw — automatically extracts successful workflows, creates reusable skills, and persists curated knowledge across sessions.

## When to Use

- After completing complex multi-step tasks
- When you discover a workflow worth repeating
- Automatically via heartbeat (periodic nudge)
- When user says "remember this" or "save this workflow"

## Features

- **Periodic Nudge** — Auto-reflect every N tasks (default: 5)
- **Skill Extraction** — Convert successful workflows to reusable skills
- **4-Layer Memory** — Prompt memory + Session search + Skills + User modeling
- **Curated Memory** — Agent decides what's worth keeping (not logging everything)
- **Progressive Disclosure** — Only load skill summaries by default, full content on-demand
- **FTS5 Session Search** — SQLite-powered historical context retrieval

## Quick Start

### Install

```bash
clawhub install hermes-learning-loop
```

### Manual Trigger

```bash
# After completing a task
node learning-loop.js extract --session=<session_id>

# Create skill from workflow
node learning-loop.js create-skill --name="my-skill" --description="What it does"

# Periodic nudge (heartbeat)
node learning-loop.js nudge
```

### Auto-Trigger (Integration)

Add to HEARTBEAT.md:

```markdown
## Learning Loop - Periodic Nudge

**Frequency:** Every 5 tasks or 30 minutes

**Task:**
1. Run `node learning-loop.js nudge`
2. Review extracted memories
3. Approve/reject skill creations
```

## Architecture

### Learning Loop Cycle

```
┌─────────────────────────────────────────────────────────┐
│  1. Task Execution                                      │
│     - Agent completes task                              │
│     - Track tool calls, decisions, outcomes             │
└──────────────┬──────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────┐
│  2. Periodic Nudge (every 5 tasks)                      │
│     - System prompt: "Reflect on recent activity"       │
│     - Agent evaluates: Is this worth persisting?        │
└──────────────┬──────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────┐
│  3. Memory Extraction                                   │
│     - If valuable → Write to MEMORY.md / USER.md        │
│     - If workflow → Create skill file                   │
│     - If context → Index in session archive             │
└──────────────┬──────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────┐
│  4. Skill Creation                                      │
│     - Extract steps, tool calls, file references        │
│     - Write to ~/.openclaw/skills/<category>/<name>/   │
│     - Follow agentskills.io specification               │
└─────────────────────────────────────────────────────────┘
```

### 4-Layer Memory System

| Layer | Purpose | Location | Load Timing |
|-------|---------|----------|-------------|
| **Prompt Memory** | Always-on context | `MEMORY.md`, `USER.md` | Every session start |
| **Skills** | Procedural memory (how-to) | `~/.openclaw/skills/` | On-demand (summary → full) |
| **Session Archive** | Episodic memory (what happened) | SQLite + FTS5 | Deliberate retrieval |
| **User Model** | Behavioral patterns | Optional (Honcho-like) | Continuous passive |

### Skill Triggers

Automatically create skill when:
- ✅ 5+ tool calls in sequence
- ✅ Recovered from error successfully
- ✅ User corrected → fixed approach
- ✅ Non-obvious workflow that worked
- ✅ Repeated pattern detected (3+ times)

## Usage Examples

### Example 1: Post-Task Skill Extraction

```bash
# After completing complex deployment
export SESSION_ID="2026-04-03-deploy"
export TASK_OUTCOME="success"
export TOOL_CALLS="15"

node learning-loop.js extract
```

**Output:**
```
📊 Learning Loop Analysis

✅ Task completed successfully
📈 Tool calls: 15
⚠️  Error recovery: 2 instances
💡  User corrections: 1

🎯 Skill-worthy detected: YES

Proposed skill:
  Name: deploy-to-k8s
  Description: Deploy application to Kubernetes with health checks
  Steps: 7
  Tool calls: 15

📄 Created: ~/.openclaw/skills/devops/deploy-to-k8s/SKILL.md
```

### Example 2: Periodic Nudge

```bash
# Heartbeat triggers this
node learning-loop.js nudge
```

**Output:**
```
🔔 Periodic Nudge - Task #5

Looking back at tasks 1-5...

Task 1: ✅ Simple (no extraction needed)
Task 2: ✅ Complex workflow detected
  → Extracted: "github-pr-workflow"
Task 3: ✅ Error recovery pattern
  → Extracted: "debug-python-import"
Task 4: ✅ Simple
Task 5: ✅ User correction applied
  → Updated: "github-pr-workflow" (v1.0.1)

📊 Summary:
  - New skills: 2
  - Updated skills: 1
  - Memory entries: 3
```

### Example 3: Memory Curation

```bash
# Review what's worth keeping
node learning-loop.js curate --session="2026-04-03"
```

**Decision Framework:**
```
┌──────────────────────────────────────────────────────┐
│ Should this be persisted?                            │
├──────────────────────────────────────────────────────┤
│ ❌ Chat pleasantries → Discard                       │
│ ❌ Failed attempts → Discard (keep only success)     │
│ ✅ Successful workflows → Extract as skill           │
│ ✅ User preferences → Add to USER.md                 │
│ ✅ Project context → Add to MEMORY.md (project/)     │
│ ✅ Corrections/feedback → Add to MEMORY.md (feedback/)│
└──────────────────────────────────────────────────────┘
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LEARNING_NUDGE_INTERVAL` | Tasks between nudges | `5` |
| `LEARNING_MIN_TOOL_CALLS` | Min tool calls for skill | `5` |
| `LEARNING_AUTO_CREATE` | Auto-create skills (vs approve) | `false` |
| `LEARNING_SKILLS_DIR` | Skills directory | `~/.openclaw/skills/` |
| `LEARNING_MEMORY_DIR` | Memory directory | `~/.openclaw/memory/` |

### Config File

```yaml
# ~/.openclaw/learning-loop.yaml
learning:
  nudge:
    enabled: true
    interval: 5  # tasks
    
  skill_creation:
    auto_approve: false  # Review before creating
    min_tool_calls: 5
    categories:
      - devops
      - research
      - productivity
      
  memory:
    max_prompt_chars: 3575  # Hermes-style tight limit
    archive_enabled: true
    fts5_enabled: true
```

## Skill File Format

Follows [agentskills.io specification](https://agentskills.io/specification):

```markdown
---
name: deploy-to-k8s
description: Deploy application to Kubernetes with health checks
version: 1.0.0
platforms: [linux, macos]
metadata:
  tags: [kubernetes, devops, deployment]
  category: devops
  created_from: session-2026-04-03
---

# deploy-to-k8s

## Overview

Deploy any application to Kubernetes cluster with automated health checks and rollback.

## Prerequisites

- kubectl configured
- Kubernetes cluster access
- Docker image ready

## Steps

1. **Validate cluster connection**
   ```bash
   kubectl cluster-info
   ```

2. **Apply deployment manifest**
   ```bash
   kubectl apply -f deployment.yaml
   ```

3. **Wait for rollout**
   ```bash
   kubectl rollout status deployment/app
   ```

4. **Health check**
   ```bash
   kubectl get pods -l app=myapp
   ```

5. **Verify service**
   ```bash
   kubectl get svc app-service
   ```

## Tool Calls Used

- `exec`: kubectl commands
- `read`: deployment.yaml
- `web_search`: Kubernetes docs (if errors)

## Related Skills

- `docker-build-optimization`
- `k8s-troubleshooting`
```

## Integration with OpenClaw

### Heartbeat Integration

```markdown
## HEARTBEAT.md Update

### Learning Loop - Periodic Nudge

**Frequency:** Every 5 tasks

**Steps:**
1. Check task counter
2. If counter % 5 == 0 → Run nudge
3. Review proposed skills/memories
4. Approve/reject
5. Reset counter
```

### PUA Integration

```bash
# Task PUA can trigger learning loop
if task.failed && task.recovered:
  node learning-loop.js extract --reason="error-recovery"
  
if task.pua_level >= "L2":
  # Complex task → likely skill-worthy
  node learning-loop.js nudge
```

### Memory PUA Integration

```bash
# Memory health check includes learning loop status
node memory-pua.js audit

# Output includes:
# - Skills created this week
# - Memories curated
# - Nudge effectiveness
```

## Comparison: Hermes vs This Implementation

| Feature | Hermes Agent | This Skill |
|---------|--------------|------------|
| Periodic Nudge | ✅ Built-in | ✅ Via heartbeat |
| Skill Auto-Creation | ✅ Full auto | ⚠️ Opt-in approval |
| 4-Layer Memory | ✅ SQLite + FTS5 | ⚠️ Markdown + optional SQLite |
| Progressive Disclosure | ✅ Summary → Full | ✅ Same pattern |
| User Modeling (Honcho) | ✅ Optional | ❌ Not implemented |
| Gateway Integration | ✅ Multi-platform | ⚠️ OpenClaw channels only |
| Context Compression | ✅ Lineage-aware | ⚠️ Basic summarization |

## Benefits

- ✅ **Curated not dumped** — Agent decides what's worth keeping
- ✅ **Token-efficient** — Progressive disclosure keeps context small
- ✅ **Portable skills** — Follows agentskills.io standard
- ✅ **Self-improving** — Gets better the more you use it
- ✅ **OpenClaw native** — Works with existing memory system

## Related Skills

- **claude-memory-optimizer**: Memory structure and migration
- **task-pua**: Task persistence and quality
- **memory-pua**: Memory health maintenance

## References

- Hermes Agent: https://github.com/NousResearch/hermes-agent
- Hermes Docs: https://hermes-agent.nousresearch.com/
- agentskills.io: https://agentskills.io/specification
- FTS5 Docs: https://www.sqlite.org/fts5.html

## License

MIT-0

---

*Version 1.0.0: Initial implementation inspired by Hermes Agent learning loop*
