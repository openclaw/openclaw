---
name: harvest
description: Track time, manage projects, and handle invoicing with Harvest time tracking API.
homepage: https://help.getharvest.com/api-v2/
metadata:
  {
    "openclaw":
      {
        "emoji": "🌾",
        "requires": { "bins": ["jq"], "env": ["HARVEST_ACCOUNT_ID", "HARVEST_ACCESS_TOKEN"] },
      },
  }
---

# Harvest Time Tracking Skill

Manage time entries, projects, invoices, and reporting with Harvest.

## Setup

1. Get your Harvest Account ID from your account settings
2. Create a Personal Access Token at https://id.getharvest.com/developers
3. Set environment variables:
   ```bash
   export HARVEST_ACCOUNT_ID="your-account-id"
   export HARVEST_ACCESS_TOKEN="your-access-token"
   ```

## API Helpers

All requests require these headers:

```bash
HARVEST_HEADERS="Authorization: Bearer $HARVEST_ACCESS_TOKEN
Harvest-Account-ID: $HARVEST_ACCOUNT_ID
User-Agent: OpenClaw Harvest Integration"
```

## Time Entry Management

### List today's time entries

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/time_entries?from=$(date +%Y-%m-%d)&to=$(date +%Y-%m-%d)" | \
  jq '.time_entries[] | {id, project: .project.name, task: .task.name, hours, notes}'
```

### Create a time entry

```bash
curl -s -X POST -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/time_entries" \
  -d '{
    "project_id": PROJECT_ID,
    "task_id": TASK_ID,
    "spent_date": "'$(date +%Y-%m-%d)'",
    "hours": HOURS,
    "notes": "Description of work"
  }' | jq
```

### Update a time entry

```bash
curl -s -X PATCH -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/time_entries/{time_entry_id}" \
  -d '{
    "hours": NEW_HOURS,
    "notes": "Updated description"
  }' | jq
```

### Delete a time entry

```bash
curl -s -X DELETE -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/time_entries/{time_entry_id}"
```

### Start/Stop a timer

Start a timer:

```bash
curl -s -X POST -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/time_entries" \
  -d '{
    "project_id": PROJECT_ID,
    "task_id": TASK_ID,
    "spent_date": "'$(date +%Y-%m-%d)'",
    "notes": "Working on task"
  }' | jq
```

Stop a running timer:

```bash
curl -s -X PATCH -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/time_entries/{time_entry_id}/stop" | jq
```

Restart a stopped timer:

```bash
curl -s -X PATCH -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/time_entries/{time_entry_id}/restart" | jq
```

## Project Management

### List all projects

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/projects?is_active=true" | \
  jq '.projects[] | {id, name, client: .client.name, budget}'
```

### Get project details with tasks

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/projects/{project_id}" | jq
```

### List tasks for a project

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/projects/{project_id}/task_assignments" | \
  jq '.task_assignments[] | {task_id: .task.id, task_name: .task.name, billable: .billable}'
```

## Reporting

### Time report by project (current month)

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/reports/time/projects?from=$(date -v1d +%Y-%m-%d)&to=$(date +%Y-%m-%d)" | \
  jq '.results[] | {project_id, client_name, project_name, total_hours}'
```

### Time report by user (date range)

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/reports/time/team?from=2024-01-01&to=2024-01-31" | \
  jq '.results[] | {user_id, user_name, total_hours, billable_hours}'
```

### Expense report

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/reports/expenses/projects?from=2024-01-01&to=2024-01-31" | \
  jq '.results[] | {project_name, total_amount, currency}'
```

### Uninvoiced time and expenses

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/reports/uninvoiced?from=2024-01-01&to=2024-01-31" | \
  jq '{total_hours, total_amount, currency}'
```

## Invoice Management

### List invoices

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/invoices" | \
  jq '.invoices[] | {id, number, client: .client.name, amount, state, due_date}'
```

### Get invoice details

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/invoices/{invoice_id}" | jq
```

### Create an invoice from uninvoiced time

