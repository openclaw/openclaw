# Runbook: New Client Won

## Trigger
`deal.won` event (payment confirmed via Stripe)

## Automated Steps
1. GHL contact updated: tags `paid`, `won` added
2. GHL stage moved to `won` → `onboarding`
3. Trello board created with standard lists
4. Initial cards created in "Awaiting Details"
5. Designer assigned (based on workload rules)
6. PostHog event tracked
7. Welcome email/SMS sent via GHL workflow

## Manual Steps
1. Review client details in GHL
2. Schedule onboarding call if needed
3. Verify Trello board is correctly set up
4. Share resources list link with designer

## Failure Scenarios
| Issue | Resolution |
|-------|-----------|
| Trello board creation fails | Check Trello API key, retry manually |
| GHL update fails | Update contact manually, check API limits |
| Designer assignment empty | Assign manually, add designers to pool |
