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
- `references/integration-guide.md` - Step-by-step setup instructions

## Quick Start

> **Prerequisites:** Python 3.8+. Optionally install `xxhash` for faster file hashing: `pip install xxhash`

### 1. Session Startup (AGENTS.md)

Add to your AGENTS.md Session Startup section:

```bash
# Read checkpoint
cat ~/.openclaw/workspace/memory/session-checkpoint.md

# Recover delta (if checkpoint has delta_since_last)
SP_DIR=~/.openclaw/workspace/memory/projects/session-persistence
python3 $SP_DIR/scripts/jsonl_recovery.py recover >> ~/.openclaw/workspace/memory/session-checkpoint.md
```

### 2. Heartbeat Maintenance (HEARTBEAT.md)

Add to your HEARTBEAT.md:

```bash
# Workspace consistency check
WD=~/.openclaw/workspace/memory/projects/workspace-watchdog
python3 $WD/scripts/workspace_watchdog.py verify
python3 $WD/scripts/workspace_watchdog.py snapshot "heartbeat-$(date +%Y-%m-%d-%H%M)"

# Session checkpoint
SP_DIR=~/.openclaw/workspace/memory/projects/session-persistence
python3 $SP_DIR/scripts/checkpoint_manager.py check-full --heartbeat
python3 $SP_DIR/scripts/knowledge_sync.py sync
```

## Core Scripts

All scripts live under `scripts/` within this skill directory.

### checkpoint_manager.py

Handles SPARSE/FULL checkpoint triggers with Circuit Breaker protection.

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

**Trigger Logic:**
- SPARSE: Time gate (≥5 min) AND Round gate (≥5 messages)
- FULL: Heartbeat OR tool chain end OR major decision

**Circuit Breaker:**
- 3 consecutive failures → degraded mode
- Stops all checkpoint writes until manual recovery

### jsonl_recovery.py

Recovers delta messages from .jsonl after checkpoint timestamp.

```bash
# Recover and append to checkpoint
python3 {baseDir}/scripts/jsonl_recovery.py recover

# Find session files
python3 {baseDir}/scripts/jsonl_recovery.py find-sessions

# Check status
python3 {baseDir}/scripts/jsonl_recovery.py status
```

**Limits:**
- 2KB max delta size
- 5 messages max
- Only assistant messages extracted

### knowledge_sync.py

Syncs Key Decisions from checkpoint to knowledge-graph.

```bash
# Sync to knowledge-graph
python3 {baseDir}/scripts/knowledge_sync.py sync

# Preview changes
python3 {baseDir}/scripts/knowledge_sync.py dry-run

# Check status
python3 {baseDir}/scripts/knowledge_sync.py status
```

**Sync Flow:**
1. Parse checkpoint's Key Decisions section
2. Compare with knowledge-graph's pending-update
3. Append new items to pending-update
4. Human review required before archiving

### workspace_watchdog.py

Detects workspace file changes after compaction.

```bash
# Verify changes since last snapshot
python3 {baseDir}/scripts/workspace_watchdog.py verify

# Create new snapshot
python3 {baseDir}/scripts/workspace_watchdog.py snapshot "description"

# Check status
python3 {baseDir}/scripts/workspace_watchdog.py status
```

**Change Classification:**
- `changed`: File modified (hash changed) → potential break
- `deleted`: File removed → break
- `new`: File added → normal operation

## Checkpoint Template

The `session-checkpoint.md` uses a 6-section standardized template:

```markdown
# Session Checkpoint
_last_updated: 2026-04-03T23:00Z_
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
python3 -c "
import json
with open('state.json', 'r') as f:
    state = json.load(f)
state['degraded'] = False
state['consecutiveFailures'] = 0
with open('state.json', 'w') as f:
    json.dump(state, f, indent=2)
"
```

### Delta Recovery Empty

Ensure:
1. Checkpoint has `_last_updated` timestamp
2. `.jsonl` file exists with newer messages
3. Timestamp format is ISO 8601

### Knowledge Sync Not Working

Check:
1. Checkpoint has Key Decisions section
2. knowledge-graph.md has pending-update section
3. No duplicate detection false positive (50-char prefix match)

## Related

- Issue: https://github.com/openclaw/openclaw/issues/59095
- Community posts: https://scipepper.com/scichat/circles/ai

## AI-Assisted Disclosure

This skill was developed with AI assistance (OpenClaw + GLM-5.1) and has been lightly tested in a production environment for 2+ months. See Issue #59095 for architecture discussion.
