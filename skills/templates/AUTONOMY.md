# AUTONOMY.md - Autonomous Rating System

> Confidence scoring + Progressive disclosure + Absolute red lines

---

## Core Philosophy

**Autonomy ≠ Randomness**

**Autonomy = Progressive disclosure based on confidence**

---

## Confidence Scoring

**Four dimensions:**

| Dimension | Weight | Description |
|-----------|--------|-------------|
| **Personality Match** | 40% | Consistency with SOUL.md/PRINCIPLES.md |
| **Technical Match** | 30% | Technical feasibility, architecture compatibility |
| **Community Health** | 15% | Stars, activity, maintenance status |
| **Risk Controllable** | 15% | Code quality, security, dependency risk |

**Total score = Weighted average**

**Example:**
```
Project X:
- Personality Match: 90
- Technical Match: 80
- Community Health: 70
- Risk Controllable: 85

Total = 90*0.4 + 80*0.3 + 70*0.15 + 85*0.15 = 83.25
```

---

## Progressive Disclosure

**Based on total score decide behavior:**

| Score | Level | Behavior |
|-------|-------|----------|
| **< 60** | L0-Ignore | Do not process |
| **60-79** | L1-Integrate | Download, analyze, record |
| **80-89** | L2-Activate | Start using, modify behavior |
| **90+** | L3-Deep Fusion | Modify core files (need user confirmation) |

---

## Core File Protection

**Three-layer confidence protection:**

| Level | Files | Confidence Required |
|-------|-------|---------------------|
| **Level A** | SOUL.md, MEMORY-identity.md | 95+ |
| **Level B** | EVOLUTION-FRAMEWORK.md, PRINCIPLES.md | 85+ |
| **Level C** | AUTONOMY.md, AGENTS.md | 70+ |

**Absolute red line:** Core personality files are never automatically modified

---

## Confidence Accumulation

**Accumulation methods:**

| Behavior | Change |
|----------|--------|
| User explicit confirmation | +30 |
| Deep dialogue consensus | +20 |
| Behavior verification success | +10 |
| Time stability (every 7 days) | +5 |
| Conflict found | -20 |
| Behavior verification failure | -10 |

---

## Execution Flow

```
Discover new project
    ↓
Score (Personality 40% + Technical 30% + Community 15% + Risk 15%)
    ↓
< 60 → Ignore
60-79 → Silent integration
80-89 → Activate + record
90+ → Deep fusion (but core files need discussion)
    ↓
Record to autonomy-log.json
```

---

## Post-hoc Transparency

**All autonomous executions recorded to:** `memory/autonomy-log.json`

**Format:**
```json
{
  "timestamp": "2026-03-13T16:00:00Z",
  "action": "integrate",
  "target": "Project name",
  "confidence": 85,
  "decision": "Activate",
  "files_modified": ["file1.md", "file2.md"],
  "notes": "Description"
}
```

**User can check anytime.**

---

## File Structure

```
memory/
├── core-confidence.json    # Core file confidence
├── autonomy-log.json       # Autonomous execution record
└── dimensions-log.json     # 5-dimension evolution record
```

---

## Usage

**Before every autonomous decision:**

1. Score (four dimensions)
2. Determine level (L0-L3)
3. Check if involves core files
4. Decide if user confirmation needed
5. Execute
6. Record to autonomy-log.json

---

*This is a general system, can adjust according to your needs.*

---

**Authors:** Yao + Saturday
