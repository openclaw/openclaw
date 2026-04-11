---
name: email-triage
description: "Triage multi-account email via AI-powered sync, priority filtering, and pending-attention tracking. Trigger when asked to check, sync, or dismiss emails."
metadata: { "openclaw": { "emoji": "📧", "requires": { "bins": ["python3"] } } }
---

# Email Triage

Sync multi-account emails, filter high-priority items, and manage a pending-attention queue.

## Prerequisites

1. The `email-ingest-integration` project must be set up at the path in `EMAIL_TRIAGE_WORKSPACE` (defaults to `~/.openclaw/workspace/email-ingest-integration`). Requires upstream revision with [Anthrop-OS/email-ingest#18](https://github.com/Anthrop-OS/email-ingest/pull/18) (`main.py status` subcommand) — the skill shells out to that to detect first-run state and no longer opens the upstream SQLite file directly.
2. A Python virtualenv with dependencies must exist at `<workspace>/venv`, or set `EMAIL_TRIAGE_VENV_PYTHON` to point at an alternative interpreter.
3. Credentials configured in `<workspace>/.env`.

## Commands

### Sync emails

```bash
python3 {baseDir}/scripts/triage.py sync
```

Ingests new emails from all configured accounts. On first run (empty database), automatically fetches from yesterday onward. After ingestion, queries for new emails and adds them to the pending-attention list. Outputs a JSON-formatted status summary.

### List pending emails

```bash
python3 {baseDir}/scripts/triage.py pending
```

Prints all pending high-priority emails as JSON (priority >= High, i.e. High/Urgent/Critical). Each entry includes `id`, `subject`, `sender`, `summary`, and `status`. Numeric priorities are also supported (>= 3).

### Dismiss an email

```bash
python3 {baseDir}/scripts/triage.py dismiss <email_id>
```

Removes the specified email from the pending-attention queue by ID.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `EMAIL_TRIAGE_WORKSPACE` | `~/.openclaw/workspace/email-ingest-integration` | Path to the email-ingest-integration project |
| `EMAIL_TRIAGE_STATE` | `~/.openclaw/workspace/memory/email_triage_state.json` | Path to the state file |
| `EMAIL_TRIAGE_VENV_PYTHON` | `$EMAIL_TRIAGE_WORKSPACE/venv/bin/python3` | Python interpreter used to invoke the ingest CLI. Override this on Windows (`venv/Scripts/python.exe`) or in CI/test environments that do not have a real venv. |

## State

State is stored at the path configured by `EMAIL_TRIAGE_STATE`:

```json
{
  "cursor": { "last_ingested_id": 123 },
  "pending_attention": [
    { "id": 124, "subject": "...", "sender": "...", "priority": "High", "summary": "...", "status": "pending" }
  ]
}
```

## Notes

- Run `sync` periodically (every 4 hours recommended via OpenClaw Cron).
- Dismissed items are permanently removed from the pending list.
