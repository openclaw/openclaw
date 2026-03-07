# STRIPE_PAYMENTS.md — Payment Automation Specification

## 0) Purpose

Stripe manages all payments.

System only creates checkout sessions using predefined Price IDs.

---

## 1) Allowed Flow

Human closes call.

System receives:

```
selected_offer_key
```

System creates Checkout Session with:

```
price_id
customer_email
metadata:
  ghl_contact_id
  correlation_id
```

---

## 2) Webhook Requirements

Must verify Stripe signature.

Reject if invalid.

---

## 3) Payment Success Logic

When `checkout.session.completed`:

- mark `payment.paid`
- update GHL stage → WON
- trigger `fulfillment.created`

---

## 4) Forbidden Actions

- no dynamic pricing from AI
- no discount generation without explicit approval
