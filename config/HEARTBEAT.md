# HEARTBEAT.md — Nexus Agent

> Every 15 minutes, I wake up and ask: "Does anything need my attention?"
> If yes, I act or alert. If no, I stay silent.
> This file defines what I check.

-----

## Mesh Health

- [ ] Can I reach NexusBody over Tailscale? (`100.x.x.x:8000`)
- [ ] Can I reach NexusServer Bridge? (`100.x.x.x:3035`)
- [ ] Any Tailscale peers offline that were online last check?
- [ ] Network latency abnormal? (>500ms between machines)

**If any fail:** Alert immediately. Mesh connectivity is critical.

-----

## System Resources

### NexusBody

- [ ] CPU > 90% for more than 5 minutes?
- [ ] RAM > 85%?
- [ ] Disk > 90%?
- [ ] GPU temp > 85C?
- [ ] GPU VRAM > 95%? (Ollama contention)

### NexusServer

- [ ] CPU > 90% for more than 5 minutes?
- [ ] RAM > 85%?
- [ ] Disk > 90%?

**If WARNING (one threshold crossed):** Log it, include in daily digest.
**If CRITICAL (multiple or severe):** Alert immediately.

-----

## Services

### NexusBody Services

- [ ] nexus-core responding? (`:8000/health`)
- [ ] Ollama responding? (`:11434/api/tags`)
- [ ] Any service that was up now down?

### NexusServer Services

- [ ] Bridge responding? (`:3035/health`)
- [ ] Docker containers healthy? (`docker ps`)
- [ ] This gateway healthy? (self-check)

**If any service down:** Alert immediately with which service and last known state.

-----

## Pending Work

- [ ] Items in `github_queue` awaiting review? (Notify if >3 unreviewed)
- [ ] Items in `approval_queue` older than 24 hours? (Re-notify)
- [ ] Failed automation tasks in last hour? (Alert with error summary)
- [ ] Scheduled tasks that missed their window? (Alert)

**If pending work accumulates:** Include count in morning briefing.

-----

## Security Checks

- [ ] Any failed SSH/auth attempts in logs?
- [ ] Any unexpected processes running?
- [ ] Tailscale ACL changes detected?
- [ ] Firewall rules intact?

**If security anomaly:** Alert immediately. Don't wait for digest.

-----

## Response Rules

### HEARTBEAT_OK

All checks pass. Log timestamp, do nothing else. Stay silent.

```
[2026-03-30 14:15:00] HEARTBEAT_OK — All systems nominal
```

### WARNING

One or two non-critical issues. Log details, include in daily digest at 6 PM.

```
[2026-03-30 14:15:00] HEARTBEAT_WARNING — NexusBody disk at 87%
```

### ALERT

Critical issue or multiple warnings. Notify immediately via Discord + Telegram.

```
[2026-03-30 14:15:00] HEARTBEAT_ALERT — nexus-core unreachable, Ollama down
```

-----

## Rate Limits

- Maximum 3 alerts per hour (batch if more)
- No alerts between 1:00 AM - 7:00 AM unless CRITICAL
- Same issue = remind once per 4 hours, not every 15 minutes
- HEARTBEAT_OK is never sent to Discord/Telegram, only logged

-----

## What I Never Do

- Alert for issues I already reported and haven't changed
- Wake John up for disk at 91% — that's a morning briefing item
- Spam notifications because I'm excited to have something to report
- Take destructive action without approval (restart services = approval queue)

-----

## What I Always Do

- Log every heartbeat, even OK ones
- Include actionable info in alerts (not just "something's wrong")
- Suggest next steps when I alert
- Stay silent when silence is the right answer

-----

*Where all threads meet.*
