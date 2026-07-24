---
summary: "Twilio SMS channel setup, access controls, and webhook configuration"
read_when:
  - You want to connect OpenClaw to SMS through Twilio
  - You need SMS webhook or allowlist setup
title: "SMS"
---

OpenClaw receives and sends SMS through a Twilio phone number or Messaging Service. The Gateway registers an inbound webhook route (default `/webhooks/sms`), validates Twilio request signatures by default, and sends replies back through Twilio's Messages API.

Status: official plugin, installed separately. Text only: no MMS/media, direct messages only.

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

## Before you begin

You need:

- The official SMS plugin installed with `openclaw plugins install @openclaw/sms`.
- A Twilio account with an SMS-capable phone number, or a Twilio Messaging Service.
- The Twilio Account SID and Auth Token.
- A public HTTPS URL that reaches your OpenClaw Gateway.
- A sender policy choice: `pairing` (default) for private use, `allowlist` for preapproved phone numbers, or `open` only for intentionally public SMS access.

One Twilio number can serve both SMS and [Voice Call](/plugins/voice-call) if it has both capabilities. The SMS webhook and Voice webhook are configured separately in Twilio and use separate Gateway paths; this page only covers the SMS webhook.

## US A2P / 10DLC delivery

For US destinations, SMS sent from a Twilio `+1` 10-digit long code is subject to US A2P 10DLC registration. This is separate from OpenClaw channel setup: webhook signature validation, pairing, and outbound credentials can all be correct while carriers still block or filter delivery.

Before relying on a US 10DLC sender, confirm in Twilio that:

- The Brand and Campaign are registered and approved.
- The Twilio phone number is in the Sender Pool of the Messaging Service associated with the approved Campaign, or the `messagingServiceSid` you configure here is that approved service.
- The Campaign describes the real OpenClaw message use case and includes matching sample messages.
- The opt-in flow is public, verifiable, and uses optional SMS consent that is separate from required service terms; see the registration quickstart for current opt-in requirements.
- Consent and contact list requirements meet Twilio's A2P policies.

Use Twilio as the source of truth for current requirements: [A2P 10DLC overview](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc), [registration quickstart](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart), and [required business and campaign information](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/collect-business-info). This section is setup guidance, not legal advice.

