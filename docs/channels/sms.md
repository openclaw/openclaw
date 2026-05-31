---
summary: "Twilio SMS channel setup, access controls, and webhook configuration"
read_when:
  - You want to connect OpenClaw to SMS through Twilio
  - You need SMS webhook or allowlist setup
title: "SMS"
---

OpenClaw can receive and send SMS through a Twilio phone number or Messaging Service. The Gateway registers an inbound webhook route, validates Twilio request signatures by default, and sends replies back through Twilio's Messages API.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Default DM policy for SMS is pairing.
  </Card>
  <Card title="Gateway security" icon="shield" href="/gateway/security">
    Review webhook exposure and sender access controls.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair playbooks.
  </Card>
</CardGroup>

## Quick setup

<Steps>
  <Step title="Create or choose a Twilio sender">
    In Twilio, choose an SMS-capable phone number or Messaging Service. Save the Account SID, Auth Token, and sender value.
  </Step>

  <Step title="Configure the SMS channel">

```json5
{
  channels: {
    sms: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      fromNumber: "+15551234567",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      dmPolicy: "pairing",
    },
  },
}
```

    Env fallbacks for the default account:
    `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID`, and `SMS_PUBLIC_WEBHOOK_URL`.

  </Step>

  <Step title="Point Twilio at the Gateway webhook">
    Set the Twilio Messaging webhook for incoming messages to:

```text
https://gateway.example.com/webhooks/sms
```

    Use HTTP `POST`. The default local path is `/webhooks/sms`; change `channels.sms.webhookPath` if you need a different route.

  </Step>

  <Step title="Start the Gateway and approve first sender">

```bash
openclaw gateway
openclaw pairing list sms
openclaw pairing approve sms <CODE>
```

    Pairing codes expire after 1 hour.

  </Step>
</Steps>

## Access control

`channels.sms.dmPolicy` controls direct SMS access:

- `pairing` (default)
- `allowlist` (requires at least one sender in `allowFrom`)
- `open` (requires `allowFrom` to include `"*"`)
- `disabled`

`allowFrom` entries should be E.164 phone numbers such as `+15551234567`. `sms:` prefixes are accepted and normalized. For a private assistant, prefer `dmPolicy: "allowlist"` with explicit phone numbers.

## Sending SMS

Outbound SMS targets use the `sms:` prefix:

```bash
openclaw message --to sms:+15551234567 "hello"
```

Agent replies from inbound SMS conversations automatically go back to the sender through the configured Twilio sender.

Use `messagingServiceSid` instead of `fromNumber` when Twilio should choose the sender through a Messaging Service:

```json5
{
  channels: {
    sms: {
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
    },
  },
}
```

If both are present after defaults/env resolution, `fromNumber` is used.

## Webhook security

By default, OpenClaw validates `X-Twilio-Signature` using `publicWebhookUrl` and `authToken`. Keep `publicWebhookUrl` byte-for-byte aligned with the URL configured in Twilio, including scheme, host, path, and query string.

For local tunnel testing only, you can set:

```json5
{
  channels: {
    sms: {
      dangerouslyDisableSignatureValidation: true,
    },
  },
}
```

Do not use disabled signature validation on a public Gateway.

## Multi-account config

Use `accounts` when you operate more than one Twilio number:

```json5
{
  channels: {
    sms: {
      accounts: {
        support: {
          enabled: true,
          accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          authToken: "twilio-auth-token",
          fromNumber: "+15551234567",
          publicWebhookUrl: "https://gateway.example.com/webhooks/sms/support",
          webhookPath: "/webhooks/sms/support",
          dmPolicy: "allowlist",
          allowFrom: ["+15557654321"],
        },
      },
    },
  },
}
```

Each account should use a distinct `webhookPath`.
