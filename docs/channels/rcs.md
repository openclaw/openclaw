---
summary: "Twilio RCS Business Messaging channel setup, access controls, and webhook configuration"
read_when:
  - You want to connect OpenClaw to RCS Business Messaging through Twilio
  - You need RCS webhook or allowlist setup
  - You are troubleshooting RCS delivery or signature validation
title: "RCS"
---

OpenClaw can receive and send RCS Business Messaging through a Twilio RCS-approved sender and Messaging Service. The Gateway registers an inbound webhook route, validates Twilio request signatures by default, and sends rich replies back through Twilio's Messages API using the `rcs:+E164` address format.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Default DM policy for RCS is pairing.
  </Card>
  <Card title="Gateway security" icon="shield" href="/gateway/security">
    Review webhook exposure and sender access controls.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair playbooks.
  </Card>
</CardGroup>

## Before you begin

You need:

- A Twilio account with an approved RCS Business Messaging sender.
- A Twilio Messaging Service that owns the approved RCS sender.
- The Twilio Account SID and Auth Token.
- A public HTTPS URL that reaches your OpenClaw Gateway.
- A sender policy choice: `pairing` for private use, `allowlist` for preapproved phone numbers, or `open` only for intentionally public RCS access.

## Why RCS

RCS is intended for richer phone-number messaging, not merely as another SMS rail. SMS cannot
carry most of the conversational surfaces OpenClaw relies on elsewhere; RCS restores them on a
plain phone number:

- **Delivery and read receipts.** Outbound status callbacks progress through `sent`, `delivered`,
  and `read` (post-delivery read receipts arrive as `EventType=READ`). OpenClaw persists those
  callbacks and exposes the latest receipt on the agent-visible channel status surface rather than
  treating the conversation as fire-and-forget.
- **Rich media and actions.** Full-resolution images and video, rich cards, and suggested
  replies/actions instead of SMS's plain text and carrier-compressed MMS. Inbound button taps
  arrive as structured payloads the agent can route on.
- **Long messages without fragmentation.** No 160-character segment splitting or mid-thought
  truncation.
- **Verified sender identity.** An RCS sender is a carrier- and platform-verified agent with a
  branded profile page — name, logo, description, and contact details — instead of an anonymous
  10-digit number. Recipients can check who is messaging them before replying, which is a
  meaningful anti-spoofing and anti-phishing property for business and compliance-sensitive
  deployments; the registration/vetting process that grants it is also what compliance reviews
  typically ask for.

If you fall back to SMS, delivery may keep working, but the channel loses the capabilities that
make RCS worth configuring.

### Provider support

Twilio RCS Business Messaging is the initial supported provider. The channel surface itself is
provider-neutral: the `rcs` channel id, the `rcs:+E164` address format, pairing/allowlist access
control, and delivery/read status capture do not encode Twilio specifics. Twilio-specific webhook
and API handling is isolated in the provider layer so additional RCS Business Messaging providers
can back the same channel without changing how agents or operators address it.

RCS Business Messaging senders normally have a test phase before launch. Test devices can receive
messages from an unlaunched sender, but clients may display a system notice that the business
message is for testing only. OpenClaw cannot remove that notice because it is injected by the RCS
platform/client, not by the OpenClaw message payload. To avoid the notice on RCS itself, launch the
sender for the target country/carriers through your provider's registration and approval process.

For new deployments, use a dedicated Twilio Messaging Service for RCS with `use_inbound_webhook_on_number` set to `false` and `inbound_request_url` pointed at `/webhooks/rcs`.

If your Twilio account already delivers SMS and RCS from a shared Messaging Service to the same inbound URL, OpenClaw can instead run a shared Twilio webhook router. The shared router lets Twilio keep posting to the existing SMS URL, dispatches `rcs:*` payloads through the RCS channel, and forwards ordinary SMS payloads to the native SMS handler.

## Quick Setup

<Steps>
  <Step title="Create or choose a Twilio RCS Messaging Service">
    In Twilio, open **Messaging > Services** and create a new service, or use an existing one that holds your approved RCS sender.

    Configure the service:

    - Set **Inbound Request URL** to `https://gateway.example.com/webhooks/rcs`
    - Set **Inbound HTTP Method** to `POST`
    - Set **Use Inbound Webhook on Number** to `false` (required for RCS senders, which are agents, not phone numbers)

    Save:

    - Account SID, for example `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
    - Auth Token
    - Messaging Service SID, for example `MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

  </Step>

  <Step title="Configure the RCS channel">

Save this as `rcs.patch.json5` and change the placeholders:

```json5
{
  channels: {
    rcs: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      transport: "rcs-only",
      publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
      statusCallbacks: true,
      dmPolicy: "pairing",
    },
  },
}
```

