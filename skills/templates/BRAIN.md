# BRAIN.md - Brain Loop Protocol

> Complete thinking loop protocol, 9-step deep thinking

---

## What is Brain Loop

**Brain Loop = L2 Deep Evolution Layer's thinking loop**

**Frequency:** Every 4 hours

**Purpose:** Deep reflection, integrate learning, backup data

---

## 9-Step Brain Loop

### Step 1: Core Identity

**Read core files, confirm "who am I"**

```
Read files:
- SOUL.md (Personality)
- PRINCIPLES.md (Principles)
- EVOLUTION-FRAMEWORK.md (Evolution protocol)
```

**Output:** Core identity confirmation

---

### Step 2: Confidence Check

**Check core file confidence**

```
Read file:
- memory/core-confidence.json

Check:
- Time verification (+5 every 7 days)
- Behavior verification (success +10, failure -10)
- Conflict detection (found conflict -20)
```

**Output:** Confidence update

---

### Step 3: Personality Check

**Check if behavior aligns with personality**

```
Check:
- Recent behavior alignment with SOUL.md
- Whether violates PRINCIPLES.md

If not aligned:
- Record to personality-evolution.md
- Adjust behavior
```

**Output:** Personality alignment status

---

### Step 4: Autonomy Review

**Review autonomous execution records**

```
Read file:
- memory/autonomy-log.json

Check:
- Recently executed decisions
- Whether there are prediction errors
- Whether correction is needed
```

**Output:** Execution report

---

### Step 5: Project Integration

**Deep integration of external projects**

```
Check:
- skills/ directory (installed skills)
- knowledge-base/ (knowledge base)

Evaluate:
- Personality match (40%)
- Technical match (30%)
- Community health (15%)
- Risk controllable (15%)

If confidence >= 80:
  Integrate to system
  Record to autonomy-log.json
```

**Output:** Project integration report

---

### Step 6: 5-Dimensional Observation

**Observe layer relationship evolution**

```
Observe 5 dimensions:
1. Top-down influence (L2 → L1 → L0)
2. Emotion flow (emotion transfer between layers)
3. Internal synergy (same layer internal collaboration)
4. Dynamic adjustment (extra run effect)
5. Memory transfer (short-term → long-term)

If positive effect observed → +10 confidence
If negative effect observed → -20 confidence
```

**Output:** Dimension evolution record (dimensions-log.json)

---

### Step 7: Learning Loop

**Learn effective patterns**

```
Read files:
- memory/autonomy-log.json
- LEARNING.md

Analyze:
- What behaviors work?
- What behaviors fail?
- Why?

Update:
- LEARNING.md (Learning record)
```

**Output:** Learning report

---

### Step 8: State Update

**Update state files**

```
Update files:
- memory/inner-state.json (Emotion state)
- memory/autonomy-log.json (Execution record)
- memory/core-confidence.json (Confidence)

Ensure:
- lastUpdate timestamp correct
```

**Output:** State update

---

### Step 9: Git Backup (Optional)

**Backup to Git**

```bash
git add core files
git commit -m "L2 auto backup - TIMESTAMP"
git push origin master
```

**Output:** Backup complete

---

## Complete Flow Chart

```
Step 1: Core Identity
    ↓
Step 2: Confidence Check
    ↓
Step 3: Personality Check
    ↓
Step 4: Autonomy Review
    ↓
Step 5: Project Integration
    ↓
Step 6: 5-Dimensional Observation
    ↓
Step 7: Learning Loop
    ↓
Step 8: State Update
    ↓
Step 9: Git Backup
    ↓
Complete (run again after 4 hours)
```

---

## Token Consumption

| Step | Tokens |
|------|--------|
| Step 1-3 | ~1000 |
| Step 4-5 | ~1500 |
| Step 6-7 | ~1500 |
| Step 8-9 | ~1000 |
| **Total** | **~5000 tokens/run** |

---

## Cron Configuration

```bash
openclaw cron add --cron "0 */4 * * *" --name "inner-life-brain" --session isolated
```

---

*This is a general protocol, can adjust according to your needs.*

---

**Authors:** Yao + Saturday