If Twilio rejects the Brand or Campaign during registration review, fix that in Twilio before using the sender with OpenClaw. Campaign review failures such as [`30909`](https://www.twilio.com/docs/api/errors/30909) or [`30923`](https://www.twilio.com/docs/api/errors/30923) usually point to missing or unverifiable opt-in flow, required/bundled SMS consent, missing policy links, or sample messages that do not match the declared use case.

## Quick Setup

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/sms
    ```
  </Step>
  <Step title="Create or choose a Twilio sender">
    In Twilio, open **Phone Numbers > Manage > Active numbers** and choose an SMS-capable number. Save:

    - Account SID, for example `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
    - Auth Token
    - Sender phone number, for example `+15551234567`

    If you use a Messaging Service instead of a fixed sender number, save the Messaging Service SID, for example `MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.

  </Step>

  <Step title="Configure the SMS channel">

Save this as `sms.patch.json5` and change the placeholders:

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

Apply it:

```bash
openclaw config patch --file ./sms.patch.json5 --dry-run
openclaw config patch --file ./sms.patch.json5
```

  </Step>

  <Step title="Point Twilio at the Gateway webhook">
    In the Twilio phone number settings, open **Messaging** and set **A message comes in** to:

```text
https://gateway.example.com/webhooks/sms
```

    Use HTTP `POST`. The default local path is `/webhooks/sms`; change `channels.sms.webhookPath` if you need a different route.

  </Step>

  <Step title="Expose the exact SMS webhook path">
    Your public URL must route the SMS path to the Gateway process (default port `18789`). If you use Tailscale Funnel for local testing, expose `/webhooks/sms` explicitly:

```bash
tailscale funnel --bg --set-path /webhooks/sms http://127.0.0.1:<gateway-port>/webhooks/sms
tailscale funnel status
```

    Voice Call and SMS use separate webhook paths. If the same Twilio number handles both, keep both routes configured in Twilio and in your tunnel.

  </Step>

  <Step title="Start the Gateway and approve first sender">

```bash
openclaw gateway
```

Send a text message to the Twilio number. The first message creates a pairing request. Approve it:

```bash
openclaw pairing list sms
openclaw pairing approve sms <CODE>
```

    Pairing codes expire after 1 hour.

  </Step>
</Steps>

## Configuration Examples

All keys live under `channels.sms` (and per account under `channels.sms.accounts.<id>`):

| Key                                     | Default         | Purpose                                                             |
| --------------------------------------- | --------------- | ------------------------------------------------------------------- |
| `enabled`                               | `true`          | Enable or disable the channel/account.                              |
| `accountSid`                            | —               | Twilio Account SID (`AC...`).                                       |
| `authToken`                             | —               | Twilio Auth Token; plaintext string or SecretRef.                   |
| `fromNumber`                            | —               | E.164 sender number.                                                |
| `messagingServiceSid`                   | —               | Messaging Service SID (`MG...`) used when no `fromNumber` resolves. |
| `defaultTo`                             | —               | Default destination when a send flow omits an explicit target.      |
| `webhookPath`                           | `/webhooks/sms` | Gateway HTTP path for inbound Twilio webhooks.                      |
| `publicWebhookUrl`                      | —               | Public URL configured in Twilio; required for signature validation. |
| `dangerouslyDisableSignatureValidation` | `false`         | Skip `X-Twilio-Signature` checks; local tunnel testing only.        |
| `dmPolicy`                              | `"pairing"`     | `pairing`, `allowlist`, `open`, or `disabled`.                      |
| `allowFrom`                             | `[]`            | Allowed sender numbers in E.164, or `"*"` with `dmPolicy: "open"`.  |
| `textChunkLimit`                        | `1500`          | Maximum characters per outbound SMS chunk.                          |
| `accounts`, `defaultAccount`            | —               | Multi-account map and default account id.                           |

### Config file

Use config-file setup when you want the channel definition to travel with the Gateway config:

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

### Environment variables

Environment variables apply to the default account only; config values take precedence over env values.

| Variable                                        | Maps to                                            |
| ----------------------------------------------- | -------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`                            | `accountSid`                                       |
| `TWILIO_AUTH_TOKEN`                             | `authToken`                                        |
| `TWILIO_PHONE_NUMBER` (alias `TWILIO_SMS_FROM`) | `fromNumber`                                       |
| `TWILIO_MESSAGING_SERVICE_SID`                  | `messagingServiceSid`                              |
| `SMS_PUBLIC_WEBHOOK_URL`                        | `publicWebhookUrl`                                 |
| `SMS_WEBHOOK_PATH`                              | `webhookPath`                                      |
| `SMS_ALLOWED_USERS`                             | `allowFrom` (comma-separated)                      |
| `SMS_TEXT_CHUNK_LIMIT`                          | `textChunkLimit`                                   |
| `SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION`  | `dangerouslyDisableSignatureValidation` (`"true"`) |

```bash
export TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TWILIO_AUTH_TOKEN="<twilio-auth-token>"
export TWILIO_PHONE_NUMBER="+15551234567"
export SMS_PUBLIC_WEBHOOK_URL="https://gateway.example.com/webhooks/sms"
```

Then enable the channel in config:

```json5
{
  channels: {
    sms: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

### SecretRef auth token

`authToken` can be a SecretRef (`source: "env" | "file" | "exec"`). Use this when the Gateway should resolve the Twilio Auth Token from the OpenClaw secrets runtime instead of storing plaintext config:

```json5
{
  channels: {
    sms: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: { source: "env", provider: "default", id: "TWILIO_AUTH_TOKEN" },
      fromNumber: "+15551234567",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      dmPolicy: "pairing",
    },
  },
}
```

The referenced environment variable or secret provider must be visible to the Gateway runtime. Restart managed Gateway processes after changing host environment variables.

### Messaging Service sender

Use `messagingServiceSid` instead of `fromNumber` when Twilio should choose the sender through a Messaging Service:

```json5
{
  channels: {
    sms: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      dmPolicy: "pairing",
    },
  },
}
```

If both `fromNumber` and `messagingServiceSid` are present after config and env resolution, `fromNumber` is used.

### Default outbound target

Set `defaultTo` when automation or agent-initiated delivery should have a default destination if a send flow omits an explicit target:

```json5
{
  channels: {
    sms: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      fromNumber: "+15551234567",
      defaultTo: "+15557654321",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
    },
  },
}
```

## Access control

`channels.sms.dmPolicy` controls direct SMS access:

- `pairing` (default): unknown senders get a pairing code; approve with `openclaw pairing approve sms <CODE>`.
- `allowlist`: only senders in `allowFrom` are processed. An empty `allowFrom` rejects every sender (the Gateway logs a startup warning).
- `open`: config validation requires `allowFrom` to include `"*"`. Without the wildcard, only listed numbers can chat.
- `disabled`: all inbound DMs are dropped.

`allowFrom` entries should be E.164 phone numbers such as `+15551234567`. `sms:` and `twilio-sms:` prefixes are accepted and normalized. For a private assistant, prefer `dmPolicy: "allowlist"` with explicit phone numbers:

```json5
{
  channels: {
    sms: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      fromNumber: "+15551234567",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      dmPolicy: "allowlist",
      allowFrom: ["+15557654321"],
    },
  },
}
```

## Sending SMS

With the SMS channel selected, targets accept bare E.164 numbers or the `sms:` prefix:

```bash
openclaw message send --channel sms --target sms:+15551234567 --message "hello"
```

When channel selection is implicit, the `twilio-sms:` prefix selects this channel without taking over the `sms:` service prefix, which iMessage uses to pick carrier SMS delivery for its own targets:

```bash
openclaw message send --target twilio-sms:+15551234567 --message "hello"
```

The CLI requires an explicit `--target`. `defaultTo` is for automation and agent-initiated delivery paths where the target can be resolved from channel config.

Agent replies from inbound SMS conversations automatically go back to the sender through the configured Twilio sender.

SMS output is plain text. OpenClaw strips markdown, flattens fenced code blocks, rewrites links as `label (url)`, and splits long replies into chunks of at most `textChunkLimit` characters (default 1500) before sending them through Twilio.

## Verify Setup

After the Gateway starts:

1. Confirm the Gateway log shows the SMS webhook route.
2. Run a Twilio-side probe (checks the configured Twilio webhook URL/method and recent inbound errors):

```bash
openclaw channels capabilities --channel sms
openclaw channels status --channel sms --probe --json
```

3. Send an SMS to the Twilio number from your phone.
4. Run `openclaw pairing list sms`.
5. Approve the pairing code with `openclaw pairing approve sms <CODE>`.
6. Send another SMS and confirm the agent replies.

For outbound-only testing, use:

```bash
openclaw message send --channel sms --target sms:+15557654321 --message "OpenClaw SMS test"
```

### End-to-end test from macOS iMessage/SMS

On a Mac that can send carrier SMS through Messages, you can use `imsg` to drive the sender side without touching your phone:

```bash
imsg send --to "+15551234567" --service sms --text "OpenClaw SMS E2E $(date -u +%Y%m%dT%H%M%SZ)" --json
openclaw pairing list sms
openclaw pairing approve sms <CODE>
imsg send --to "+15551234567" --service sms --text "reply exactly SMS pong" --json
```

The first message should create a pairing request. The second message should receive the agent reply through Twilio.

## Webhook security

By default, OpenClaw validates `X-Twilio-Signature` using `publicWebhookUrl` and `authToken`. Keep the endpoint portion of `publicWebhookUrl` byte-for-byte aligned with the URL configured in Twilio, including scheme, host, path, and query string. OpenClaw excludes Twilio [connection-override](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides) fragments (`#...`) from signature computation, as Twilio requires.

