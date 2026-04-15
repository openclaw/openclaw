---
title: "Postmortem Template"
summary: "Standard postmortem format for S1 and S2 incidents"
read_when:
  - Writing a postmortem after an S1 or S2 incident
  - Reviewing a previous incident for prevention patterns
---

# Postmortem Template

Use this template for every S1 incident and recommended for S2.
Postmortems are blameless — the goal is to improve the system, not assign fault.
File the document in GitHub Discussions (category: Postmortems) or the private maintainer docs.

---

## Incident: \<Short title\>

**Incident ID:** INC-YYYY-NNN (sequential)
**Date:** YYYY-MM-DD
**Severity:** S1 / S2
**Duration:** HH:MM (from first alert to full resolution)
**On-call owner:** @github-handle
**Incident commander:** @github-handle (if different)
**Participants:** @handle1, @handle2, ...

---

## Summary

One paragraph describing what happened, who was affected, and the business impact.

---

## Timeline

Use UTC timestamps. Be factual and concise.

| Time (UTC) | Event |
|---|---|
| HH:MM | First alert or user report |
| HH:MM | On-call acknowledged |
| HH:MM | Root cause identified |
| HH:MM | Mitigation applied |
| HH:MM | Full resolution confirmed |

---

## Root cause

Describe the technical root cause in enough detail that a new engineer can understand it.
Avoid blame language. If the cause was a combination of factors, list all of them.

- **Primary cause:**
- **Contributing factors:**
- **Why it was not caught earlier:**

---

## Detection

- How was the incident first detected? (alert, user report, log review, health check)
- How long between the start of impact and detection?
- Was existing monitoring sufficient? If not, what was missing?

---

## Response

- Were runbooks followed? Which ones?
- Was the runbook accurate and complete? If not, what needs to change?
- Were escalation paths clear?
- What would have reduced the time to resolution?

---

## Impact

- Users/channels affected:
- Duration of impact:
- Data loss or corruption: Yes / No — details:
- Security impact: Yes / No — details:
- Release blocked: Yes / No

---

## Resolution

What was done to resolve the incident?

---

## Action items

Each action item must have an owner and a target date. Track these as GitHub issues.

| Action | Owner | Target date | GitHub issue |
|---|---|---|---|
| Fix root cause | @handle | YYYY-MM-DD | #NNN |
| Add missing monitoring | @handle | YYYY-MM-DD | #NNN |
| Update runbook RB-XX | @handle | YYYY-MM-DD | #NNN |
| Add regression test | @handle | YYYY-MM-DD | #NNN |

---

## Prevention

What systemic changes would prevent this class of incident?

- **Short term (within 1 release):**
- **Medium term (within 1 month):**
- **Long term (architectural):**

---

## Lessons learned

What did the team learn? What went well that should be reinforced?

- What went well:
- What could be improved:
- New knowledge:
