# Logs

Agent activity logs and error records.

---

## Log Files

| File | Content | Format |
|------|---------|--------|
| `agent_activity.log` | All agent actions, decisions, and responses | JSON lines |
| `errors.log` | Errors, failures, and escalations | JSON lines |

These files are generated at runtime and ignored by git (see `.gitignore`).

---

## Log Format

Each log entry is a JSON object:

```json
{
  "level": "INFO",
  "logger": "openclaw.prompt_engine.engine",
  "msg": "plan_built",
  "extra": {
    "workflow": "grantops",
    "steps": 3,
    "goal": "Find and surface the best grant opportunities."
  }
}
```

Secrets are automatically redacted by `packages/common/logging.py`.

---

## Retention Policy

| Age | Action |
|-----|--------|
| 0-7 days | Retain in full |
| 7-30 days | Compressed (gzip) |
| 30+ days | Deleted during weekly rotation |

Log rotation runs every Sunday at 2:00 AM via the i7 sentinel node.

---

## Viewing Logs

```bash
# Tail recent activity
tail -f openclaw/logs/agent_activity.log | python -m json.tool

# Search for errors
grep '"level": "ERROR"' openclaw/logs/agent_activity.log

# View cluster logs
make cluster-logs
```