The webhook route also enforces, independent of signature validation:

- `POST` only.
- Failed-request budget of 300 requests per minute per SMS account, webhook route, and resolved client address. All requests count toward this budget, but HTTP 429 is applied only after a request fails body parsing, Twilio validation, or AccountSid matching.
- Dispatchable callback rate limit of 30 accepted callbacks per minute per SMS account, webhook route, and resolved client address after those checks pass (HTTP 429 above that). If signature validation is disabled, this 30/min limit is the unauthenticated dispatch cap.
- Client addresses are resolved through the shared Gateway trusted-proxy rules. If `gateway.trustedProxies` contains the reverse proxy that forwards Twilio callbacks, OpenClaw keys these limits from the forwarded client address; otherwise it falls back to the direct socket address.
- The payload `AccountSid` must match the configured `accountSid` (HTTP 403 otherwise).
- Replayed `MessageSid` values are deduplicated for 10 minutes.
- Each SMS account's replay cache retains up to 10,000 live message SIDs. When every slot is live, new webhooks for that account fail closed with HTTP 429 and a `Retry-After` header until the oldest slot expires.
- Request bodies over 32 KB are rejected.

Twilio does not retry HTTP 429 by default or document support for `Retry-After`. The `#rp=4xx` and `#rp=all` connection overrides opt into 4xx retries, but Twilio caps the complete retry transaction at 15 seconds, so retries can still finish before a replay-cache slot expires. Configure a fallback URL when another handler must receive failed deliveries; treat a 429 as a fail-closed rejection, not reliable backpressure.

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

