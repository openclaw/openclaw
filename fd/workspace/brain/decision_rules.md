# Decision Rules

Explicit rules the agent uses when making operational decisions.

---

## Scoring Framework

When evaluating an action or opportunity:

| Factor | Weight | Scoring |
|--------|--------|---------|
| Revenue impact | 3x | High=3, Medium=2, Low=1, None=0 |
| Effort required | 2x | Low=3, Medium=2, High=1 (inverted) |
| Scalability | 2x | High=3, Medium=2, Low=1 |
| Strategic alignment | 2x | High=3, Medium=2, Low=1 |
| Time sensitivity | 1x | Urgent=3, This week=2, Flexible=1 |
| Risk | 1x | Low=3, Medium=2, High=1 (inverted) |

Score = Sum of (factor * weight). Maximum possible: 33.

| Score range | Action |
|-------------|--------|
| 25-33 | Do immediately (within authority) |
| 18-24 | Prioritize this week |
| 11-17 | Add to backlog |
| 0-10 | Skip unless DA directs otherwise |

---

## Brand Selection Rules

| Situation | Rule |
|-----------|------|
| Brand explicitly mentioned | Use that brand |
| Brand inferable from context | Use inferred brand |
| User has a last-used brand in memory | Default to that |
| Brand is ambiguous and action is brand-sensitive | Ask the user |
| Brand doesn't matter (system health, etc.) | Proceed without |

---

## Approval Rules

| Action type | Approval needed? |
|-------------|-----------------|
| Read data, research, summarize | No |
| Draft content (internal) | No |
| Update task queue | No |
| System health check | No |
| Generate content for review | No |
| Send external message | Yes |
| Publish content | Yes |
| Spend money | Yes |
| Modify production systems | Yes |
| Delete data | Yes |
| Submit grant application | Yes |

---

## Workflow Selection Rules

| If the user asks about... | Route to... |
|--------------------------|-------------|
| Grants, funding, applications | `grantops` |
| Campaigns, ads, marketing, scale | `marketing_ops` |
| Content, captions, hooks, scripts | `content_generation` |
| Health, status, cluster, system | `system_health` |
| Today, priorities, focus, schedule | `daily_guidance` |
| Pipeline, leads, follow-ups, deals | `sales_ops` |
| Approve, deny, confirm, reject | `approvals` |
| Anything unclear | Ask for clarification |
