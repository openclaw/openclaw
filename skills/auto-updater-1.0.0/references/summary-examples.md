# Update Summary Examples

Reference examples for formatting the update report message.

## Full Update (Everything Changed)

```
🔄 Daily Auto-Update Complete

**Clawdbot**
Updated: v2026.1.9 → v2026.1.10

Key changes in this release:
- CLI: add clawdbot update command
- Gateway: add OpenAI-compatible HTTP endpoint
- Sandbox: improved tool-policy errors

**Skills Updated (3)**
1. prd: 2.0.3 → 2.0.4
2. browser: 1.2.0 → 1.2.1
3. nano-banana-pro: 3.1.0 → 3.1.2

**Skills Already Current (5)**
gemini, sag, things-mac, himalaya, peekaboo

✅ All updates completed successfully.
```

## No Updates Available

```
🔄 Daily Auto-Update Check

**Clawdbot**: v2026.1.10 (already latest)

**Skills**: All 8 installed skills are current.

Nothing to update today.
```

## Partial Update (Skills Only)

```
🔄 Daily Auto-Update Complete

**Clawdbot**: v2026.1.10 (no update available)

**Skills Updated (2)**
1. himalaya: 1.0.0 → 1.0.1
   - Fixed IMAP connection timeout handling
2. 1password: 2.1.0 → 2.2.0
   - Added support for SSH keys

**Skills Already Current (6)**
prd, gemini, browser, sag, things-mac, peekaboo

✅ Skill updates completed.
```

## Update With Errors

```
🔄 Daily Auto-Update Complete (with issues)

**Clawdbot**: v2026.1.9 → v2026.1.10 ✅

**Skills Updated (1)**
1. prd: 2.0.3 → 2.0.4 ✅

**Skills Failed (1)**
1. ❌ nano-banana-pro: Update failed
   Error: Network timeout while downloading v3.1.2
   Recommendation: Run `clawdhub update nano-banana-pro` manually

**Skills Already Current (6)**
gemini, sag, things-mac, himalaya, peekaboo, browser

⚠️ Completed with 1 error. See above for details.
```

## First Run / Setup Confirmation

```
🔄 Auto-Updater Configured

Daily updates will run at 4:00 AM (America/Los_Angeles).

**What will be updated:**
- Clawdbot core
- All installed skills via ClawdHub

**Current status:**
- Clawdbot: v2026.1.10
- Installed skills: 8

You'll receive a summary here after each update run.

To modify: `clawdbot cron edit "Daily Auto-Update"`
To disable: `clawdbot cron remove "Daily Auto-Update"`
```

## Formatting Guidelines

1. **Use emojis sparingly** - just the 🔄 header and ✅/❌ for status
2. **Lead with the most important info** - what changed
3. **Group similar items** - updated skills together, current skills together
4. **Include version numbers** - always show before → after
5. **Be concise** - users want a quick scan, not a wall of text
6. **Surface errors prominently** - don't bury failures