Apply it:

```bash
openclaw config patch --file ./rcs.patch.json5 --dry-run
openclaw config patch --file ./rcs.patch.json5
```

  </Step>

  <Step title="Point Twilio at the Gateway webhook">
    On the Messaging Service, confirm **Inbound Request URL** is set to:

```text
https://gateway.example.com/webhooks/rcs
```

    Use HTTP `POST`. Ensure `use_inbound_webhook_on_number` is `false`. The default local path is `/webhooks/rcs`; change `channels.rcs.webhookPath` if you need a different route.

  </Step>

  <Step title="Start the Gateway and approve first sender">

```bash
openclaw gateway
```

Send an RCS message to your approved sender from an RCS-capable device. The first message creates a pairing request. Approve it:

```bash
openclaw pairing list rcs
openclaw pairing approve rcs <CODE>
```

    Pairing codes expire after 1 hour.

  </Step>
</Steps>

## Configuration Examples

### Config file

```json5
{
  channels: {
    rcs: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      transport: "rcs-only",
      publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
      statusCallbacks: true,
      dmPolicy: "pairing",
    },
  },
}
```

### Applying secrets

For single-host gateways, the recommended approach is to write credentials directly into the
0600 `openclaw.json` config file using one validated config patch. This mirrors the SMS channel
pattern — no environment variables or secret references needed — while keeping secret values out
of process arguments:

```bash
openclaw config patch --stdin <<'JSON5'
{
  channels: {
    rcs: {
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      allowFrom: ["<E.164-number>"],
    },
  },
}
JSON5
```

Values written by `openclaw config patch` are stored as plain literals in the 0600 config file.
`openclaw config get` masks them at display time. Restart the Gateway after applying credentials.

### Environment variables (alternative)

For containerized or multi-host deployments where credentials come from the host environment,
the RCS channel reads these env vars when the corresponding config keys are absent:

```bash
export TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TWILIO_AUTH_TOKEN="<twilio-auth-token>"
export TWILIO_RCS_MESSAGING_SERVICE_SID="MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Then enable the channel in config:

```json5
{
  channels: {
    rcs: {
      enabled: true,
      transport: "rcs-only",
      dmPolicy: "pairing",
    },
  },
}
```

Restart managed Gateway processes after changing host environment variables.

### SecretRef auth token (alternative)

`authToken` can be a SecretRef when the Gateway should resolve the Twilio Auth Token from the
OpenClaw secrets runtime:

```json5
{
  channels: {
    rcs: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: { source: "env", provider: "default", id: "TWILIO_AUTH_TOKEN" },
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      transport: "rcs-only",
      publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
      dmPolicy: "pairing",
    },
  },
}
```

The referenced environment variable or secret provider must be visible to the Gateway runtime.

### Allowlist-only private number

Use `allowlist` when only known phone numbers should be able to send RCS to the agent:

```json5
{
  channels: {
    rcs: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      transport: "rcs-only",
      publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
      dmPolicy: "allowlist",
      allowFrom: ["+15557654321"],
    },
  },
}
```

### RCS-preferred transport

Use `rcs-preferred` to allow Twilio to fall back to SMS or MMS when the destination does not support RCS. Only use this if you intentionally want a single channel to serve both RCS and SMS recipients:

```json5
{
  channels: {
    rcs: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      transport: "rcs-preferred",
      publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
      dmPolicy: "pairing",
    },
  },
}
```

When using a separate SMS channel, prefer `rcs-only`. `rcs-preferred` with a shared Messaging Service would silently recouple the RCS and SMS channels.

### Shared SMS/RCS Twilio webhook

Use this only when Twilio already posts both SMS and RCS traffic to one public SMS webhook URL and you need to avoid a Twilio topology change.

In this mode:

- Twilio continues posting to the existing shared URL, for example `https://gateway.example.com/webhooks/sms`.
- Native SMS moves to an internal Gateway path, for example `/webhooks/sms/native`.
- The RCS channel owns the public shared path and validates Twilio signatures against `sharedWebhookPublicUrl`.
- Payloads with `rcs:` in `From` or `To` go to the RCS channel.
- Plain SMS payloads are forwarded internally to `smsForwardWebhookPath`.

```json5
{
  channels: {
    sms: {
      webhookPath: "/webhooks/sms/native",
    },
    rcs: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      transport: "rcs-only",
      webhookPath: "/webhooks/rcs",
      publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
      sharedWebhookPath: "/webhooks/sms",
      sharedWebhookPublicUrl: "https://gateway.example.com/webhooks/sms",
      smsForwardWebhookPath: "/webhooks/sms/native",
      dmPolicy: "allowlist",
      allowFrom: ["+15557654321"],
    },
  },
}
```

