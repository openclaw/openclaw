# Onboarding Funnel Installer — Stripe → OS → Trello + Notion + GHL

## 0. Purpose

Implement a fully automated onboarding funnel triggered by Stripe payment:
- Move CRM status to onboarding
- Create/repair Notion client workspace from template
- Create Trello client board from template + webhooks + mappings
- Create internal mirrored work order card on internal board
- Insert dropbox master folder link into the reference card
- Create lifecycle card with welcome + pinned "Start here"
- Schedule reconcile jobs that keep templates healthy

## 1. Trigger

Stripe:
- payment_intent.succeeded
- invoice.paid (subscriptions)
- checkout.session.completed (if used)

## 2. Inputs (OfferIntent)

OfferIntent should include:
- offer_id (maps to templates + SOPs)
- ghl_contact_id (resolved via metadata)
- customer_email (fallback)
- expected deliverables template id
- trello_board_template_id
- notion_client_template_page_id

## 3. Outputs

- trello_board_id stored to GHL custom field
- trello_webhook_id stored to DB for lifecycle cleanup
- notion_client_page_id stored to DB
- internal mirror card created + linked
- lifecycle timeline started

## 4. Gating & Safe-mode

- SAFE_MODE=true default: create plan only (no external mutations)
- DRY_RUN=true default: print actions and store in scheduled_actions
- allow per-offer override for cleanup behavior:
  - TRELLO_CLOSE_BOARD_ON_CLEANUP=false default
  - soft cleanup: delete webhook, keep board open, move primary card to Archived list + label, write cleanup summary comment

## 5. Required GHL fields

- custom_field: trello_board_id
- custom_field: dropbox_master_folder_url
- custom_field: primary_offer_id
- custom_field: notion_client_page_id (optional)
- custom_field: manychat_contact_id (optional)

## 6. Failure handling

- idempotency keys per Stripe event
- reconcile job heals partial installs:
  - if board exists but webhook missing → recreate webhook
  - if reference card missing → recreate and re-insert markers
  - if archived list/label missing → create

## 7. Observability

- PostHog events: onboarding_started, trello_board_created, webhook_created, ghl_patched, notion_created
- Sentry spans: stripe_handler, trello_install, ghl_patch, notion_template_apply
