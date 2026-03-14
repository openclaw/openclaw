---
summary: "SMS/MMS messaging via Twilio Programmable Messaging."
read_when:
  - Setting up Twilio SMS channel
  - Configuring SMS with OpenClaw
  - Troubleshooting Twilio webhook
title: "Twilio SMS"
---

# Twilio SMS

Status: plugin (installed separately). Sends and receives SMS/MMS via the Twilio Programmable Messaging REST API.

## Overview

- Uses Twilio's webhook-based architecture: inbound messages arrive as HTTP POST requests from Twilio, outbound replies are sent via the REST API.
- Supports SMS and MMS (inbound media attachments, outbound media URLs).
- DM-only (no group chats).
- Pairing/allowlist works the same way as other channels.
- Optional daily PIN authentication to mitigate SMS sender spoofing.

## Prerequisites

1. A [Twilio account](https://www.twilio.com/) with a phone number provisioned for SMS.
2. For US numbers sending to consumers: complete [A2P 10DLC registration](https://www.twilio.com/docs/messaging/guides/10dlc) to avoid message filtering.
3. A publicly accessible URL for receiving webhooks (the OpenClaw gateway must be reachable from the internet, e.g. via a reverse proxy, tunnel, or cloud deployment).

## Quick start

1. Run `openclaw onboard` and select Twilio SMS, or configure manually:

   ```json5
   {
     channels: {
       "twilio-sms": {
         accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
         authToken: "your_auth_token",
         phoneNumber: "+15551234567",
         webhookPath: "/twilio-sms/webhook",
       },
     },
   }
   ```

2. In the [Twilio Console](https://console.twilio.com/), set the phone number's "A Message Comes In" webhook URL to your gateway (e.g. `https://your-gateway-host:3000/twilio-sms/webhook`), method POST.
3. Start the gateway. Inbound SMS will be processed and agent replies sent back as outbound SMS.

## Access control

DMs:

- Default: `channels.twilio-sms.dmPolicy = "allowlist"`.
- Set `allowFrom` to a list of E.164 phone numbers that are allowed to message.
- Pairing mode: unknown senders receive a pairing code; approve via `openclaw pairing approve twilio-sms <CODE>`. Pairing approval requires CLI access and is not available in the Control UI. For headless deployments (Docker, Railway), pre-populate `allowFrom` instead.
- Open mode: any phone number can message (use with caution, especially without PIN auth).

```json5
{
  channels: {
    "twilio-sms": {
      dmPolicy: "allowlist",
      allowFrom: ["+15559876543"],
    },
  },
}
```

## PIN authentication (spoofing mitigation)

SMS sender IDs are trivially spoofable. Optional daily PIN authentication adds a defense layer:

- First message each day must contain the PIN (as the full body, or as a prefix followed by a space).
- The PIN is stripped before routing to the agent.
- Session is unlocked for 24 hours per sender (in-memory; resets on gateway restart).
- The PIN is never logged or included in agent context.

```json5
{
  channels: {
    "twilio-sms": {
      pinAuth: true,
      pin: "1234",
    },
  },
}
```

## Webhook signature verification

Twilio signs every webhook request with an HMAC-SHA1 signature. OpenClaw validates this signature automatically using your `authToken`. This prevents unauthorized parties from sending fake inbound messages to your webhook endpoint.

If you are behind a reverse proxy that rewrites the URL, set `webhookUrl` to the public URL that Twilio sees:

```json5
{
  channels: {
    "twilio-sms": {
      webhookUrl: "https://your-public-domain.com/twilio-sms/webhook",
    },
  },
}
```

To disable signature validation (not recommended; useful for local development):

```json5
{
  channels: {
    "twilio-sms": {
      skipSignatureValidation: true,
    },
  },
}
```

## Media (MMS)

- Inbound MMS attachments are downloaded from Twilio (authenticated) and stored in the media cache.
- Outbound media is sent via Twilio's `MediaUrl` parameter.
- Media cap via `channels.twilio-sms.mediaMaxMb` (default: 5 MB per Twilio's MMS limit).

## Onboarding

Twilio SMS is available in the interactive setup wizard:

```
openclaw onboard
```

The wizard prompts for:

- **Account SID** (required): Your Twilio Account SID (starts with `AC`).
- **Auth Token** (required): Your Twilio Auth Token.
- **Phone Number** (required): Your Twilio phone number in E.164 format (e.g. `+15551234567`).
- **DM policy**: allowlist, pairing, or open.
- **PIN auth**: Optional daily PIN for SMS spoofing mitigation.

## Configuration reference

Provider options:

- `channels.twilio-sms.accountSid`: Twilio Account SID (starts with `AC`).
- `channels.twilio-sms.authToken`: Twilio Auth Token.
- `channels.twilio-sms.phoneNumber`: Twilio phone number in E.164 format.
- `channels.twilio-sms.webhookPath`: Webhook endpoint path (default: `/twilio-sms/webhook`).
- `channels.twilio-sms.webhookUrl`: Public URL for webhook signature verification (set if behind a proxy).
- `channels.twilio-sms.dmPolicy`: `pairing | allowlist | open` (default: `allowlist`).
- `channels.twilio-sms.allowFrom`: DM allowlist of E.164 phone numbers.
- `channels.twilio-sms.pinAuth`: Enable daily PIN authentication (default: `false`).
- `channels.twilio-sms.pin`: PIN value (required when `pinAuth` is `true`).
- `channels.twilio-sms.skipSignatureValidation`: Disable Twilio webhook signature verification (default: `false`).
- `channels.twilio-sms.textChunkLimit`: Outbound chunk size in chars (default: 1600, Twilio's per-message limit).
- `channels.twilio-sms.accounts`: Multi-account configuration (for multiple Twilio numbers).

## Multi-account

To use multiple Twilio phone numbers, configure named accounts:

```json5
{
  channels: {
    "twilio-sms": {
      accounts: {
        personal: {
          accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          authToken: "token_1",
          phoneNumber: "+15551111111",
          webhookPath: "/twilio-sms/personal",
        },
        work: {
          accountSid: "ACyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
          authToken: "token_2",
          phoneNumber: "+15552222222",
          webhookPath: "/twilio-sms/work",
        },
      },
    },
  },
}
```

Each account gets its own webhook path and independent allowlist/PIN auth settings.

## Troubleshooting

- **Messages not arriving**: Verify the webhook URL in the Twilio Console matches your gateway's public URL + `webhookPath`. Check `openclaw status --deep` for connectivity.
- **Signature verification failing**: If behind a proxy, set `webhookUrl` to the public URL Twilio sees. Or temporarily set `skipSignatureValidation: true` to diagnose.
- **Messages filtered/blocked by carrier**: For US numbers, complete A2P 10DLC registration in the Twilio Console.
- **Long messages truncated**: Twilio's per-segment limit is 1600 characters. OpenClaw auto-chunks at this boundary.
- **PIN auth not working**: Ensure `pinAuth: true` and `pin` are both set. PIN session resets on gateway restart.

For general channel workflow reference, see [Channels](/channels) and the [Plugins](/tools/plugin) guide.
