# POSTHOG_EVENT_SCHEMA.md — Analytics Event Definitions

## 0) Rule

No raw PII allowed.

Use internal IDs only.

---

## 1) Lead Events

```
lead_captured
lead_qualified
booking_created
payment_paid
```

Properties:

```
correlation_id
brand
offer_key
```

---

## 2) CUTMV Events

```
signup_created
first_export_completed
subscription_started
```

---

## 3) Ad Events

```
ad_click_recorded
ad_lead_created
```

---

## 4) Failure Events

```
integration_error
webhook_invalid_signature
retry_exhausted
```
