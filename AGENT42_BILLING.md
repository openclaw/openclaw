# Agent42 Billing and Payout Setup Guide

## Billing setup
1. Review `agent42-subscriptions.json` for plan and seat limits.
2. Run `node scripts/agent42-subscriptions.mjs validate` before publishing changes.
3. Expose the selected plan id in your checkout workflow.

## Payout setup
1. Configure your payout account and tax profile with your payment provider.
2. Set an automated monthly payout schedule.
3. Reconcile successful charges against internal invoices.

## Operational checklist
- Keep plan pricing synchronized across product, billing, and analytics.
- Rotate API keys and audit webhook endpoints quarterly.
- Document payout incidents and resolution times.
