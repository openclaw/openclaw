# Clawdbot Update Procedure

Reference for secure self-updates during daily maintenance.

## Pre-Update Checks
```bash
# Security audit BEFORE updating
clawdbot security audit

# Check system health
clawdbot doctor
```

## Update Commands
```bash
# Standard update (use --channel stable for safest)
clawdbot update

# Or interactive wizard for more control
clawdbot update wizard
```

### Channels
- `--channel stable` — safest for production (use this)
- `--channel beta` — tested but newer
- `--channel dev` — bleeding edge, requires git checkout

## Post-Update Verification
```bash
# Fix config issues
clawdbot doctor --fix

# Tighten permissions, flag misconfigurations
clawdbot security audit --fix

# Verify health
clawdbot health
```

## Critical Security Notes
- Gateway authentication is required by default
- Ensure Node.js 22.12.0+ (required for security patches)
- Never bind to 0.0.0.0 without authentication configured
- If network-exposed: review docs.clawd.bot/gateway/security

## Full Sequence
1. `clawdbot security audit`
2. `clawdbot doctor`
3. Review changelog & code changes
4. If safe: `clawdbot update` (stable channel)
5. `clawdbot doctor --fix`
6. `clawdbot security audit --fix`
7. `clawdbot health`
