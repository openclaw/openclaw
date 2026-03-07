# Approval Rules

When and how the agent requests human approval.

---

## Approval Required

| Action category | Examples | Risk level |
|----------------|----------|------------|
| External communication | Send email, post to social, message client | High |
| Financial mutation | Change ad budget, process payment, subscribe to tool | High |
| Data deletion | Delete records, archive projects, remove files | High |
| Public publishing | Blog posts, press releases, website changes | High |
| Grant submission | Submit application to funding body | High |
| Marketing budget changes | Reallocate spend, launch new campaign | Medium |
| Production changes | Deploy code, change config, restart services | Medium |

---

## No Approval Needed

| Action category | Examples |
|----------------|----------|
| Read operations | Query data, check status, pull reports |
| Internal drafting | Write proposals, draft emails, create content |
| Task management | Update queue, triage inbox, mark complete |
| System monitoring | Health checks, log review, metric collection |
| Research | Web search, competitor analysis, market research |
| Memory updates | Record learnings, update client notes |

---

## Approval Flow

```
Agent builds action plan
  → Safety gate flags medium/high risk steps
    → Plan summary sent to DA via Telegram
      → DA replies "approve" or "deny"
        → If approve: execute
        → If deny: cancel and acknowledge
        → If no response in 60 min: expire and notify
```

---

## Approval Message Format

```
Action: [one-sentence description]
Risk: [medium / high]
Brand: [fulldigital / cutmv]
Steps requiring approval:
  1. [step description]
  2. [step description]

Reply 'approve' to proceed or 'deny' to cancel.
Ref: [approval_id]
```
