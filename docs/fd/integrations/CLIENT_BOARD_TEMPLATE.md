# Client Board Template

## Purpose

Define the structure for auto-creating client boards programmatically.

Used when:

- Stripe payment completes (`checkout.session.completed`)
- OfferIntent resolves
- Manual provisioning via ops endpoint

## Board Naming Convention

```
{Client Name} – Full Digital
```

## Lists To Create (in order)

1. `Inbox / Awaiting Details`
2. `In Progress`
3. `Needs Review / Feedback`
4. `Approved / Ready for Delivery`
5. `Published / Delivered`
6. `Reference & Links`

## Default Cards

### Reference & Links list

Create these starter cards:

- `Welcome / Onboarding`
- `Dropbox Folder`
- `Brand Guidelines`
- `Logos / Fonts`
- `Release Dates`
- `Deadlines`

### Inbox / Awaiting Details list

- `Client Intake / Required Details` (primary card for timeline logging)

### In Progress list

- `Production Task(s)`

## Permissions

- Client added as board member
- Internal automation account must be board admin
- Designers are NOT auto-added (assignment is label-based, not member-based)

## Webhook Setup

Immediately after board creation:

1. Create Trello webhook pointing to `/webhooks/trello?secret={TRELLO_WEBHOOK_SECRET}`
2. Store `webhook_id` in `trello_webhooks` table
3. Persist `board_id` in GHL contact custom field (`TrelloBoardId`)
4. Persist `primary_card_id` in GHL contact custom field (`TrelloPrimaryCardId`)

## Safety Mode

If `DRY_RUN=true`:

- Simulate board creation
- Log intended list structure via audit
- Do not create webhook
- Status set to `dry_run_logged`

## Related Files

| What | Where |
|------|-------|
| Board provisioning | `packages/domain/fulfillment.py` |
| Standard lists | `packages/integrations/trello/client.py` (`standard_lists()`) |
| Contact mapping | `packages/domain/contact_map.py` |
| Webhook registry | `packages/common/db.py` (`trello_webhooks` table) |
| Stripe trigger | `services/webhook_gateway/routes/stripe.py` |
