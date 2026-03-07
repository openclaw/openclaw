# SECURITY.md — Gold Standard Controls (Home Cluster)

## 0) Objective

Protect business-critical credentials and prevent unauthorized actions:

- Webhook spoofing
- Key leakage
- Runaway ad spend
- Silent failures
- Local machine compromise

Threat posture: **assume compromise + least privilege + approval gates + audit trails.**

## 1) Secrets Management

### 1.1 Required

- Use **Bitwarden Secrets Manager** (or equivalent: 1Password, HashiCorp Vault)
- No secrets committed to git (`.env` is in `.gitignore`)
- Only `.env.example` with placeholders is committed
- Separate dev/stage/prod credential sets

### 1.2 Rotation

- Rotate all keys after initial deployment
- Rotate immediately on any suspected exposure
- Monthly/quarterly rotation schedule
- Prefer short-lived tokens when available

### 1.3 Secrets Flow

```
Bitwarden Secrets Manager
    │ (pull at runtime, read-only token)
    ▼
secrets-loader → inject into process env
    │
    ▼
Services read env vars at startup
    - NEVER writes secrets to disk
    - Logs are redacted
    - Rotate by replacing in secrets manager
```

## 2) Network Security

### 2.1 Cloudflare Tunnel (Recommended)

- Inbound webhooks delivered via Cloudflare Tunnel
- No port forwarding on router
- WAF + bot protection + rate limiting enabled
- TLS termination at Cloudflare edge
- Access policies for service auth / IP rules

### 2.2 VLAN Segmentation

| VLAN | Purpose | Devices |
|------|---------|---------|
| VLAN 10 | Trusted LAN | Laptops, phones |
| VLAN 30 | Automation | Mac mini, worker nodes |
| VLAN 40 | IoT/Guest | TVs, untrusted devices |

Only allow VLAN 10 → VLAN 30 admin access through Tailscale, not direct LAN.

### 2.3 Admin Plane

- SSH keys only (no password logins)
- Tailscale ACLs per device
- FileVault ON on all Macs
- Strong admin passwords
- Firewall ON, disable unnecessary remote access
- Auto-updates enabled

## 3) Webhook Security

### 3.1 Authentication

| Source | Method |
|--------|--------|
| Stripe | Verify `stripe-signature` header (ALWAYS) |
| ManyChat | Require `X-Webhook-Secret` header |
| GoHighLevel | Require `X-Webhook-Secret` header |
| Trello | Require `X-Webhook-Secret` header + validate callback |

### 3.2 Replay Protection

- Store event_id / event_key in SQLite `IdempotencyStore`
- If same event arrives again → reject as duplicate
- Cleanup entries older than 7 days

### 3.3 Rate Limiting & Payload Controls

- Maximum payload size: 1MB (enforced by middleware)
- Reject unknown content-types
- Future: per-route rate limiting via Cloudflare or middleware

## 4) Application Security Controls

### 4.1 Safety Modes

| Mode | Env Var | Effect |
|------|---------|--------|
| Dry Run | `DRY_RUN=true` | Simulate writes (default in dev) |
| Read Only | `READ_ONLY=true` | Block all external writes |
| Kill Switch | `KILL_SWITCH=true` | Immediately block all writes |

### 4.2 Audit Logging

Every external write records to SQLite `audit_log`:

| Field | Description |
|-------|-------------|
| timestamp | UTC ISO timestamp |
| action | What was done (e.g., `ghl_contact_created`) |
| actor | Who/what triggered it (e.g., `system`, `webhook.manychat`) |
| service | Target system (e.g., `ghl`, `trello`, `stripe`) |
| correlation_id | Links to originating webhook |
| before_state | State before mutation (JSON) |
| after_state | State after mutation (JSON) |
| details | Additional context (JSON) |

### 4.3 Log Redaction

The structlog processor in `packages/common/logging.py` automatically
redacts values for keys matching:

```
api_key, secret, token, password, authorization, bearer, dsn,
access_token, refresh_token, webhook_secret, client_secret, private_key
```

This applies recursively to nested dicts in log entries.

## 5) Spend Safety (Ads Engine)

| Rule | Value |
|------|-------|
| Max daily budget (total) | $100 |
| Max per experiment | $50 |
| Max active experiments | 5 |
| Human approval threshold | $25 |
| Dry run by default | Yes |
| Auto-execute spend changes | NEVER |

The ads engine produces proposals (JSON). Humans approve. Services execute.

## 6) Observability

| Tool | Purpose | PII Policy |
|------|---------|-----------|
| Sentry | Exceptions + alerting | Scrub PII from error reports |
| PostHog | Event analytics | NO raw phone/email — use internal IDs |
| Health endpoints | Liveness + readiness | No sensitive data exposed |
| Structured logs | Debug + audit | All secrets redacted |

## 7) Data Handling Rules

- Do not send phone, email, or name to PostHog
- Use hashed identifiers or internal IDs for analytics
- Redact sensitive fields from logs and error reports
- Store PII only in GoHighLevel (system of record)

## 8) Dependency Security

- Pin all dependency versions in `pyproject.toml`
- Run `pip-audit` for vulnerability scanning
- Use private GitHub repo with branch protection
- Require PR review before merging to main

## 9) Pre-Production Checklist

Before connecting real money systems (Stripe live, Meta Ads writes):

- [ ] Cloudflare Tunnel (or Tailscale Funnel) configured
- [ ] Webhook secrets verified end-to-end
- [ ] Run with DRY_RUN=true for at least 24 hours
- [ ] Confirm audit logs capture every external write
- [ ] Add spend caps and READ_ONLY defaults for ad accounts
- [ ] Verify log redaction strips all secrets
- [ ] Test KILL_SWITCH kills all writes
- [ ] Backup configuration (not secrets) automated
