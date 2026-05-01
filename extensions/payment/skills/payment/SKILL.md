---
name: payment
description: Use when making a purchase with the payment plugin — virtual card checkout via browser or machine payment to an HTTP 402 endpoint. Covers the full agentic purchase workflow including sentinel fill, approval handling, 3DS retry, and card expiry recovery.
user-invocable: false
---

# Payment

Use this skill when you need to make a purchase using the OpenClaw payment plugin. Two paths exist:

- **Virtual card checkout** — issue a single-use card, fill a browser form using sentinels, submit the checkout.
- **Machine payment** — call an HTTP 402 endpoint directly using `execute_machine_payment`. No browser required.

Always check setup and list funding sources before attempting a purchase.

## Step 1 — Verify setup

```json
{ "action": "setup_status" }
```

If `available` is `false`, report the `reason` to the user and stop. Do not attempt a purchase with an unavailable provider.

## Step 2 — List funding sources

```json
{ "action": "list_funding_sources" }
```

Pick an appropriate funding source whose `rails` array includes `virtual_card` (for browser checkout) or `machine_payment` (for HTTP 402 endpoints). Record the `id` — you will need it in every subsequent action.

## Step 3A — Virtual card checkout

### Issue the card

Call `payment.issue_virtual_card` with a `purchaseIntent` of at least 100 characters. The intent text is shown to the user during the Stripe Link approval prompt on their phone — be specific about what is being purchased and why.

```json
{
  "action": "issue_virtual_card",
  "providerId": "stripe-link",
  "fundingSourceId": "<id from step 2>",
  "amount": { "amountCents": 2999, "currency": "usd" },
  "merchant": {
    "name": "Example Store",
    "url": "https://example.com"
  },
  "purchaseIntent": "Purchasing a blue widget (SKU W-123) from example.com for $29.99. The user asked to buy this item as part of their home office setup order placed on 2026-04-30."
}
```

This action requires **warning-severity approval** in the OpenClaw approval surface, followed by a **biometric approval** (Face ID or passkey) on the user's Link mobile app. The tool call will block until both approvals resolve. Do not attempt to poll or retry while the call is pending.

On success, the result contains:

- `handle.id` — record this; you need it for fill and status checks.
- `handle.validUntil` — the card expires at this timestamp.
- `handle.display` — non-secret display info (`brand`, `last4`, `expMonth`, `expYear`).
- `fillSentinels` — a map with keys `pan`, `cvv`, `exp_month`, `exp_year`, `holder_name`. Each value is a sentinel object `{ "$paymentHandle": "<id>", "field": "<name>" }`.

If `handle.status` is `denied`, tell the user their approval was denied and stop. Do not retry `issue_virtual_card` without user instruction.

### Open the merchant checkout

Use the `browser` tool to navigate to the merchant's checkout or payment page. Take a snapshot to identify the card form fields.

```json
{ "action": "open", "url": "https://example.com/checkout", "label": "checkout" }
```

```json
{ "action": "snapshot", "targetId": "checkout" }
```

### Fill the form with sentinels

Pass the sentinel objects as field values in a `browser.act fill` call. Do not look up or substitute the real card values yourself — the payment plugin's hook handles substitution automatically.

```json
{
  "action": "act",
  "request": {
    "kind": "fill",
    "targetId": "checkout",
    "fields": [
      {
        "ref": "<pan field ref>",
        "type": "text",
        "value": { "$paymentHandle": "<handle.id>", "field": "pan" }
      },
      {
        "ref": "<cvv field ref>",
        "type": "text",
        "value": { "$paymentHandle": "<handle.id>", "field": "cvv" }
      },
      {
        "ref": "<exp_month field ref>",
        "type": "text",
        "value": { "$paymentHandle": "<handle.id>", "field": "exp_month" }
      },
      {
        "ref": "<exp_year field ref>",
        "type": "text",
        "value": { "$paymentHandle": "<handle.id>", "field": "exp_year" }
      },
      {
        "ref": "<holder_name field ref>",
        "type": "text",
        "value": { "$paymentHandle": "<handle.id>", "field": "holder_name" }
      }
    ]
  }
}
```

This call triggers a **critical-severity approval** for the sentinel substitution. On approval, the payment plugin substitutes real card values inside the runtime — those values are typed into the browser form but never appear in your transcript or the agent's view of the parameters.

### Submit the form

After a successful fill approval, submit the form:

```json
{
  "action": "act",
  "request": { "kind": "click", "ref": "<submit button ref>", "targetId": "checkout" }
}
```

Take a snapshot to confirm the checkout succeeded.

### Handle failures and retry

If the checkout fails (3DS challenge, network error, form validation error, browser timeout):

1. Do NOT issue a new virtual card immediately.
2. Re-snapshot the checkout page to understand the current state.
3. If a 3DS challenge appeared, wait for the user to complete it (or dismiss it), then retry the fill on the same handle. Each retry fill requires a new critical-severity approval.
4. If the page shows a card decline or a permanent error, use `payment.get_payment_status` to check the handle status before deciding.
5. If `get_payment_status` returns `{ status: "approved" }` and `validUntil` is in the future, the card is still usable — retry the fill.
6. If `get_payment_status` returns `{ status: "expired" }` or the fill hook returns a `card_unavailable` error, the card has been consumed or has expired. Issue a new virtual card (back to Step 3A) and inform the user that a new approval is needed.

**EU/PSD2 note:** 3DS challenges are expected for European-issued cards and many European merchants. Treat a 3DS modal as a retry trigger, not a failure. The same handle can be reused for multiple fill attempts until `validUntil` expires.

## Step 3B — Machine payment (HTTP 402 endpoint)

Use this path for services that accept payments over HTTP using the Machine Payments Protocol. No browser is involved.

```json
{
  "action": "execute_machine_payment",
  "providerId": "stripe-link",
  "fundingSourceId": "<id from step 2>",
  "targetUrl": "https://api.example.com/purchase",
  "method": "POST",
  "body": { "item": "widget-123" },
  "idempotencyKey": "optional-dedup-key"
}
```

This action requires **critical-severity approval**. The approval description explicitly marks the action as irreversible once settled.

On success, the result includes `outcome` (`settled | failed | pending`) and a redacted `receipt`. No spend request token (SPT) or raw payment credential appears in the result.

If `outcome` is `failed`, do not automatically retry. Report the failure to the user and ask for instructions. If retrying is appropriate, reuse the same `idempotencyKey` to avoid double-charges.

## Recovery decision tree

```
fill returns card_unavailable?
  └─ yes → issue new virtual card (new approval needed)
  └─ no

handle.status == expired?
  └─ yes → issue new virtual card
  └─ no

3DS challenge appeared?
  └─ yes → wait for user, retry fill (new critical approval)
  └─ no

decline or permanent error?
  └─ yes → report to user, do not retry automatically
  └─ no

validUntil in the future?
  └─ yes → retry fill (new critical approval)
  └─ no → issue new virtual card
```

## What you will never see

The payment plugin guarantees the following. Do not attempt to work around these limits:

- Real PAN, CVV, expiry digits, or holder name will never appear in any tool result.
- `fillSentinels` values are opaque reference objects, not card data.
- After a successful fill, the browser tab contains real card values that you typed, but those values are not returned to you in any tool result.

If you receive an unexpected card-shaped string in a tool result, stop and report it to the user as a possible security issue.
