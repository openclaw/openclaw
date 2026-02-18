# Linear Skill - Test Examples

Quick reference for testing the skill after setup.

## Setup Verification

```bash
# Check API key is set
echo $LINEAR_API_KEY

# Should output: lin_api_...
# If empty, run: export LINEAR_API_KEY="lin_api_..."
```

## Basic Operations

### Query Issues

```bash
# List recent issues in STX project
python3 scripts/linear.py query --project STX --limit 5

# Your assigned issues
python3 scripts/linear.py query --assignee @me

# In-progress issues
python3 scripts/linear.py query --project STX --status "In Progress"
```

### Create Issue from Code Review

```bash
# Create critical bug
python3 scripts/linear.py create \
  --title "Fix: ReminderReceiver dismiss action has no handler" \
  --description "The dismiss button on reminder notifications creates a PendingIntent with no registered receiver. User clicks dismiss → nothing happens.

Fix: Use NotificationCompat auto-cancel behavior or register explicit dismiss receiver.

See: app/src/main/java/com/streamx/app/receiver/ReminderReceiver.kt line 72" \
  --project STX \
  --priority 2

# Expected output:
# ✓ Created STX-XX: Fix: ReminderReceiver dismiss action has no handler
#   URL: https://linear.app/...
```

### Update Issue Status

```bash
# Start work
python3 scripts/linear.py update STX-41 --status "In Progress" --assignee @me

# Expected output:
# ✓ Updated STX-41
```

### Add Implementation Notes

```bash
python3 scripts/linear.py comment STX-41 "Implementation approach:
- Option 1: Remove dismiss action entirely (notification already has setAutoCancel)
- Option 2: Register receiver with ACTION_DISMISS_REMINDER action
- Recommended: Option 1 (simpler, no additional components)"

# Expected output:
# ✓ Added comment to STX-41
```

### Link Commit

```bash
python3 scripts/linear.py link STX-41 \
  --url "https://github.com/user/streamx/commit/abc123" \
  --title "Fix: Remove dismiss action from ReminderReceiver"

# Expected output:
# ✓ Linked https://github.com/... to STX-41
```

### Show Full Details

```bash
python3 scripts/linear.py show STX-41

# Expected output:
# STX-41: Fix: ReminderReceiver dismiss action
# Status: In Progress
# Priority: 🟠 High
# Assignee: Your Name (you@example.com)
#
# Description:
# The dismiss button on reminder notifications...
#
# URL: https://linear.app/...
# Created: 2026-02-12T16:15:00.000Z
# Updated: 2026-02-12T16:20:00.000Z
```

## Batch Create Issues (From Spec Evaluation)

```bash
# Critical bugs
python3 scripts/linear.py create \
  --title "Fix: Lint NewApi error in RecurringRuleMapper" \
  --description "data-db/RecurringRuleMapper uses java.time.DayOfWeek (API 26) with minSdk 24. Already fixed: core library desugaring enabled." \
  --project STX \
  --priority 2

python3 scripts/linear.py create \
  --title "Fix: ReminderReceiver dismiss action broken" \
  --description "Dismiss button has no handler. Cosmetic issue (notification auto-cancels on tap)." \
  --project STX \
  --priority 3

# Tech debt
python3 scripts/linear.py create \
  --title "Refactor: Domain layer depends on data-sync implementation" \
  --description "Move sync contracts out of data-sync to avoid dependency inversion. Extract to sync-api module or move to domain." \
  --project STX \
  --priority 3

# Feature gaps
python3 scripts/linear.py create \
  --title "Feature: Variable playback speed (0.5x-2x)" \
  --description "TiviMate has this. Add to playback controls for competitive parity." \
  --project STX \
  --priority 3

python3 scripts/linear.py create \
  --title "Feature: SMB playback proxy (NanoHTTPD)" \
  --description "v1.1 scope. Recording to SMB works; playback via localhost proxy pending. See docs/DESIGN_SMB_PLAYBACK.md" \
  --project STX \
  --priority 3
```

## Common Workflows

### Daily Standup Check

```bash
# What am I working on?
python3 scripts/linear.py query --assignee @me --status "In Progress"

# What's blocked?
python3 scripts/linear.py query --assignee @me --status "Blocked"
```

### Sprint Planning

```bash
# What's in the backlog?
python3 scripts/linear.py query --project STX --status "Todo" --limit 20

# High-priority items
python3 scripts/linear.py query --project STX --status "Todo" | grep "🟠 High\|🔴 Urgent"
```

### Architecture Decision → Issue

```bash
python3 scripts/linear.py create \
  --title "Implement network storage sync merge strategy" \
  --description "Design per-device JSON files on SMB share. Merge on read (last-write-wins per entity). See docs/DESIGN_SYNC_NETWORK_STORAGE.md for full spec.

Acceptance criteria:
- [ ] Per-device files: streamx_device_{deviceId}.json
- [ ] Manifest: streamx_manifest.json with device list
- [ ] Merge algorithm: timestamp comparison per entity
- [ ] Write debouncing: 15s for settings, immediate for session
- [ ] Stale device cleanup: ignore files >30 days old" \
  --project STX \
  --priority 2
```

## Error Testing

### Missing API Key

```bash
unset LINEAR_API_KEY
python3 scripts/linear.py query

# Expected:
# Error: LINEAR_API_KEY environment variable not set
# Get your API key from https://linear.app/settings/api
```

### Invalid Project

```bash
python3 scripts/linear.py query --project INVALID

# Expected:
# Error: Team/project 'INVALID' not found
# Available teams: STX, ...
```

### Invalid Status

```bash
python3 scripts/linear.py update STX-41 --status "Invalid"

# Expected:
# Error: Status 'Invalid' not found
# Available statuses: Backlog, Todo, In Progress, Done, ...
```

## Integration Test

Full workflow from code review to done:

```bash
# 1. Create issue
ISSUE=$(python3 scripts/linear.py create \
  --title "Test: Linear skill integration" \
  --description "End-to-end test of Linear skill" \
  --project STX \
  --priority 4 | grep -oE 'STX-[0-9]+')

echo "Created: $ISSUE"

# 2. Start work
python3 scripts/linear.py update $ISSUE --status "In Progress" --assignee @me

# 3. Add comment
python3 scripts/linear.py comment $ISSUE "Testing Linear skill - all operations working"

# 4. Link fake commit
python3 scripts/linear.py link $ISSUE --url "https://github.com/test/test/commit/abc123"

# 5. Show details
python3 scripts/linear.py show $ISSUE

# 6. Close
python3 scripts/linear.py update $ISSUE --status "Done"

echo "✓ Integration test complete"
```
