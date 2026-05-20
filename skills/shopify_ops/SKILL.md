---
name: shopify_ops
description: Safe Shopify in-person inventory workflow with dry-run previews, explicit idempotent apply, and compare-and-swap quantity checks.
metadata:
  {
    "openclaw":
      {
        "emoji": "🛍️",
        "requires":
          {
            "config":
              [
                "plugins.entries.shopify.enabled",
                "plugins.entries.shopify.config.storeDomain",
                "plugins.entries.shopify.config.locationId",
                "plugins.entries.shopify.config.auth.mode",
              ],
          },
      },
  }
---

# Shopify Ops

Use this skill for in-person sales inventory adjustments, inventory lookup questions, and drop staging prep on Shopify.
Do not use it for bulk publish workflows yet.

## Command grammar

Accepted sold commands:

- `sold sku:HD-BLK-L qty:1`
- `sold barcode:123456 qty:2`
- `sold "HD-BLK-L" 1`

Accepted inventory lookup asks:

- `how many black ones we got`
- `inventory for sku:HD-BLK-L`
- `stock barcode:123456`
- `what is in stock for "black"`

Parsing rules:

- Quantity must be a positive integer.
- Convert sold quantity into `delta = -qty`.
- Selector priority: `sku:` then `barcode:` then free text.

## Required tool flow

1. Parse the sold command.
2. Call `shopify_variant_search`:
   - If selector is SKU: `{ sku, limit: 5 }`
   - If selector is barcode: `{ barcode, limit: 5 }`
   - If selector is free text: `{ text, limit: 10 }`
3. If no matches: stop and return a helpful correction prompt.
4. If more than one match and selector was free text:
   - Return a numbered list from `matches`.
   - Ask user to choose exact `variantId`.
   - Do not preview/apply yet.
5. If exactly one actionable match, call `shopify_inventory_preview` with `{ variantId, delta }`.
6. Present preview clearly:
   - Variant + location
   - `before -> after`
   - `idempotencyKey`
   - `expectedQuantity` (must be reused on apply)
   - Explicit note: this is a dry run.
7. Apply only when the user explicitly confirms with that key (for example `apply <idempotencyKey>`):
   - Call `shopify_inventory_apply` with the same `{ variantId, delta, idempotencyKey, expectedQuantity }`.

## Inventory lookup flow (read-only)

1. If the user asks inventory/stock/quantity without an explicit sold/apply command:
   - Extract selector from `sku:`, `barcode:`, or free text.
2. Call `shopify_variant_search` with the selector:
   - SKU: `{ sku, limit: 10 }`
   - Barcode: `{ barcode, limit: 10 }`
   - Free text: `{ text, limit: 20 }`
3. Return actual results from Shopify only:
   - For each match: `displayName` and `availableQty`
   - If multiple matches, include a compact total sum of `availableQty`.
4. If no matches, say no matches were found.
5. Do not call preview/apply for pure inventory lookup asks.

## Guardrails

- Default posture is dry-run first. Never auto-apply.
- Preview is read-only and must never mutate inventory.
- Require explicit user confirmation before calling `shopify_inventory_apply`.
- `idempotencyKey` is required; missing or blank key is a hard stop.
- Preserve the exact `idempotencyKey` and `expectedQuantity` from preview to apply.
- If apply returns `EXPECTED_QUANTITY_MISMATCH`, stop and ask for a fresh preview.
- If `tracked=false`, treat as non-actionable and stop.
- If `after < 0`, stop and report oversell prevention.
- If Shopify returns `userErrors`, show them and do not retry automatically.
- Never claim permissions or scope restrictions unless a current tool call actually returned that error in this turn.
- Never answer inventory quantity questions from memory; always run a fresh `shopify_variant_search` first.

## Auth preflight

- `auth.mode=token`: plugin uses `auth.adminToken`.
- `auth.mode=oauth`: plugin fetches/uses OAuth access token before Shopify API calls.

## Stage drop status

- `shopify_stage_drop` is scaffold-only (no side effects).
- Use it only to report TODOs/planning state until publish-safe tooling is implemented.

## Operator handoff

- For restart + verification + Telegram-safe execution steps, follow `RUNBOOK.md` section: `Shopify Inventory Workflow (Telegram + OpenClaw)`.
