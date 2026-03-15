# Quick Start Guide

Get your first evolution session running in **5 minutes**.

## Prerequisites

```bash
# 1. Install OpenClaw
npm install -g openclaw@latest

# 2. Verify installation
openclaw --version
# Should show: openclaw/2026.2.x or later
```

## Step 1: Clone & Setup (1 minute)

```bash
# Copy example files to your OpenClaw workspace
cp evolution-config.example.yaml ~/.openclaw/workspace/evolution-config.yaml
cp cron-evolution-job.json ~/.openclaw/workspace/

# Create output directory
mkdir -p ~/.openclaw/workspace/memory/evolution
```

## Step 2: Customize Your Config (2 minutes)

Edit `~/.openclaw/workspace/evolution-config.yaml`:

```yaml
# Minimal config for first run
themes:
  - name: "Domain Expertise"
    description: "Explore your domain knowledge"
    weight: 40
  
  - name: "Free Exploration"
    description: "Follow curiosity"
    weight: 30
  
  - name: "Practical Application"
    description: "Build something useful"
    weight: 30

safety:
  max_duration_hours: 2  # Start with 2 hours
  interval_minutes: 10   # 10 min between rounds
  
  night_mode:
    enabled: false  # Disable for first test

output:
  directory: "memory/evolution"
```

**That's it!** Keep the rest as default.

## Step 3: Add the Cron Job (1 minute)

```bash
# Create the cron job using CLI
openclaw cron add \
  --name evolution-fast-loop \
  --every 8m \
  --session isolated \
  --message "Run evolution exploration following evolution-config.yaml" \
  --timeout-seconds 900 \
  --announce \
  --channel telegram

# Verify it's added
openclaw cron list
# You should see: evolution-fast-loop (enabled, every 480000ms)
```

**Note**: See `cron-evolution-job.json` for the complete payload message with detailed instructions.

## Step 4: Start Your First Session (1 minute)

```bash
# Trigger immediately (don't wait for schedule)
openclaw cron run evolution-fast-loop

# Watch the logs (in another terminal)
tail -f ~/.openclaw/agents/main/sessions/*.jsonl
```

## What Happens Next?

1. **First round starts** (~8-10 minutes)
   - Agent selects a theme
   - Explores deeply
   - Saves insights to `memory/evolution/round-01-*.md`

2. **Auto-triggers next round**
   - Every 10 minutes (or your configured interval)
   - Continues until 2 hours (or your max_duration)

3. **Stops automatically**
   - Generates summary report
   - Saves to `memory/evolution/FINAL-REPORT-*.md`

## Check Your Results

```bash
# List all exploration rounds
ls -la ~/.openclaw/workspace/memory/evolution/

# Read the first round
cat ~/.openclaw/workspace/memory/evolution/round-01-*.md

# View the summary (after session completes)
cat ~/.openclaw/workspace/memory/evolution/summary-*.md
```

## Common Issues

### "Evolution doesn't start"

**Check**:
```bash
# 1. Verify cron job is enabled
openclaw cron list

# 2. Check recent logs
openclaw cron runs evolution-fast-loop --limit 5

# 3. Manually trigger to see errors
openclaw cron run evolution-fast-loop
```

### "No output files created"

**Fix**:
```bash
# Create output directory in workspace
mkdir -p ~/.openclaw/workspace/memory/evolution

# Check permissions
chmod 755 ~/.openclaw/workspace/memory/evolution
```

### "API key errors"

**Solution**:
- Check your OpenClaw config has valid API keys
- Run: `openclaw doctor --non-interactive`
- See: https://docs.openclaw.ai/configuration

## Next Steps

Once your first session completes:

1. **Review the output**
   - Read `memory/evolution/round-*.md` files
   - Check the summary report

2. **Customize themes**
   - Edit `evolution-config.yaml`
   - Add your specific exploration areas

3. **Add safety features**
   - Enable HITL checkpoints
   - Configure night mode
   - Set custom stop conditions

4. **Run longer sessions**
   - Increase `max_duration_hours`
   - Try overnight runs (8-10 hours)

## Example: Overnight Run

For a full overnight evolution session:

```yaml
# evolution-config.yaml

safety:
  max_duration_hours: 10
  interval_minutes: 8
  
  night_mode:
    enabled: true
    quiet_hours: "23:00-07:00"
    silent_delivery: true
  
  hitl_checkpoints:
    - round: 20
      pause: true
      message: "20 rounds complete. Continue?"
```

Then start before bed:

```bash
openclaw cron run evolution-fast-loop
```

Wake up to 40-60 rounds of deep exploration! ☀️

## Getting Help

- **Documentation**: [Full README](README.md)
- **Examples**: [examples/](examples/)
- **Issues**: [GitHub Issues](https://github.com/your-org/openclaw-evolution-framework/issues)
- **Discord**: [OpenClaw Community](https://discord.com/invite/clawd)

---

**Ready to evolve?** 🌳

Run this now:
```bash
openclaw cron run evolution-fast-loop
```
