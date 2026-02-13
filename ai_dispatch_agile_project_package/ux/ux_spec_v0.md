# UX Spec (v0) — Dispatcher Cockpit + Tech Workflow

## 1) Dispatcher cockpit (minimum)
### Queue view
Columns:
- Priority (Emergency/Urgent/Routine)
- SLA countdown (time remaining)
- Ticket ID / Site
- Current state
- Assigned tech (if any)
- Last update time

Actions:
- Open details
- Assign / reassign
- Escalate
- Send message (template-based)

### Ticket detail panel
Tabs:
- Summary (incident type, risk flags, NTE, schedule)
- Timeline (audit events)
- Evidence (photos, docs)
- Messages (in/out)
- Approvals (pending/decisions)

Critical: show “why” for AI suggestions (skill match, distance, availability).

## 2) Tech mobile workflow (minimum)
- Job packet (address, contact, access instructions, photos, checklist)
- Check-in/out buttons
- Checklist with evidence prompts
- Upload photo (before/after) + notes
- Request change (NTE/proposal) with photo evidence
- Complete job (requires evidence refs + signature)

## 3) Human-in-the-loop affordances
- Approve/deny changes
- Override assignment
- Force emergency dispatch (requires reason + audit)

