# Runbook: Automation Down

## Detection
- Sentry alert fires for service errors
- Health check endpoint returns non-200
- Webhook delivery failures accumulate

## Diagnosis Steps
1. Check service health: `curl http://localhost:8000/health`
2. Check logs: `docker compose logs gateway --tail=100`
3. Check Sentry for error details
4. Verify external API connectivity (GHL, Trello, Stripe, ManyChat)

## Common Issues

### Gateway not responding
```bash
docker compose restart gateway
# Check: curl http://localhost:8000/health
```

### Orchestrator handler errors
```bash
docker compose logs orchestrator --tail=100
# Look for handler_error entries
```

### Worker jobs stuck
```bash
# Check queue status
sqlite3 data/jobs.db "SELECT status, COUNT(*) FROM jobs GROUP BY status"
```

### External API rate limited
- Check response headers for rate limit info
- Tenacity retry handles most transient failures
- If persistent, check API key/account status

## Escalation
- If service won't restart: check Docker, disk space, memory
- If external API is down: monitor their status page
- If data integrity issue: stop all services, investigate, recover from event log
