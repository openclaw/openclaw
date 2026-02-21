# Auto-Update Extension v0.1 Test Guide

## When integrated, test these commands:

```bash
# 1. View status
openclaw update status

# 2. Enable auto-update
openclaw update --auto on

# 3. Set interval
openclaw update --interval daily

# 4. Skip versions
openclaw update --skip "2026.2.10,2026.2.11"

# 5. Enable notifications
openclaw update --notify on

# 6. View updated status
openclaw update status
```

## Expected Output Example:

```
OpenClaw Auto-Update Status
──────────────────────────────────────
  Enabled:    ON
  Interval:  daily
  Skip:      2026.2.10, 2026.2.11
  Notify:    ON
──────────────────────────────────────
```

## Files Created:

- `src/cli/update-cli/auto-update.ts` - Main extension
- Config stored at: `~/.openclaw/auto-update.json`

## To Test Locally:

1. Once PR merges, update OpenClaw
2. Run the commands above
3. Check config file: `cat ~/.openclaw/auto-update.json`
