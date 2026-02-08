# 🧠 Hippocampus

[![GitHub](https://img.shields.io/badge/GitHub-ImpKind%2Fhippocampus--skill-blue?logo=github)](https://github.com/ImpKind/hippocampus-skill)
[![ClawdHub](https://img.shields.io/badge/ClawdHub-hippocampus-memory-orange)](https://clawdhub.com/skills/hippocampus-memory)

A living memory system for OpenClaw agents with importance scoring, time-based decay, and reinforcement—just like a real brain.

## The Concept

**The hippocampus runs in the background, just like the real organ in your brain.**

Your main agent is busy having conversations—it can't constantly stop to decide what to remember. That's what the hippocampus does. It operates as a separate process:

1. **Background encoding**: A cron job or separate agent watches conversations and encodes important signals into memory
2. **Automatic decay**: Unused memories fade over time (daily cron)
3. **Reinforcement on recall**: When memories are accessed, they strengthen automatically

The main agent doesn't "think about" memory—it just recalls what it needs, and the hippocampus handles the rest. Like a real brain.

## Features

- **Importance Scoring**: Memories rated 0.0-1.0 based on signal type
- **Time-Based Decay**: Unused memories fade (0.99^days)
- **Reinforcement**: Used memories strengthen (+15% headroom)
- **Background Processing**: Encoding runs via cron, not in main agent's context
- **OpenClaw Integration**: Bridges with memory_search via HIPPOCAMPUS_CORE.md

## Installation

```bash
cd ~/.openclaw/workspace/skills/hippocampus
./install.sh --with-cron
```

Or via ClawdHub:
```bash
clawdhub install hippocampus
```

## Quick Usage

```bash
# Load core memories at session start
./scripts/load-core.sh

# Search with importance weighting
./scripts/recall.sh "project deadline" --reinforce

# Manually boost a memory
./scripts/reinforce.sh mem_001 --boost

# Apply decay (usually via cron)
./scripts/decay.sh
```

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Capture   │────▶│   Score &   │────▶│   Store in  │
│  (encoding) │     │   Classify  │     │  index.json │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                    ┌──────────────────────────┘
                    │
                    ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│    Decay    │◀───▶│   Retrieve  │────▶│  Reinforce  │
│ (0.99^days) │     │  (recall.sh)│     │   on use    │
└─────────────┘     └─────────────┘     └─────────────┘
```

## Memory Domains

| Domain | Contents |
|--------|----------|
| `user/` | Facts about the human |
| `self/` | Agent identity & growth |
| `relationship/` | Shared context & trust |
| `world/` | External knowledge |

## Decay Timeline

| Days Unused | Retention |
|-------------|-----------|
| 7 | 93% |
| 30 | 74% |
| 90 | 40% |

## Requirements

- Python 3
- jq
- OpenClaw

## Based On

Stanford Generative Agents: "Interactive Simulacra of Human Behavior" (Park et al., 2023)

## License

MIT

---

*Memory is identity. Text > Brain.*