Do not set `dangerouslyDisableSignatureValidation: true` on a public shared webhook. A bad signature must fail before either RCS dispatch or SMS forwarding.

Exactly one channel can own the public shared path. The Gateway route registry accepts a single owner per exact path, so `channels.sms.webhookPath` must not equal `channels.rcs.sharedWebhookPath`. If both channels try to register the same exact path, the Gateway now fails startup with an actionable error naming the conflicting path, rather than letting startup order silently decide which channel handles the shared Twilio URL and leaving the other channel dark. Keep SMS on a distinct internal path (`smsForwardWebhookPath`) as shown above. The RCS channel also refuses to start a shared-webhook account whose `sharedWebhookPath` equals its own `webhookPath` or its `smsForwardWebhookPath`.

### Status callbacks

Set `statusCallbacks: true` to receive Twilio delivery and read receipts for outbound RCS messages. When `publicWebhookUrl` is set, status callbacks default on unless `statusCallbacks: false` is configured. The Messaging Service must be configured to POST status events to the same URL:

```json5
{
  channels: {
    rcs: {
      enabled: true,
      statusCallbacks: true,
      publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
    },
  },
}
```

Recorded delivery and read callbacks persist in OpenClaw's shared SQLite plugin state and surface on the channel status surface, so the latest received receipt remains visible to operators and agents across Gateway restarts without a live Twilio lookup:

```bash
openclaw channels capabilities --channel rcs
```

### Text chunk limit

Twilio's Message API accepts up to 1,600 characters per outbound message body. OpenClaw splits long agent replies before sending and caps the effective `textChunkLimit` at 1,600 characters even if configuration asks for more:

```json5
{
  channels: {
    rcs: {
      textChunkLimit: 1600,
    },
  },
}
```

### Default outbound target

Set `defaultTo` when automation or agent-initiated delivery should have a default destination:

```json5
{
  channels: {
    rcs: {
      enabled: true,
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      defaultTo: "+15557654321",
      publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
    },
  },
}
```

## Access control

`channels.rcs.dmPolicy` controls direct RCS access:

- `pairing` (default)
- `allowlist` (requires at least one sender in `allowFrom`)
- `open` (requires `allowFrom` to include `"*"`)
- `disabled`

`allowFrom` entries should be E.164 phone numbers such as `+15551234567`. `rcs:` prefixes are accepted and normalized. For a private assistant, prefer `dmPolicy: "allowlist"` with explicit phone numbers.

## Sending RCS

Outbound RCS targets use the `rcs:` address prefix:

```bash
openclaw message send --channel rcs --target rcs:+15551234567 --message "hello"
```

Agent replies from inbound RCS conversations automatically go back to the sender through the configured Twilio Messaging Service.

RCS output supports plain text and rich structured messages. For plain text, OpenClaw strips markdown, flattens fenced code blocks, preserves readable links, and splits long replies at the configured `textChunkLimit` before sending through Twilio.

### Rich messages (buttons, suggested replies, cards)

The RCS channel renders OpenClaw's portable [message presentation](/plugins/message-presentation) natively through Twilio's Content API. When a reply carries presentation blocks, OpenClaw creates a Twilio Content Template and sends it by `ContentSid`, mapping:

- **Suggested replies** (callback/command buttons and select options) to RCS `twilio/card` quick-reply actions.
- **Link buttons** (`url` / `web-app` actions) to RCS `twilio/card` URL actions.
- **Mixed link and reply actions, or actions alongside media,** to the same `twilio/card` shape.
- **Media without actions** to `twilio/media`.

RCS allows up to 11 suggestions per message with short (up to 20 character) labels and up to 1,600 characters in card body text; OpenClaw adapts longer presentations to those limits before sending. When a recipient taps a suggested reply, Twilio delivers it back as an inbound message carrying the button text and postback payload, which OpenClaw maps to a normal agent turn.

Rich RCS rendering on the recipient device requires a launched or approved RCS sender for the target carriers; before launch, test devices receive the content but may show the platform test-mode notice. Carousel and list-picker templates are not yet emitted.

## Verify Setup

After the Gateway starts:

1. Confirm the Gateway log shows the RCS webhook route at `/webhooks/rcs`.
2. Run a channel probe:

```bash
openclaw channels capabilities --channel rcs
openclaw channels status --channel rcs --probe --json
```

3. Send an RCS message from your phone to the Twilio RCS sender.
4. Run `openclaw pairing list rcs`.
5. Approve the pairing code with `openclaw pairing approve rcs <CODE>`.
6. Send another RCS message and confirm the agent replies.

