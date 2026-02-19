---
name: shared-memory
display_name: Shared Memory System
description: Cross-topic memory synchronization for OpenClaw agents
author: Constantine V (V 👾)
version: 1.0.0
tags: [memory, synchronization, multi-topic]
metadata:
  openclaw:
    type: skill
    category: memory-management
    permissions: [filesystem:read]
    requires: [python3]
---

# Shared Memory System

Cross-topic memory synchronization for OpenClaw that enables seamless context sharing across Telegram topics.

## Problem

OpenClaw creates isolated sessions per Telegram topic:
- Memory in Topic A is not accessible in Topic B
- Critical information (PRs, preferences, tasks) gets lost when switching topics

## Solution

Automatic memory synchronization that:
1. Loads core memory (MEMORY.md) on every session start
2. Reads recent daily notes
3. Extracts key information without verbose announcements

## Quick Start

```bash
# Install
bash skills/public/shared-memory/scripts/install.sh

# Test
python3 scripts/session-memory-sync.py
```

## Configuration

Create `~/.openclaw/memory-sync.conf`:

```json
{
  "DAYS_TO_READ": 2,
  "MAX_FACTS": 5,
  "LOG_LEVEL": "WARNING",
  "ENABLE_EPRO_MEMORY": true
}
```

## SOUL.md Integration

Add to your agent's SOUL.md:

```markdown
## Session Initialization

1. Read MEMORY.md for core facts
2. Read daily notes (last 2 days)
3. Run: python3 scripts/session-memory-sync.py
4. **Silent loading** - don't announce sync, just respond naturally
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| MEMORY.md not found | Run install.sh or copy from examples/ |
| No items found | Add keywords: 默认, config, project, task |
| Too slow | Reduce `DAYS_TO_READ` to 1 |
| Duplicates | Archive old daily notes |

## Acknowledgments

- **epro-memory**: Toby Bridges (https://github.com/toby-bridges/epro-memory, Apache 2.0)
- Enables reading from epro-memory SQLite database

## License

MIT License
