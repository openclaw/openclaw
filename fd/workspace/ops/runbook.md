# Runbook

How to start, stop, inspect, and recover the OpenClaw system.

---

## Startup Sequence

```bash
# 1. Start Ollama on M1 (or M4 fallback)
ssh claw-m1 "ollama serve &"

# 2. Warm models
make warm-models

# 3. Start the gateway on M4
make gateway-start

# 4. Start application services
make cluster-start

# 5. Verify everything is healthy
make healthcheck
```

Or use the boot script:

```bash
openclaw/scripts/boot.sh
```

---

## Shutdown

```bash
# Graceful shutdown
make cluster-stop
make gateway-stop

# Emergency stop (kills everything)
ssh claw-m4 "tmux kill-session -t openclaw"
ssh claw-m1 "tmux kill-session -t openclaw"
```

---

## Health Check

```bash
make healthcheck
```

Checks:
- Gateway responding on port 18789
- Ollama responding on port 11434
- Webhook gateway responding on port 8000
- Orchestrator responding on port 8001
- Worker responding on port 8002
- All cluster nodes reachable via SSH

---

## Common Issues

### Ollama not responding

```bash
# Check if process is running
ssh claw-m1 "pgrep ollama"

# Restart
ssh claw-m1 "killall ollama; sleep 2; ollama serve &"

# If M1 is down entirely, failover to M4
make failover
```

### Gateway won't start

```bash
# Check port conflict
lsof -i :18789

# Check config validity
cat gateway/openclaw.json5 | python -c "import sys,json; json.load(sys.stdin)"

# Check logs
tail -100 ~/openclaw/logs/gateway.log
```

### Webhook delivery failures

1. Check `WEBHOOK_SHARED_SECRET` matches sender config
2. Verify the endpoint is reachable: `curl http://localhost:8000/health`
3. Check idempotency store for duplicate rejections
4. Review audit log for recent webhook activity

---

## Useful Commands

| Command | Purpose |
|---------|---------|
| `make healthcheck` | Full cluster health check |
| `make cluster-status` | Service status on all nodes |
| `make cluster-logs` | Tail logs from all nodes |
| `make warm-models` | Pre-load Ollama models into memory |
| `make failover` | Switch inference to backup node |
| `make db-status` | Check database migration status |