For outbound-only testing, use:

```bash
openclaw message send --channel rcs --target rcs:+15557654321 --message "OpenClaw RCS test"
```

## Webhook security

By default, OpenClaw validates `X-Twilio-Signature` using `publicWebhookUrl` and `authToken`. Keep `publicWebhookUrl` byte-for-byte aligned with the URL configured in the Twilio Messaging Service `inbound_request_url`, including scheme, host, path, and query string.

For local tunnel testing only, you can set:

```json5
{
  channels: {
    rcs: {
      dangerouslyDisableSignatureValidation: true,
    },
  },
}
```

Do not use disabled signature validation on a public Gateway.

The webhook routes also enforce, independent of signature validation:

- `POST` only.
- Coarse rate limit of 600 requests per minute per source IP. Over-limit requests that fail body parsing, signature validation, or `AccountSid` matching get HTTP 429; signature-validated callbacks over the limit are acknowledged with HTTP 200 and empty TwiML but not dispatched (or SMS-forwarded on the shared route), because Twilio treats non-2xx webhook responses as delivery failures and does not retry them. With `dangerouslyDisableSignatureValidation`, all over-limit traffic keeps HTTP 429.
- Per-sender rate limit of 30 messages per minute after signature validation. Over-limit senders are acknowledged with HTTP 200 and empty TwiML but not dispatched.
- The payload `AccountSid` must match the configured `accountSid` (HTTP 403 otherwise).
- A valid, accepted callback is committed to OpenClaw's shared SQLite ingress queue before the
  webhook returns HTTP 200. Pending messages resume after Gateway restarts, and completed
  `MessageSid` tombstones prevent duplicate turns for 24 hours.

## Multi-account config

Use `accounts` when you operate more than one Twilio RCS sender:

```json5
{
  channels: {
    rcs: {
      accounts: {
        main: {
          enabled: true,
          accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          authToken: "twilio-auth-token",
          messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          transport: "rcs-only",
          publicWebhookUrl: "https://gateway.example.com/webhooks/rcs/main",
          webhookPath: "/webhooks/rcs/main",
          dmPolicy: "allowlist",
          allowFrom: ["+15557654321"],
        },
      },
    },
  },
}
```

Each account should use a distinct `webhookPath`.

## Troubleshooting

### Twilio returns 403 or OpenClaw rejects the webhook

Check that `publicWebhookUrl` exactly matches the Messaging Service `inbound_request_url`, including scheme, host, path, and query string. Twilio signs the public URL string, so proxy rewrites and alternate hostnames can break signature validation.

### No messages arrive at the Gateway

For dedicated RCS services, confirm that the Messaging Service has:

- `inbound_request_url` set to `https://gateway.example.com/webhooks/rcs`
- `use_inbound_webhook_on_number` set to `false`

RCS senders are agent-based, not number-based. If `use_inbound_webhook_on_number` is `true`, Twilio routes inbound by the number's webhook URL, which does not exist for an RCS sender. Inbound messages will not reach the Gateway.

For shared SMS/RCS webhook deployments, confirm:

- Twilio still posts to `sharedWebhookPublicUrl`.
- `sharedWebhookPath` matches the public path.
- `smsForwardWebhookPath` matches the native SMS `webhookPath`.
- `sharedWebhookPublicUrl` is the URL used for Twilio signature verification on the shared path.

### No pairing request appears

Check the Gateway log for the RCS webhook route and confirm the Twilio Messaging Service `inbound_request_url` points at the Gateway. Also confirm the route is reachable from the public internet or through your tunnel.

If the Twilio message log shows error `11200`, Twilio could not reach your webhook. Check:

- `inbound_request_url` is set on the Messaging Service (not on the phone number).
- The reverse proxy or tunnel exposes `/webhooks/rcs`.
- `publicWebhookUrl` uses the same scheme, host, and path that Twilio sends, so signature validation can reproduce the signed URL.

### Outbound sends fail

Confirm `accountSid`, `authToken`, and `messagingServiceSid` are resolved. Confirm the Messaging Service sender pool contains the approved RCS sender. If `transport` is `rcs-only`, non-RCS-capable destinations will fail with a Twilio error — this is intentional.

### Messages arrive but the agent does not answer

Check `dmPolicy` and `allowFrom`. With the default `pairing` policy, the sender must be approved before normal agent turns are processed.

### RCS and SMS share a Messaging Service

Prefer a dedicated RCS Messaging Service for new setups. If the shared topology already exists and you cannot safely change Twilio, use the shared webhook router instead of repointing the shared service to `/webhooks/rcs`. Repointing the shared service can break SMS inbound; the router preserves the existing public URL and forwards non-RCS payloads to native SMS.
