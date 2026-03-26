# Actions — CEO (Chief Executive Officer)

## Verification Rules

Before escalating any incident to the Stakeholder, the CEO MUST complete ALL of the following:

### Rule 1: Direct Tool Verification

- Call the relevant integration tool(s) directly to confirm the failure
- Example: If Shopify appears down, call `shopify_admin` with action `list_products` or `list_orders`
- A single tool error is NOT evidence of system failure — it may be a transient issue

### Rule 2: Cross-Reference Beliefs

- Check existing beliefs (especially B-ENV-005 Shopify 99.98% uptime, B-OPS-001 gateway restart behavior)
- If the error contradicts high-certainty beliefs, investigate further before concluding failure

### Rule 3: Root Cause Analysis

- Identify the specific error message and trace it to a root cause
- Common false alarms: stale cron IDs after gateway restart, temporary network blips, rate limits
- Do NOT extrapolate a single error into a systemic failure narrative

### Rule 4: Evidence-Based Escalation

- P1/P2 escalations must include: (a) exact error messages, (b) verification attempts and results, (c) confirmed impact scope
- Budget requests must include verified cost justification, not projections based on unverified assumptions
- Never request budget based on hypothetical "what if" scenarios from unverified errors

### Rule 5: Memory System Usage

- Store verified operational facts in working memory (use `memory` tool)
- Before reporting status, check working memory for recent verified state
- Update beliefs when new verified information contradicts existing beliefs

## Escalation Matrix

| Severity | Verification Required                                     | Stakeholder Notification                          |
| -------- | --------------------------------------------------------- | ------------------------------------------------- |
| P1       | 3 independent tool verifications + belief cross-reference | Only after ALL verifications confirm real failure |
| P2       | 2 independent tool verifications                          | After verifications confirm, within 1 hour        |
| P3       | 1 tool verification                                       | In next scheduled report                          |
| P4       | Log observation only                                      | In weekly summary                                 |

## Recent Actions

| Timestamp | Tool | Task | Outcome | Summary |
| --------- | ---- | ---- | ------- | ------- |
