# RUNBOOK_INCIDENT_RESPONSE.md — Operational Response

## 0) Golden Rule

If anything unexpected happens:

Enable:

```
KILL_SWITCH=true
```

---

## 1) Payment Incident

If duplicate Stripe sessions detected:

- pause fulfillment
- verify manually
- mark duplicate as refunded if needed

---

## 2) Lead Flood Incident

If webhook spike:

- enable Cloudflare rate limit
- temporarily set `READ_ONLY=true`

---

## 3) Credential Leak Suspected

- rotate all API keys immediately
- revoke old keys
- audit last 24h logs

---

## 4) Worker Failure

If worker offline:

- queue tasks
- restart worker
- replay queued events

---

## 5) Data Corruption

Restore:

- last backup snapshot
- replay event logs