```bash
curl -s -X POST -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/invoices" \
  -d '{
    "client_id": CLIENT_ID,
    "subject": "Invoice Subject",
    "notes": "Thank you for your business",
    "currency": "USD",
    "issue_date": "'$(date +%Y-%m-%d)'",
    "due_date": "'$(date -v+30d +%Y-%m-%d)'",
    "payment_term": "net 30"
  }' | jq
```

### Update invoice

```bash
curl -s -X PATCH -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/invoices/{invoice_id}" \
  -d '{
    "notes": "Updated notes",
    "due_date": "2024-02-15"
  }' | jq
```

### Send invoice to client

```bash
curl -s -X POST -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/invoices/{invoice_id}/messages" \
  -d '{
    "recipients": [
      {"name": "Client Name", "email": "client@example.com"}
    ],
    "subject": "Invoice #{invoice_number}",
    "body": "Please find your invoice attached."
  }' | jq
```

### Mark invoice as sent/paid/closed

```bash
# Mark as sent
curl -s -X PATCH -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/invoices/{invoice_id}" \
  -d '{"event_type": "send"}' | jq

# Mark as paid
curl -s -X POST -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/invoices/{invoice_id}/payments" \
  -d '{
    "amount": AMOUNT,
    "paid_at": "'$(date +%Y-%m-%d)'"
  }' | jq

# Close invoice
curl -s -X PATCH -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/invoices/{invoice_id}" \
  -d '{"event_type": "close"}' | jq
```

## Client Management

### List clients

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/clients?is_active=true" | \
  jq '.clients[] | {id, name, currency}'
```

### Get client details

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/clients/{client_id}" | jq
```

## User Information

### Get current user

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/users/me" | \
  jq '{id, first_name, last_name, email, timezone}'
```

### List all users

```bash
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/users?is_active=true" | \
  jq '.users[] | {id, name: (.first_name + " " + .last_name), email}'
```

## Common Workflows

### Quick time entry for today

```bash
# 1. List projects to get IDs
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/projects?is_active=true" | \
  jq '.projects[] | {id, name}'

# 2. Get tasks for selected project
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/projects/{project_id}/task_assignments" | \
  jq '.task_assignments[] | {task_id: .task.id, task_name: .task.name}'

# 3. Create time entry
curl -s -X POST -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/time_entries" \
  -d '{
    "project_id": PROJECT_ID,
    "task_id": TASK_ID,
    "spent_date": "'$(date +%Y-%m-%d)'",
    "hours": 2.5,
    "notes": "Work description"
  }' | jq
```

### Generate invoice from time entries

```bash
# 1. Check uninvoiced time for a client
curl -s -H "$HARVEST_HEADERS" \
  "https://api.harvestapp.com/v2/reports/uninvoiced?from=2024-01-01&to=$(date +%Y-%m-%d)" | jq

# 2. Create invoice
curl -s -X POST -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/invoices" \
  -d '{
    "client_id": CLIENT_ID,
    "subject": "Monthly Services",
    "issue_date": "'$(date +%Y-%m-%d)'",
    "due_date": "'$(date -v+30d +%Y-%m-%d)'"
  }' | jq '.id'

# 3. Send invoice to client
curl -s -X POST -H "$HARVEST_HEADERS" \
  -H "Content-Type: application/json" \
  "https://api.harvestapp.com/v2/invoices/{invoice_id}/messages" \
  -d '{
    "recipients": [{"email": "client@example.com"}]
  }' | jq
```

## Notes

- API rate limit: 100 requests per 15 seconds per access token
- All timestamps are in ISO 8601 format
- Date format: YYYY-MM-DD
- The API uses pagination for large result sets (check `next_page` and `previous_page` in responses)
- Keep your access token secure - it provides full access to your Harvest account
- Personal Access Tokens don't expire but can be revoked at https://id.getharvest.com/developers

## Tips

- Use `jq` to parse and filter JSON responses
- Store frequently used project/task IDs in environment variables
- For date calculations, use `date` command with format strings
- Running timers will have `is_running: true` in the response
- Only one timer can run at a time per user
