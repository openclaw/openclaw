# Hermes Learning Loop for OpenClaw

> **Inspired by**: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)

**Self-improving learning loop that automatically extracts successful workflows, creates reusable skills, and persists curated knowledge across sessions.**

## 🎯 Overview

Most AI agents either:
- ❌ Log everything and retrieve nothing useful
- ❌ Log nothing and start fresh every session

**Hermes Learning Loop** solves this by giving the agent itself the responsibility to decide what's worth keeping.

### Core Innovation

**Periodic Nudge** — Every N tasks (default: 5), the agent receives an internal system prompt asking it to:
1. Look back at recent activity
2. Evaluate what's worth persisting
3. Extract skills from successful workflows
4. Write curated memories (not dumps)

## 📦 Installation

```bash
clawhub install hermes-learning-loop
```

## 🚀 Quick Start

### Manual Trigger

```bash
# After completing a complex task
node learning-loop.js extract --session=2026-04-03

# Periodic nudge (heartbeat)
node learning-loop.js nudge

# Review memories
node learning-loop.js curate --session=2026-04-03

# Check status
node learning-loop.js status
```

### Auto-Trigger (Heartbeat)

Add to `HEARTBEAT.md`:

```markdown
### Learning Loop - Periodic Nudge

**Frequency:** Every 5 tasks

**Steps:**
1. Run `node learning-loop.js nudge`
2. Review proposed skills/memories
3. Approve/reject
```

## 📊 Architecture

### Learning Loop Cycle

```
Task Execution → Periodic Nudge → Memory Extraction → Skill Creation
     ↑                                                        │
     └────────────────────────────────────────────────────────┘
```

### 4-Layer Memory System

| Layer | Purpose | Load Timing |
|-------|---------|-------------|
| **Prompt Memory** | Always-on context (`MEMORY.md`, `USER.md`) | Every session |
| **Skills** | Procedural memory (how-to) | On-demand |
| **Session Archive** | Episodic memory (what happened) | Deliberate retrieval |
| **User Model** | Behavioral patterns | Continuous (optional) |

## 🔥 Features

- ✅ **Periodic Nudge** — Auto-reflect every N tasks
- ✅ **Skill Extraction** — Convert workflows to reusable skills
- ✅ **Curated Memory** — Agent decides what's worth keeping
- ✅ **Progressive Disclosure** — Summary by default, full content on-demand
- ✅ **FTS5 Session Search** — SQLite-powered retrieval
- ✅ **agentskills.io Compatible** — Portable skill format

## 📋 Skill Triggers

Automatically create skill when:
- ✅ 5+ tool calls in sequence
- ✅ Recovered from error successfully
- ✅ User corrected → fixed approach
- ✅ Non-obvious workflow that worked
- ✅ Repeated pattern detected (3+ times)

## 🎯 Usage Examples

### Example 1: Post-Task Extraction

```bash
export SESSION_ID="2026-04-03-deploy"
node learning-loop.js extract $SESSION_ID
```

**Output:**
```
📊 Learning Loop Analysis

✅ Task completed successfully
📈 Tool calls: 15
⚠️  Error recovery: 2 instances

🎯 Skill-worthy detected: YES

Proposed skill:
  Name: deploy-to-k8s
  Description: Deploy application to Kubernetes with health checks
  
📄 Created: ~/.openclaw/skills/devops/deploy-to-k8s/SKILL.md
```

### Example 2: Periodic Nudge

```bash
node learning-loop.js nudge
```

**Output:**
```
🔔 Periodic Nudge - Task #5

Task 1: ✅ Simple
Task 2: 🎯 Complex workflow → "github-pr-workflow"
Task 3: 🎯 Error recovery → "debug-python-import"
Task 4: ✅ Simple
Task 5: 🎯 User correction → Updated "github-pr-workflow"

📊 Summary:
  - New skills: 2
  - Updated skills: 1
```

## ⚙️ Configuration

### Environment Variables

```bash
export LEARNING_NUDGE_INTERVAL=5      # Tasks between nudges
export LEARNING_MIN_TOOL_CALLS=5      # Min tool calls for skill
export LEARNING_AUTO_CREATE=false     # Review before creating
export LEARNING_SKILLS_DIR=~/.openclaw/skills
```

### Config File

```yaml
# ~/.openclaw/learning-loop.yaml
learning:
  nudge:
    enabled: true
    interval: 5
    
  skill_creation:
    auto_approve: false
    min_tool_calls: 5
```

## 📁 Directory Structure

```
hermes-learning-loop/
├── SKILL.md
├── README.md
└── scripts/
    └── learning-loop.js
```

## 🆚 Hermes Agent vs This Implementation

| Feature | Hermes Agent | This Skill |
|---------|--------------|------------|
| Periodic Nudge | ✅ Built-in | ✅ Via heartbeat |
| Skill Auto-Creation | ✅ Full auto | ⚠️ Opt-in approval |
| 4-Layer Memory | ✅ SQLite + FTS5 | ⚠️ Markdown + optional |
| Progressive Disclosure | ✅ | ✅ Same pattern |
| User Modeling (Honcho) | ✅ Optional | ❌ Not implemented |
| Gateway Integration | ✅ Multi-platform | ⚠️ OpenClaw channels |

## 🔗 Integration

### With PUA Skills

```bash
# Task PUA triggers learning loop on complex tasks
if task.pua_level >= "L2":
  node learning-loop.js nudge
```

### With Memory PUA

```bash
# Memory audit includes learning stats
node memory-pua.js audit
# Output: Skills created, memories curated
```

## 📚 References

- Hermes Agent: https://github.com/NousResearch/hermes-agent
- Hermes Docs: https://hermes-agent.nousresearch.com/
- agentskills.io: https://agentskills.io/specification

## 📄 License

MIT-0

---

*Version 1.0.0: Initial implementation inspired by Hermes Agent learning loop*
