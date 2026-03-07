# Failure Recovery

What happens when things break, and how the system recovers.

---

## Failure Scenarios

### 1. Ollama goes down (M1)

**Symptoms:** Inference requests timeout or fail.

**Automatic response:**
- Circuit breaker trips after 4 consecutive failures
- Gateway redirects inference to M4 fallback (smaller models)
- Alert sent to DA via Telegram

**Manual recovery:**
```bash
make failover          # Activates M4 fallback
ssh claw-m1 "ollama serve &"  # Restart on M1
make warm-models       # Re-warm models
```

**Impact:** Degraded inference quality (4b max on M4 instead of 27b on M1).
Core functionality continues.

---

### 2. Gateway goes down (M4)

**Symptoms:** No prompt processing, webhooks rejected, channels disconnected.

**Automatic response:**
- i7 watchdog detects gateway absence within 15 minutes
- Alert sent to DA

**Manual recovery:**
```bash
ssh claw-m4 "make gateway-start"
make healthcheck
```

**Impact:** Critical — all prompt processing stops. Webhooks queue on
sender side. No automated actions.

**Escalation:** If M4 hardware fails, i7 can run a minimal read-only
gateway as temporary measure.

---

### 3. Worker goes down (M1/M4)

**Symptoms:** Jobs queue but don't execute. Renders and long tasks stall.

**Automatic response:**
- Job queue accumulates in `pending/` directory
- Healthcheck flags queue depth warning

**Manual recovery:**
```bash
make cluster-start  # Restart workers
```

**Impact:** Delayed execution. No data loss — jobs persist in the
file-based queue.

---

### 4. Database corruption (SQLite)

**Symptoms:** Audit, idempotency, or migration errors.

**Recovery:**
```bash
# Check integrity
sqlite3 data/openclaw.db "PRAGMA integrity_check"

# If corrupt, restore from backup
cp data/openclaw.db.bak data/openclaw.db
make db-status
```

**Prevention:** Regular backups via the maintenance schedule.

---

### 5. API key expiration / revocation

**Symptoms:** Integration calls return 401/403.

**Response:**
- Circuit breaker trips for the affected service
- Agent escalates to DA with the specific service and error

**Recovery:**
1. Generate new API key in the service dashboard
2. Update `.env` file
3. Restart affected services

---

### 6. Node becomes unreachable

**Symptoms:** SSH timeout, no response to healthcheck.

**Recovery checklist:**
1. Is it a network issue? (ping the node)
2. Is the machine powered on?
3. Is SSH running? (`ssh -v` for debug)
4. Can you access it physically?

**Failover:**
- M1 down → M4 takes inference with smaller models
- M4 down → i7 runs minimal read-only mode
- i7 down → System continues on M4+M1 (no monitoring)

---

## Circuit Breaker Policy

| Parameter | Value |
|-----------|-------|
| Failures before trip | 4 consecutive |
| Base backoff | 300 seconds (5 min) |
| Max backoff | 3600 seconds (1 hour) |
| Reset | Automatic after successful request |

---

## Escalation Matrix

| Severity | Response time | Action |
|----------|--------------|--------|
| Low | Within daily digest | Note in next summary |
| Medium | Within 1 hour | Telegram alert to DA |
| High | Immediate | Telegram alert + system safeguards |
| Critical | Immediate | Telegram alert + auto-failover + read-only mode |
