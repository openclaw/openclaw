# HEARTBEAT.md - 만덕이 Periodic Tasks

> AFO Kingdom Integration Heartbeat

## Periodic Checks

### Every 5 Minutes

- [ ] Check gateway health: `openclaw channels status --probe`
- [ ] Verify Telegram bot connection

### Every 15 Minutes

- [ ] Sync with AFO Kingdom Trinity Score
- [ ] Check pending Commander messages
- [ ] Review unread notifications

### Every Hour

- [ ] Report system metrics to Kingdom dashboard
- [ ] Clean stale sessions
- [ ] Backup conversation logs

### Daily (8:00 AM)

- [ ] Generate daily summary for Commander
- [ ] Check for OpenClaw updates
- [ ] Rotate logs

## AFO Kingdom Integration Tasks

```bash
# Health check
python ~/AFO_Kingdom/scripts/comprehensive_health_check.py

# Trinity Score sync
curl -s http://localhost:8010/api/trinity/current | jq .score

# Channel status
openclaw channels status --all
```

## Alerting Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Gateway response time | > 2s | > 5s |
| Message queue depth | > 50 | > 100 |
| Memory usage | > 80% | > 95% |
| Telegram API errors | > 5/min | > 20/min |

## On Alert

1. Log to `~/.openclaw/alerts/`
2. Notify Commander via Telegram
3. Escalate to AFO Kingdom if critical
