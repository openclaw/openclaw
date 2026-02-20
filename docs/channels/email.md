---
summary: "Email channel plugin (SMTP outbound)"
read_when:
  - You want OpenClaw to send messages to email addresses
  - You are configuring SMTP settings for outbound email delivery
title: "Email"
---

# Email

Status: plugin-based channel with outbound SMTP support.

The Email channel lets OpenClaw deliver responses and notifications to email recipients.

## Current Scope (MVP)

- Outbound messages via SMTP
- Target formats: `user@example.com`, `email:user@example.com`, `mailto:user@example.com`
- Delivery through `message send` / routing like other channels
- Status probe via SMTP `verify`

Not included yet:

- Inbound email ingestion (IMAP/webhook)
- Email thread reply correlation

## Install

```bash
openclaw channels add email
```

## Configuration

```json
{
  "channels": {
    "email": {
      "enabled": true,
      "smtpHost": "smtp.example.com",
      "smtpPort": 587,
      "smtpSecure": false,
      "smtpUser": "bot@example.com",
      "smtpPass": "app-password",
      "from": "bot@example.com",
      "subjectPrefix": "OpenClaw"
    }
  }
}
```

Optional: use env-based password loading.

```json
{
  "channels": {
    "email": {
      "smtpPassEnv": "SMTP_PASS"
    }
  }
}
```

## Sending

```bash
openclaw message send --channel email --to email:user@example.com --text "Hello from OpenClaw"
```

## Troubleshooting

- If status/probe fails, verify host/port/secure settings and SMTP credentials.
- For Gmail or Microsoft 365, use app passwords or provider-specific SMTP auth setup.
