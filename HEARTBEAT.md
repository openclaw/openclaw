# HEARTBEAT.md

# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.

## Self-Reflection Check (~60分钟)

- [ ] Review today's work for notable lessons
- [ ] Log patterns to memory/self-review.md if found
- [ ] Check for repeated mistakes

## Skills-Watchdog (每日09:00)

- [ ] Run: bash ~/.openclaw/workspaces/agent-Two/skills/skills-watchdog/scripts/check.sh
- [ ] Notify if any skill updates found

## Google Auth Health Check (~每4小时)

- [ ] Run: bash ~/.openclaw/workspaces/agent-Two/scripts/gog_auth_autoheal.sh kyle@chancecon.co.nz user --check-only
- [ ] If status=MISSING_TOKEN: run without --check-only and complete OAuth once
- [ ] Log result to memory/YYYY-MM-DD.md when token state changes

## Soul-Keeper Check (~10轮对话或"done")

- [ ] Audit workspace files (SOUL.md, USER.md, MEMORY.md)
- [ ] Check for orphan crons or stale entries
- [ ] Update pending-updates.md if needed
