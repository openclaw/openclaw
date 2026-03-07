# SENTRY_RUNBOOK.md — Error Monitoring

## 0) Required Setup

Initialize Sentry at service startup.

Attach:

```
environment
service_name
correlation_id
```

---

## 1) Severity Levels

```
ERROR   = integration failure
WARNING = retryable API error
INFO    = expected business event
```

---

## 2) Alert Rules

Send alert immediately for:

- webhook verification failure spike
- Stripe webhook failures
- Trello sync failures

---

## 3) Log Scrubbing

Before sending to Sentry:

Remove:

```
Authorization headers
API keys
emails
phone numbers
```
