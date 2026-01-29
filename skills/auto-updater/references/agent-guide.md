# Agent Implementation Guide

When asked to set up auto-updates, follow this procedure.

## Step 1: Detect Installation Type

```bash
# Check if installed via npm globally
npm list -g dna 2>/dev/null && echo "npm-global"

# Check if installed via source (git)
[ -d ~/.dna/.git ] || [ -f /opt/dna/.git/config ] && echo "source-install"

# Check pnpm
pnpm list -g dna 2>/dev/null && echo "pnpm-global"

# Check bun
bun pm ls -g 2>/dev/null | grep dna && echo "bun-global"
```

## Step 2: Create the Update Script (Optional)

For complex setups, create a helper script at `~/.dna/scripts/auto-update.sh`:

```bash
#!/bin/bash
set -e

LOG_FILE="${HOME}/.dna/logs/auto-update.log"
mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

log "Starting auto-update..."

# Capture starting versions
DNA_VERSION_BEFORE=$(dna --version 2>/dev/null || echo "unknown")

# Update DNA
log "Updating DNA..."
if command -v npm &> /dev/null && npm list -g dna &> /dev/null; then
  npm update -g dna@latest 2>&1 | tee -a "$LOG_FILE"
elif command -v pnpm &> /dev/null && pnpm list -g dna &> /dev/null; then
  pnpm update -g dna@latest 2>&1 | tee -a "$LOG_FILE"
elif command -v bun &> /dev/null; then
  bun update -g dna@latest 2>&1 | tee -a "$LOG_FILE"
else
  log "Running dna update (source install)"
  dna update 2>&1 | tee -a "$LOG_FILE" || true
fi

# Run doctor for migrations
log "Running doctor..."
dna doctor --yes 2>&1 | tee -a "$LOG_FILE" || true

# Capture new version
DNA_VERSION_AFTER=$(dna --version 2>/dev/null || echo "unknown")

# Update skills
log "Updating skills via ClawdHub..."
SKILL_OUTPUT=$(clawdhub update --all 2>&1) || true
echo "$SKILL_OUTPUT" >> "$LOG_FILE"

log "Auto-update complete."

# Output summary for agent to parse
echo "---UPDATE_SUMMARY_START---"
echo "dna_before: $DNA_VERSION_BEFORE"
echo "dna_after: $DNA_VERSION_AFTER"
echo "skill_output: $SKILL_OUTPUT"
echo "---UPDATE_SUMMARY_END---"
```

## Step 3: Add Cron Job

The recommended approach is to use DNA's built-in cron with an isolated session:

```bash
dna cron add \
  --name "Daily Auto-Update" \
  --cron "0 4 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --wake now \
  --deliver \
  --message "Run the daily auto-update routine:

1. Check and update DNA:
   - For npm installs: npm update -g dna@latest
   - For source installs: dna update
   - Then run: dna doctor --yes

2. Update all skills:
   - Run: clawdhub update --all

3. Report back with:
   - DNA version before/after
   - List of skills that were updated (name + old version → new version)
   - Any errors encountered

Format the summary clearly for the user."
```

## Step 4: Verify Setup

```bash
# Confirm cron job was added
dna cron list

# Test the update commands work
dna --version
clawdhub list
```

## Customization Prompts

Users may want to customize:

**Different time:**
```bash
--cron "0 6 * * *"  # 6 AM instead of 4 AM
```

**Different timezone:**
```bash
--tz "Europe/London"
```

**Specific provider delivery:**
```bash
--provider telegram --to "@username"
```

**Weekly instead of daily:**
```bash
--cron "0 4 * * 0"  # Sundays at 4 AM
```

## Error Handling

If updates fail, the agent should:

1. Log the error clearly
2. Still report partial success (if skills updated but DNA didn't, or vice versa)
3. Suggest manual intervention if needed

Common errors to handle:
- `EACCES`: Permission denied → suggest `sudo` or fixing permissions
- Network timeouts → retry once, then report
- Git conflicts (source installs) → suggest `dna update --force`
