---
summary: "Starter playbook for scout agents, warm-lead scoring, and human handoff"
title: "Lead machine playbook"
---

# Lead machine playbook

This playbook helps you run a lightweight scout + gatekeeper workflow and only escalate warm leads to a human.

## Roles

## Scout workers
- Monitor target channels/communities
- Engage with useful, non-spam responses
- Capture lead context in structured notes

## Gatekeeper (orchestrator)
- Reviews scout summaries
- Scores lead intent
- Escalates only high-intent leads

## Human closer
- Handles final conversation/demo/booking
- Can pause automation for a lead

## Warm-lead scoring rubric (0–10)

- Problem clarity (0–2)
- Budget/authority signal (0–2)
- Timeline urgency (0–2)
- Response engagement (0–2)
- Fit with offer/persona (0–2)

Suggested threshold:
- **0–4:** cold
- **5–7:** monitor/nurture
- **8–10:** escalate to human

## Escalation template (Telegram/DM)

```md
Lead alert: WARM (score: 8/10)
Source: <channel/thread>
Summary: <2-3 lines>
Signals: <budget/timeline/problem>
Suggested action: <dm / call / demo>
```

## Pause/resume control per lead

- `pause <lead-id>`: scout stops engagement for that lead
- `resume <lead-id>`: scout resumes monitoring/engagement
- Always pause when human takes direct ownership

## Safety and compliance

- Do not impersonate real individuals
- Avoid deceptive claims
- Respect platform terms and anti-spam rules
- Keep approvals for high-risk or public actions

## Starter implementation pattern

1. Scout captures opportunities
2. Gatekeeper scores leads
3. Gatekeeper escalates only warm leads
4. Human closes
5. Outcome logged for rubric tuning
