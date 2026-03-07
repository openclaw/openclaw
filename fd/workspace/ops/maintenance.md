# Maintenance

Regular maintenance tasks, schedules, and procedures.

---

## Scheduled Maintenance

| Task | Frequency | Node | Script |
|------|-----------|------|--------|
| Log rotation | Weekly (Sun 2 AM) | i7 | `scripts/rotate-logs.sh` |
| Memory sync | Every 30 min | i7 | `scripts/sync-memory.sh` |
| Model warmup | Daily (5 AM) | M1 | `scripts/warm-models.sh` |
| Database backup | Daily (3 AM) | M4 | `scripts/backup-db.sh` |
| Health check | Every 15 min | i7 | `scripts/healthcheck.sh` |

---

## Updates

### Application code

```bash
make cluster-update  # git pull + migrate on all nodes
```

### Ollama models

```bash
ssh claw-m1 "ollama pull qwen3.5:9b"
make warm-models
```

### System packages

Update each node individually. Avoid updating all nodes simultaneously —
keep at least one node running at all times.

---

## Backups

### What to back up

| Data | Location | Frequency |
|------|----------|-----------|
| SQLite database | `data/openclaw.db` | Daily |
| Memory files | `openclaw/memory/` | Every 30 min (sync) |
| Bank files | `openclaw/bank/` | Every 30 min (sync) |
| Task files | `openclaw/tasks/` | Every 30 min (sync) |
| Config files | `openclaw/config/` | On change |
| Environment | `.env` | On change (manual) |

### What NOT to back up

- Logs (rotated and compressed, not backed up long-term)
- Cache files
- `__pycache__/` directories
- `.venv/` directories

---

## Key Rotation

API keys and tokens should be rotated on this schedule:

| Secret | Rotation | Procedure |
|--------|----------|-----------|
| Telegram bot token | Annually | Regenerate in BotFather |
| GHL API key | Annually | Regenerate in GHL dashboard |
| Stripe keys | Annually | Roll in Stripe dashboard |
| Webhook secrets | Quarterly | Update in `.env` + sender config |
| Anthropic API key | Annually | Regenerate in Anthropic console |

After rotation:
1. Update `.env`
2. Restart affected services
3. Verify with healthcheck

---

## Pruning

### Task ledger

Move tasks older than 90 days from `tasks/completed.md` to an archive
file (`tasks/archive/YYYY-Q{n}.md`).

### Logs

Logs older than 30 days are automatically deleted during rotation.

### Memory

Review `memory/memory.md` quarterly. Remove outdated entries.
Move validated patterns to permanent knowledge.
