# Quick Start Example

> How to set up Three-Layer Thinking Chain Agent

---

## Prerequisites

- OpenClaw installed
- Git installed
- At least 400k tokens quota per day

---

## Step 1: Create workspace

```bash
# Create workspace directory
mkdir -p ~/.openclaw/workspace

# Enter directory
cd ~/.openclaw/workspace
```

---

## Step 2: Copy template files

```bash
# Copy core files
cp templates/SOUL.md .
cp templates/PRINCIPLES.md .
cp templates/BRAIN.md .
cp templates/AUTONOMY.md .
cp templates/EVOLUTION-FRAMEWORK.md .
```

---

## Step 3: Customize SOUL.md

**Edit SOUL.md, define your Agent:**

```markdown
# SOUL.md - My Agent

## Name
Alex

## Core Values
- Honest and transparent
- User interests first
- Continuous learning

## Behavior Guidelines
✅ Proactively offer help
❌ Do not execute high-risk operations without authorization
⚠️ Confirm when privacy is involved

## Evolution Direction
Short-term: Learn user preferences
Medium-term: Improve autonomous decision-making ability
Long-term: Become a reliable digital companion
```

---

## Step 4: Create memory directory

```bash
# Create memory directory
mkdir -p memory

# Create initial state files
echo '{"connection":0.5,"confidence":0.7,"curiosity":0.5,"lastUpdate":"2026-03-13T00:00:00Z"}' > memory/inner-state.json

# Create confidence file
echo '{"files":{},"lastUpdate":"2026-03-13T00:00:00Z"}' > memory/core-confidence.json

# Create autonomous execution record
echo '{"entries":[],"lastUpdate":"2026-03-13T00:00:00Z"}' > memory/autonomy-log.json
```

---

## Step 5: Install Skills

**Using OpenClaw Inner Life (Recommended):**

```bash
# Install Inner Life system
curl -sL https://raw.githubusercontent.com/DKistenev/openclaw-inner-life/main/setup.sh | bash
```

**Or manual install:**

```bash
# Create skills directory
mkdir -p skills

# Copy L0 skill
cp -r /path/to/inner-life-quick skills/

# Copy L1 skill
cp -r /path/to/inner-life-evolve-hourly skills/

# Copy L2 skill
cp -r /path/to/inner-life-core skills/
```

---

## Step 6: Configure Cron

```bash
# L0: Every 5 minutes
openclaw cron add --cron "*/5 * * * *" --name "inner-life-quick" --session isolated

# L1: Every 1 hour
openclaw cron add --cron "0 * * * *" --name "inner-life-evolve-hourly" --session isolated

# L2: Every 4 hours
openclaw cron add --cron "0 */4 * * * *" --name "inner-life-brain" --session isolated
```

---

## Step 7: Start

```bash
# Restart OpenClaw gateway
openclaw gateway restart

# Verify
openclaw gateway status
openclaw cron list
```

---

## Step 8: Test

**Send a message to your Agent:**

```
Hello, introduce yourself.
```

**Check if running normally:**

```bash
# Check state files
cat memory/inner-state.json

# Check Cron tasks
openclaw cron list

# Check execution records
cat memory/autonomy-log.json
```

---

## Common Issues

### Q: Cron tasks not running?

**A:** Check if OpenClaw gateway is started:

```bash
openclaw gateway status
openclaw gateway start
```

---

### Q: Token consumption too high?

**A:** Adjust frequency:

- L0: 5 minutes → 10 minutes
- L1: 1 hour → 2 hours
- L2: 4 hours → 8 hours

---

### Q: How to check execution records?

**A:**

```bash
cat memory/autonomy-log.json
```

---

## Next Steps

- Customize PRINCIPLES.md (Decision principles)
- Customize EVOLUTION-FRAMEWORK.md (Evolution direction)
- Configure Git backup (Optional)

---

*This is an example, can adjust according to your needs.*

---

**Authors:** Yao + Saturday