Each account must use a distinct `webhookPath`; the Gateway refuses to register a webhook route whose path is already owned by another account. `TWILIO_*`/`SMS_*` environment fallbacks apply only to the default account; set `defaultAccount` to change which account that is.

## Troubleshooting

### Twilio returns 403 or OpenClaw rejects the webhook

Check that `publicWebhookUrl` exactly matches the URL configured in Twilio, including scheme, host, path, and query string. Twilio signs the public URL string, so proxy rewrites and alternate hostnames can break signature validation.

A 403 with `Invalid account` means the inbound payload's `AccountSid` does not match the configured `accountSid`; check that the webhook points at the account that owns the number.

### No pairing request appears

Check the Twilio number's **Messaging** webhook URL and method. It must point to the SMS webhook URL and use `POST`. Also confirm the Gateway is reachable from the public internet or through your tunnel.

If the Twilio message log shows error `11200`, Twilio accepted the inbound SMS but could not reach your webhook. Check:

- Twilio **Messaging > A message comes in** points at `publicWebhookUrl`.
- The method is `POST`.
- The tunnel or reverse proxy exposes the exact `webhookPath`; for Tailscale Funnel, run `tailscale funnel status` and confirm `/webhooks/sms` is listed.
- `publicWebhookUrl` uses the same scheme, host, path, and query string Twilio sends, so signature validation can reproduce the signed URL.

`openclaw channels status --channel sms --probe` surfaces both mismatched Twilio webhook settings and recent `11200` errors.

### Outbound sends fail

Confirm `accountSid`, `authToken`, and either `fromNumber` or `messagingServiceSid` are resolved. If you use a trial Twilio account, the destination number may need to be verified in Twilio before outbound SMS will send.

### Twilio accepts the send but the message is undelivered

Check the final Twilio Message status and error code for the Message SID. Error [`30034`](https://www.twilio.com/docs/api/errors/30034) means the message was sent from a US 10DLC number that is not associated with an approved A2P 10DLC Campaign, or whose carrier-side number registration is still pending after Campaign approval. Complete Brand and Campaign registration, then make sure the sender number is attached to the Messaging Service for that approved Campaign.

### Messages arrive but the agent does not answer

Check `dmPolicy` and `allowFrom`. With the default `pairing` policy, the sender must be approved before normal agent turns are processed.
