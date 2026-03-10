---
summary: "GoHighLevel CRM channel support, capabilities, and configuration"
read_when:
  - Working on GoHighLevel channel features
  - Setting up GHL CRM integration
title: "GoHighLevel"
---

# GoHighLevel (plugin)

Status: text DMs via GHL Conversations API webhook; supports SMS, webchat, email, Instagram, Facebook, and Google My Business message types. Escalation tagging is built in.

## Plugin required

GoHighLevel ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):

```bash
openclaw plugins install @openclaw/gohighlevel
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/gohighlevel
```

If you choose GoHighLevel during configure/onboarding and a git checkout is detected,
OpenClaw will offer the local install path automatically.

Details: [Plugins](/tools/plugin)

## Quick setup (beginner)

1. Install the GoHighLevel plugin.
2. Create a **Private Integration Token** in your GHL sub-account (Settings > Integrations > Private Integrations).
3. Note your **Location ID** (visible in Settings > Business Profile or the URL bar when logged in).
4. Create a **GHL Workflow** with a "Customer Replied" trigger that sends a webhook to your gateway.
5. Configure OpenClaw with the API key and Location ID.
6. Start the gateway. GHL will POST customer replies to your webhook path.

Minimal config:

```json5
{
  channels: {
    gohighlevel: {
      enabled: true,
      apiKey: "<PRIVATE_INTEGRATION_TOKEN>",
      locationId: "<LOCATION_ID>",
    },
  },
}
```

Or use environment variables for the default account:

```bash
export GHL_API_KEY="pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export GHL_LOCATION_ID="xxxxxxxxxxxxxxxxxxxxxxxx"
```

`GHL_TOKEN` is accepted as a fallback for `GHL_API_KEY`.

## Webhook setup

GoHighLevel does not push raw inbound messages by default. You need a **Workflow** to forward them.

### Creating the Workflow

1. In your GHL sub-account, go to **Automation > Workflows**.
2. Create a new workflow.
3. Add a **trigger**: select **Customer Replied**.
4. Add an **action**: select **Webhook / Custom Webhook**.
5. Set the webhook URL to your gateway's public URL followed by the webhook path (default: `/gohighlevel`).
   - Example: `https://your-gateway.example.com/gohighlevel`
   - Run `openclaw status` to find your gateway's public URL.
6. Save and publish the workflow.

### Custom webhook path

Override the default `/gohighlevel` path:

```json5
{
  channels: {
    gohighlevel: {
      webhookPath: "/my-custom-ghl-path",
    },
  },
}
```

Or use `webhookUrl` to extract the path from a full URL:

```json5
{
  channels: {
    gohighlevel: {
      webhookUrl: "https://your-gateway.example.com/my-custom-ghl-path",
    },
  },
}
```

### Webhook signature verification

If you configure a webhook secret in GHL, set it in OpenClaw to verify HMAC-SHA256 signatures:

```json5
{
  channels: {
    gohighlevel: {
      webhookSecret: "<YOUR_WEBHOOK_SECRET>",
    },
  },
}
```

When a secret is configured, requests without a valid `X-GHL-Signature` header are rejected with 401.

## DM policy

GoHighLevel conversations are always direct (1:1 with contacts). The DM policy controls who can reach your bot.

| Policy           | Behavior                                       |
| ---------------- | ---------------------------------------------- |
| `open` (default) | Any contact can message the bot                |
| `allowlist`      | Only contacts in `dm.allowFrom` can message    |
| `pairing`        | New contacts must be approved via pairing code |

```json5
{
  channels: {
    gohighlevel: {
      dm: {
        policy: "allowlist",
        allowFrom: ["<contactId1>", "+15551234567"],
      },
    },
  },
}
```

See [Pairing](/channels/pairing) for details on the pairing flow.

## Escalation tagging

When the AI replies with a phrase that signals the conversation needs human attention, OpenClaw automatically tags the GHL contact for handoff.

Default trigger phrases:

- "let me look into that for you"
- "i'll get back to you shortly"
- "let me check on that"

The default tag applied is `escalation`. Use GHL automations to route tagged contacts to a human agent.

### Configuration

```json5
{
  channels: {
    gohighlevel: {
      escalation: {
        enabled: true, // default: true
        tag: "needs-human", // default: "escalation"
        patterns: ["let me transfer you", "i need to check with my team"],
      },
    },
  },
}
```

Set `escalation.enabled: false` to disable tagging entirely.

## Multi-account support

Run multiple GHL sub-accounts from one gateway:

```json5
{
  channels: {
    gohighlevel: {
      enabled: true,
      accounts: {
        clinic: {
          apiKey: "<CLINIC_TOKEN>",
          locationId: "<CLINIC_LOCATION>",
          webhookPath: "/ghl-clinic",
        },
        realty: {
          apiKey: "<REALTY_TOKEN>",
          locationId: "<REALTY_LOCATION>",
          webhookPath: "/ghl-realty",
        },
      },
    },
  },
}
```

Each account gets its own webhook path and credentials.

## Media attachments

Inbound media attachments (images, files) from GHL webhook payloads are downloaded and passed to the agent. Configure the maximum download size:

```json5
{
  channels: {
    gohighlevel: {
      mediaMaxMb: 20, // default: 20 MB
    },
  },
}
```

## Message types

GHL supports multiple message types. The type from the inbound webhook is preserved and used for outbound replies:

- `SMS` (default)
- `Email`
- `WhatsApp`
- `GMB` (Google My Business)
- `IG` (Instagram)
- `FB` (Facebook)
- `Custom`
- `Live_Chat`

## Capabilities

| Feature                     | Supported           |
| --------------------------- | ------------------- |
| Text messages               | Yes                 |
| Media attachments (inbound) | Yes                 |
| Reactions                   | No                  |
| Threads                     | No                  |
| Group chats                 | No                  |
| Streaming                   | Blocked (coalesced) |

Text replies are chunked at 1600 characters by default.

## Troubleshooting

### Webhook not receiving messages

- Verify the GHL Workflow is published and the "Customer Replied" trigger is active.
- Check that the webhook URL matches your gateway's public URL + webhook path.
- Run `openclaw status --deep` to verify the webhook is registered and probing succeeds.

### Authentication errors

- Ensure your Private Integration Token is valid and has the required scopes (Conversations, Contacts).
- Check that the Location ID matches the sub-account where the token was created.
- `GHL API 401` in logs means the token is invalid or expired.

### Escalation tags not appearing

- Confirm `escalation.enabled` is not set to `false`.
- Check that the AI reply text contains one of the configured trigger patterns (case-insensitive substring match).
- Verify the API key has permission to update contact tags.
