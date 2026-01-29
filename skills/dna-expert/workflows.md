# Lobster Workflows & Cron Scheduling

## Lobster Overview

Lobster is DNA's deterministic workflow shell—a typed pipeline system that chains tools together with built-in approval gates. Unlike ad-hoc LLM planning, Lobster workflows are auditable, resumable, and safe.

## Enable Lobster

```json
{
  "tools": { "alsoAllow": ["lobster"] }
}
```

## Workflow Structure (.lobster YAML)

```yaml
name: inbox-triage
steps:
  - id: collect
    command: inbox list --json
    
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
    
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
    
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

## Step Properties

| Property | Description |
|----------|-------------|
| id | Unique step identifier |
| command | Command to execute |
| stdin | Input from previous step (`$stepId.stdout`) |
| approval | `required` to pause for approval |
| condition | Boolean expression to skip step |

## Approval Gates

When workflow hits an approval gate, it returns a `resumeToken`.

**Approve via:**

```json
{ "action": "resume", "token": "<resumeToken>", "approve": true }
```

**Reject via:**

```json
{ "action": "resume", "token": "<resumeToken>", "approve": false }
```

## Example Workflows

### Email Triage

```yaml
name: email-triage
steps:
  - id: fetch
    command: email list --unread --json
  - id: classify
    command: email classify --json
    stdin: $fetch.stdout
  - id: review
    command: email preview
    stdin: $classify.stdout
    approval: required
  - id: process
    command: email process
    stdin: $classify.stdout
    condition: $review.approved
```

### Inventory Check

```yaml
name: inventory-alert
steps:
  - id: check
    command: inventory list --low-stock --json
  - id: notify
    command: notify send --template=low-stock
    stdin: $check.stdout
    condition: $check.stdout != "[]"
```

## Cron Scheduling

Cron jobs run independently via Gateway scheduler.

### Add Cron Job

```bash
moltbot cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --deliver \
  --channel whatsapp \
  --to "+15551234567"
```

### Cron Parameters

| Parameter | Description |
|-----------|-------------|
| --name | Job identifier |
| --cron | Cron expression (standard format) |
| --tz | Timezone (IANA format) |
| --session | `isolated` (recommended) or `persistent` |
| --model | Override default model |
| --thinking | `off`, `low`, `medium`, `high` |
| --message | Task for agent |
| --deliver | Send response to channel |
| --channel | Target channel |
| --to | Recipient (phone, user ID) |

### Common Cron Patterns

```bash
# Daily morning briefing
moltbot cron add \
  --name "Daily briefing" \
  --cron "0 7 * * *" \
  --session isolated \
  --message "Summarize today's calendar and priorities."

# Weekly review (Monday 6 AM)
moltbot cron add \
  --name "Weekly review" \
  --cron "0 6 * * 1" \
  --session isolated \
  --model opus \
  --thinking high \
  --message "Generate weekly business review."

# Hourly inventory check
moltbot cron add \
  --name "Inventory check" \
  --cron "0 * * * *" \
  --session isolated \
  --message "Check for low stock items and alert if needed."

# End of day summary
moltbot cron add \
  --name "EOD summary" \
  --cron "0 18 * * 1-5" \
  --session isolated \
  --message "Summarize today's completed tasks and pending items."
```

### Manage Cron Jobs

```bash
# List jobs
moltbot cron list

# Remove job
moltbot cron remove --name "Morning status"

# View job details
moltbot cron show --name "Morning status"
```

### Session Isolation

**Always use `--session isolated` for cron jobs.**

Reasons:
- Prevents context buildup in main conversation
- Creates fresh sessions each run
- Avoids cross-contamination between scheduled tasks
- Ensures predictable behavior

### Cron Storage

Jobs stored in `~/.dna/cron/jobs.json`.

## Workflow Best Practices

1. **Use approval gates for destructive actions** — Deletions, payments, external communications
2. **Chain with conditions** — Skip steps when input is empty
3. **Isolate cron sessions** — Prevent context buildup
4. **Log outputs** — Include logging steps for audit trail
5. **Test manually first** — Run workflow steps interactively before scheduling
