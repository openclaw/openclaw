---
name: session-persistence
description: Three-layer memory persistence system for continuous context across sessions. Use when you need to maintain state, recover from session restarts, or track workspace changes. Provides SPARSE/FULL checkpoint triggers, delta recovery from .jsonl, and automatic knowledge sync.
homepage: https://github.com/openclaw/openclaw/issues/59095
metadata:
  openclaw:
    emoji: "🧠"
    requires: { bins: ["python3"] }
---

# Session Persistence - Three-Layer Memory System

A complete memory persistence system that solves the "context lost after session restart" problem.

## Architecture

```
L1 Stable Layer (knowledge-graph.md + MEMORY.md)
├── Time scale: Weekly/Monthly
└── Updates: Manual + heartbeat sync from L2

L2 Active Layer (session-checkpoint.md)
├── Time scale: Hourly/Daily
└── Updates: SPARSE (5 rounds/5 min) + FULL (heartbeat)

L3 Raw Layer (.jsonl + daily memory)
├── Time scale: Minute
└── Updates: OpenClaw native (every message)
```

## References

- `references/checkpoint-manager.md` - SPARSE/FULL triggers with Circuit Breaker
- `references/jsonl-recovery.md` - Selective delta recovery from .jsonl
- `references/knowledge-sync.md` - Automatic L2→L1 knowledge sync
- `references/workspace-watchdog.md` - Two-phase consistency detection
- `references/state-schema.md` - state.json field definitions

## Quick Start

> **Prerequisites:** Python 3.8+. Optionally install `xxhash` for faster file hashing: `pip install xxhash`

### 1. Session Startup (AGENTS.md)

Add to your AGENTS.md session startup section:

```bash
# Read checkpoint
cat ~/.openclaw/workspace/memory/session-checkpoint.md

# Recover delta (if checkpoint has delta since last checkpoint)
SP_DIR=~/.openclaw/workspace/memory/projects/session-persistence
python3 $SP_DIR/scripts/jsonl_recovery.py recover >> ~/.openclaw/workspace/memory/session-checkpoint.md
```

### 2. Heartbeat Maintenance (HEARTBEAT.md)

Add to your HEARTBEAT.md file:

```bash
# Session persistence skill directory
SP_DIR=~/.openclaw/workspace/memory/projects/session-persistence

# Workspace consistency check
python3 $SP_DIR/scripts/workspace_watchdog.py status

# Session checkpoint
python3 $SP_DIR/scripts/checkpoint_manager.py check-full --heartbeat
python3 $SP_DIR/scripts/knowledge_sync.py push
```

## Core Scripts

All scripts are under the `scripts/` folder in this skill directory.

### checkpoint_manager.py

Handles SPARSE/FULL checkpoint triggering with Circuit Breaker protection.

```bash
# Increment message count (call after each message)
python3 {baseDir}/scripts/checkpoint_manager.py increment

# Check if SPARSE should trigger
python3 {baseDir}/scripts/checkpoint_manager.py check-sparse

# Check if FULL should trigger (heartbeat)
python3 {baseDir}/scripts/checkpoint_manager.py check-full --heartbeat

# View current state
python3 {baseDir}/scripts/checkpoint_manager.py status
```

Trigger logic:
- Sparse: time gate (≥5 min) AND rounds gate (≥5 messages)
- Full: heartbeat OR toolchain end OR major decision

**Circuit Breaker:**
- 3 consecutive failures → degraded mode
- Stops all checkpoint writes until manual recovery.

### jsonl_recovery.py

Recovers delta messages from .jsonl files after the checkpoint timestamp.

```bash
# Recover and append to checkpoint
python3 {baseDir}/scripts/jsonl_recovery.py recover

# Find session files
python3 {baseDir}/scripts/jsonl_recovery.py find-sessions

# Check status
python3 {baseDir}/scripts/jsonl_recovery.py status
```

Limits:
- Max delta size: 2KB
- Max 5 messages
- Only assistant messages extracted

### knowledge_sync.py

Syncs key decisions from checkpoint to knowledge-graph.

```bash
# Push decisions to knowledge-graph
python3 {baseDir}/scripts/knowledge_sync.py push

# Preview diff without writing
python3 {baseDir}/scripts/knowledge_sync.py diff

# Pull pending updates from knowledge-graph
python3 {baseDir}/scripts/knowledge_sync.py pull

# Check status
python3 {baseDir}/scripts/knowledge_sync.py status
```

**Sync flow:**
1. Parse Key Decisions section of checkpoint
2. Compare with knowledge-graph entries
3. Add new entries to knowledge-graph (push)
4. Human review before archiving

### workspace_watchdog.py

Detects workspace file changes after compression.

```bash
# Check monitoring status
python3 {baseDir}/scripts/workspace_watchdog.py status

# Verify workspace consistency
python3 {baseDir}/scripts/workspace_watchdog.py verify

# Take a workspace snapshot
python3 {baseDir}/scripts/workspace_watchdog.py snapshot
```

**Change classification:**
- `modified`: file changed (hash changed) → potential disruption
- `deleted`: file removed → disruption
- `created`: new file appeared → normal operation

## Checkpoint Template

`session-checkpoint.md` uses a standardized template with 6 sections:

```markdown
# Session Checkpoint
_last_updated: 2026-04-03T23:00Z
_session_id: uuid_

---

### 🎯 Current Task
One-line task description.

### 📋 Task Stack
- [ ] Task 1 (P0)
- [ ] Task 2 (P1)

### ✅ This Session Completed
- [x] Completed task

### 🔑 Key Decisions
- Decision with rationale

### 📡 Recovered Delta
_delta_since_last: start → end_
**[timestamp]** Message content...

### ⚠️ Notes & Blockers
- Blocking issue
- Important note
```

## Performance

| Metric | Target | Current |
|--------|--------|---------|
| SPARSE checkpoint | < 100ms | ~50ms |
| FULL checkpoint | < 500ms | ~200ms |
| Delta recovery | < 200ms | ~100ms |
| Workspace scan (1000 files) | < 1s | ~800ms |

## Troubleshooting

### Checkpoint Not Triggering

Check state.json:

```bash
cat ~/.openclaw/workspace/memory/projects/session-persistence/state.json
```

If `degraded: true`, reset:

```bash
python3 {baseDir}/scripts/checkpoint_manager.py reset
```

### Delta Recovery Empty

Ensure:
1. Checkpoint has `_last_updated` timestamp
2. `.jsonl` file exists with newer messages
3. Timestamp format is ISO 8601

### Knowledge Sync Not Working

Check:
1. Checkpoint has Key Decisions section
2. knowledge-graph.md exists at `~/.openclaw/workspace/memory/knowledge-graph.md`
3. No duplicate detection false positive (50-char prefix match)

## Related

- Issue: https://github.com/openclaw/openclaw/issues/59095
- Community post: https://scipepper.com/scichat/circles/ai

## AI-Assisted Disclosure

This skill was developed with AI assistance (OpenClaw + GLM-5.1) and lightly tested in production for over two months. For architecture discussion, see Issue #59095.
