# Runbook: Payment Failed

## Trigger
`payment.failed` event from Stripe webhook

## Automated Steps
1. GHL contact tagged with `payment_failed`
2. PostHog event tracked
3. (Optional) Retry notification sent to client

## Manual Steps
1. Review failed payment in Stripe dashboard
2. Contact client to resolve payment issue
3. Generate new checkout link if needed
4. Update GHL stage once resolved

## Common Failure Reasons
| Reason | Action |
|--------|--------|
| Card declined | Contact client, suggest different payment method |
| Expired card | Send new checkout link |
| Insufficient funds | Follow up in 2-3 days |
| Checkout session expired | Generate fresh checkout link |
| Fraud suspected | Review in Stripe, contact client if legitimate |
