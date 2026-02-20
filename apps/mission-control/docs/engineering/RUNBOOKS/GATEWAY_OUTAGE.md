# Runbook: Gateway Outage

## Purpose
Recover Mission Control when OpenClaw gateway connectivity is down or unstable.

## Signals
- `/api/openclaw/status` reports `connected: false`.
- UI header status remains `CONNECTING`/`DISCONNECTED`.
- Chat/task dispatch fails with gateway connection errors.

## Immediate actions
1. Verify gateway process is running and listening:
   - `lsof -iTCP:18789 -sTCP:LISTEN -n -P`
2. Verify Mission Control env:
   - `OPENCLAW_GATEWAY_URL`
   - `OPENCLAW_AUTH_TOKEN`
3. Check gateway logs and auth token validity.
4. Restart gateway service and recheck `/api/openclaw/status`.

## Mission Control validation
1. `curl -s http://127.0.0.1:3001/api/openclaw/status`
2. `curl -s http://127.0.0.1:3001/api/openclaw/connectivity`
3. Trigger a lightweight read path:
   - `curl -s http://127.0.0.1:3001/api/agents`

## Escalation
- If gateway remains down >15 minutes, switch to degraded mode messaging in UI and pause dispatch automation.

## Post-incident
1. Capture root cause in implementation log.
2. Add prevention action item in backlog.
