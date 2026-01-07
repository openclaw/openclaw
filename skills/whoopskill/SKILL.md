---
name: whoopskill
description: WHOOP health data CLI - sleep, recovery, strain, workouts via OAuth2.
homepage: https://github.com/koala73/whoopskill
metadata: {"clawdbot":{"emoji":"💪","requires":{"bins":["whoopskill"],"env":["WHOOP_CLIENT_ID","WHOOP_CLIENT_SECRET","WHOOP_REDIRECT_URI"]}}}
---

# whoopskill

CLI for fetching WHOOP health data (sleep, recovery, strain, workouts).

## Setup

1. Create a WHOOP developer app at https://developer.whoop.com
2. Set environment variables:
   ```bash
   export WHOOP_CLIENT_ID=your_client_id
   export WHOOP_CLIENT_SECRET=your_client_secret
   export WHOOP_REDIRECT_URI=https://your-callback-url
   ```
3. Install: `npm install -g whoopskill`
4. Login: `whoopskill auth login`

## Commands

### Authentication
```bash
whoopskill auth login     # OAuth login flow
whoopskill auth logout    # Clear tokens
whoopskill auth status    # Check token status (shows expiry)
whoopskill auth refresh   # Proactively refresh token (for cron jobs)
```

### Data Fetching
```bash
whoopskill sleep --pretty --limit 7      # Last 7 sleep records
whoopskill recovery --pretty             # Today's recovery
whoopskill workout --pretty --limit 5    # Recent workouts
whoopskill cycle --pretty                # Current cycle (strain)
whoopskill summary                       # One-liner snapshot
whoopskill profile                       # User profile
whoopskill body                          # Body measurements
```

### Options
- `-d, --date <YYYY-MM-DD>` — Specific date
- `-l, --limit <n>` — Max results (default: 25)
- `-a, --all` — Fetch all pages
- `-p, --pretty` — Human-readable output

## Token Refresh (Important!)

WHOOP access tokens expire in **1 hour**. The CLI auto-refreshes when making API calls, but if you don't use it for a while, the **refresh token can also expire** (typically 7-30 days).

### Best Practice: Keep Tokens Fresh
Set up a cron job to refresh tokens regularly:

```bash
# Every 30 minutes - runs an API call which triggers auto-refresh
*/30 * * * * WHOOP_CLIENT_ID=xxx WHOOP_CLIENT_SECRET=yyy whoopskill cycle --limit 1 > /dev/null 2>&1
```

Or use the explicit refresh command:
```bash
*/30 * * * * WHOOP_CLIENT_ID=xxx WHOOP_CLIENT_SECRET=yyy whoopskill auth refresh > /dev/null 2>&1
```

### If Refresh Token Expires
You'll need to re-authenticate:
```bash
whoopskill auth login
```

## Example Outputs

### Summary
```
2026-01-07 | Recovery: 68% | Sleep: 74% | Strain: 6.8 | Workouts: 1
```

### Sleep (pretty)
```
Date: 2026-01-07
Performance: 74%
Duration: 6h 16m
Efficiency: 86%
Stages:
  - Light: 3h 7m
  - Deep: 1h 28m
  - REM: 1h 41m
Disturbances: 2
```

## Token Storage

Tokens are stored in `~/.whoop-cli/tokens.json` with 600 permissions.

## Troubleshooting

**"Missing WHOOP_CLIENT_ID..."** — Set env vars before running
**"Token refresh failed"** — Refresh token expired, run `whoopskill auth login`
**Empty data** — WHOOP API may be delayed; data syncs from device periodically
