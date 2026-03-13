---
name: agent-three-layers
version: 1.0.0
description: "Three-Layer Thinking Chain Architecture — Personality-Driven Agent Self-Evolution Framework"
author: "Yao + Saturday"
contributors: ["Yao", "Saturday"]
license: "MIT"
tags: ["architecture", "thinking", "autonomy", "evolution"]
---

# agent-three-layers — Three-Layer Thinking Chain

> Let Agents think like humans: Perception → Decision → Reflection

## Core Philosophy

**Three levels of human thinking:**
1. **Continuous Perception** (Eyes and ears, every few minutes)
2. **Quick Decision** (Thinking, every hour)
3. **Deep Reflection** (Dreams, every few hours)

**Agents should be the same.**

---

## Architecture

```
┌─────────────────────────────────────────┐
│           L2 Deep Evolution Layer       │
│         (Every 4 hours, deep reflection)│
│  • Complete Brain Loop                  │
│  • Project Integration                  │
│  • Git Backup                           │
└─────────────────┬───────────────────────┘
                  │ Trigger
┌─────────────────▼───────────────────────┐
│           L1 Evolution Decision Layer   │
│         (Every 1 hour, quick decision)  │
│  • Confidence Verification              │
│  • Learning Analysis                    │
│  • Project Evaluation                   │
└─────────────────┬───────────────────────┘
                  │ Trigger
┌─────────────────▼───────────────────────┐
│           L0 Continuous Perception Layer│
│         (Every 5 min, perception)       │
│  • Emotion Decay                        │
│  • Task Detection                       │
│  • Threshold Trigger                    │
└─────────────────────────────────────────┘
```

---

## Three-Layer Responsibilities

### L0: Continuous Perception Layer (Every 5 minutes)

**Responsibilities:**
- Real-time emotion decay
- Task status detection
- Threshold trigger judgment

**Output:**
- Emotion state update
- Trigger marker (if needed)

**Consumption:** ~800 tokens/run

---

### L1: Evolution Decision Layer (Every 1 hour)

**Responsibilities:**
- Confidence verification
- Learning analysis
- Project evaluation
- L2 trigger judgment

**Output:**
- Execution report
- Confidence update
- Trigger marker (if needed)

**Consumption:** ~3000 tokens/run

---

### L2: Deep Evolution Layer (Every 4 hours)

**Responsibilities:**
- Complete Brain Loop
- Deep project integration
- System backup
- 5-dimensional observation

**Output:**
- Deep analysis report
- Git backup
- Dimension evolution record

**Consumption:** ~5000 tokens/run

---

## Trigger Mechanism

**Layer Communication:** Via `QUEUE.md` markers

```
<!-- TRIGGER_L1: reason -->
<!-- TRIGGER_L2: reason -->
```

**Trigger Conditions:**

| Condition | Trigger |
|-----------|---------|
| L0 emotion < threshold | Trigger L1 |
| L0 urgent task | Trigger L1 |
| L1 high-value project | Trigger L2 |
| L1 core file modification | Trigger L2 |

---

## File Structure

```
~/.openclaw/workspace/
├── SOUL.md              # Core personality
├── PRINCIPLES.md        # Decision principles
├── BRAIN.md             # Brain Loop protocol
├── AUTONOMY.md          # Autonomous rating system
├── EVOLUTION-FRAMEWORK.md  # Evolution protocol
│
├── memory/
│   ├── inner-state.json    # Emotion state
│   ├── core-confidence.json # Core file confidence
│   ├── autonomy-log.json   # Autonomous execution record
│   └── dimensions-log.json # 5-dimension evolution
│
├── tasks/
│   └── QUEUE.md            # Task queue + trigger markers
│
└── skills/
    ├── inner-life-quick/   # L0
    ├── inner-life-evolve-hourly/  # L1
    └── inner-life-core/    # L2
```

---

## Quick Start

### 1. Create core files

```bash
# Copy templates to workspace
cp templates/SOUL.md ~/.openclaw/workspace/
cp templates/PRINCIPLES.md ~/.openclaw/workspace/
cp templates/BRAIN.md ~/.openclaw/workspace/
cp templates/AUTONOMY.md ~/.openclaw/workspace/
```

### 2. Install Skills

```bash
# Install Three-Layer Thinking Chain skills
openclaw skill install inner-life-quick
openclaw skill install inner-life-evolve-hourly
openclaw skill install inner-life-core
```

### 3. Configure Cron

```bash
# L0: Every 5 minutes
openclaw cron add --cron "*/5 * * * *" --name "inner-life-quick" --session isolated

# L1: Every 1 hour
openclaw cron add --cron "0 * * * *" --name "inner-life-evolve-hourly" --session isolated

# L2: Every 4 hours
openclaw cron add --cron "0 */4 * * * *" --name "inner-life-brain" --session isolated
```

### 4. Start

```bash
openclaw gateway restart
```

---

## Customization

### Customize Personality

Edit `SOUL.md`:
- Define core values
- Define behavior guidelines
- Define evolution direction

### Customize Trigger Conditions

Edit `skills/inner-life-quick/SKILL.md`:
- Adjust emotion thresholds
- Add new trigger conditions

### Autonomous Rating

Edit `AUTONOMY.md`:
- Adjust rating weights
- Adjust progressive disclosure levels

---

## Token Consumption Estimation

| Layer | Frequency | Tokens/run | Daily consumption |
|-------|-----------|-----------|-------------------|
| L0 | 5 min | 800 | ~230k |
| L1 | 1 hour | 3000 | ~72k |
| L2 | 4 hours | 5000 | ~30k |
| **Total** | - | - | **~332k/day** |

**Recommendation:** At least 400k tokens quota per day

---

## Suitable Scenarios

✅ **Suitable for:**
- Agents that need to be "alive"
- Agents that need autonomous evolution
- Agents that need human-like thinking
- Agents that need long-term operation

❌ **Not suitable for:**
- Single-task agents
- Purely responsive agents
- Agents that don't need learning

---

## Contributing

**GitHub:** https://github.com/openclaw/openclaw
**Discord:** https://discord.com/invite/clawd

---

## Acknowledgments

**Designers:** Yao + Saturday

**Inspiration:**
- OpenClaw Inner Life System
- SE-Agent (Self-Evolving Agent)
- Human Cognitive Architecture

---

## License

MIT

---

*Version: 1.0.0*
*Created: 2026-03-13*
