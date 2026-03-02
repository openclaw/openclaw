---
title: Telegram Userbot
description: Connect your own Telegram user account to OpenClaw via MTProto.
summary: "Telegram userbot setup, configuration, security, and troubleshooting"
read_when:
  - You want to connect a personal Telegram account (not a bot)
  - You need user-level Telegram capabilities (delete others' messages, read history, custom reactions)
---

# Telegram Userbot (MTProto)

The `telegram-userbot` channel connects your **personal Telegram account** via the MTProto protocol (GramJS). Unlike the [Telegram bot channel](/channels/telegram), this runs as your user account with full user-level capabilities.

<Warning>
Using a userbot may violate Telegram's Terms of Service. Use a **dedicated secondary account** and conservative rate limits. See [Security and risks](#security-and-risks) below.
</Warning>

<CardGroup cols={3}>
  <Card title="Telegram (Bot API)" icon="robot" href="/channels/telegram">
    The standard bot-based Telegram channel.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair playbooks.
  </Card>
  <Card title="Gateway configuration" icon="settings" href="/gateway/configuration">
    Full channel config patterns and examples.
  </Card>
</CardGroup>

## Bot vs userbot

| Feature                 | Bot API (`telegram`)      | Userbot (`telegram-userbot`) |
| ----------------------- | ------------------------- | ---------------------------- |
| Protocol                | Bot API (HTTPS)           | MTProto (GramJS)             |
| Identity                | Bot account               | Personal user account        |
| Delete others' messages | No (admin-only in groups) | Yes (DMs + admin groups)     |
| Read full chat history  | No                        | Yes                          |
| Custom reactions        | Limited                   | Full                         |
| Initiate conversations  | No (user must `/start`)   | Yes                          |
| Rate limits             | Stricter                  | More generous                |
| Files as documents      | Auto-compressed           | Preserved                    |
| Risk of ban             | None                      | Possible (ToS)               |

Both channels can run simultaneously. Configure each independently and OpenClaw routes messages to the correct channel.

## Prerequisites

<Steps>
  <Step title="Get API credentials from my.telegram.org">
    1. Go to [my.telegram.org](https://my.telegram.org) and log in with your phone number.
    2. Click **API development tools**.
    3. Create a new application (any name/description).
    4. Note the **App api_id** (numeric) and **App api_hash** (string).

    These credentials identify your application to Telegram. They are **not** your account password.

  </Step>

  <Step title="(Recommended) Use a secondary account">
    Create a separate Telegram account for the userbot to limit risk to your primary account. Any Telegram account with a phone number works.
  </Step>
</Steps>

## Quick setup

<Steps>
  <Step title="Install the plugin">
    If the telegram-userbot extension is not bundled with your OpenClaw install:

```bash
openclaw plugins install telegram-userbot
```

  </Step>

  <Step title="Configure credentials">

```json5
{
  channels: {
    "telegram-userbot": {
      apiId: 12345678,
      apiHash: "your_api_hash_here",
      allowFrom: [123456789], // your Telegram user ID
    },
  },
}
```

  </Step>

  <Step title="Start gateway and authenticate">

```bash
openclaw gateway run
```

    On first run, you will be prompted to enter your phone number and verification code. The session is saved and reused on subsequent starts.

  </Step>

  <Step title="Verify connection">

```bash
openclaw channels status --probe
```

    The status should show `telegram-userbot` as connected with your username.

  </Step>
</Steps>

## Configuration reference

All options live under `channels.telegram-userbot` in `openclaw.json`:

### Required

| Key       | Type     | Description                            |
| --------- | -------- | -------------------------------------- |
| `apiId`   | `number` | Telegram API ID from my.telegram.org   |
| `apiHash` | `string` | Telegram API hash from my.telegram.org |

### Access control

| Key         | Type                   | Default | Description                                         |
| ----------- | ---------------------- | ------- | --------------------------------------------------- |
| `allowFrom` | `(number \| string)[]` | —       | Allowed sender IDs (numeric) or `@username` strings |
| `enabled`   | `boolean`              | `true`  | Enable or disable the channel                       |

### Rate limiting

| Key                           | Type               | Default     | Description                      |
| ----------------------------- | ------------------ | ----------- | -------------------------------- |
| `rateLimit.messagesPerSecond` | `number`           | `20`        | Global outbound rate limit       |
| `rateLimit.perChatPerSecond`  | `number`           | `1`         | Per-chat outbound rate limit     |
| `rateLimit.jitterMs`          | `[number, number]` | `[50, 200]` | Random delay range between sends |

### Reconnection

| Key                            | Type     | Default         | Description                        |
| ------------------------------ | -------- | --------------- | ---------------------------------- |
| `reconnect.maxAttempts`        | `number` | `-1` (infinite) | Max reconnect attempts             |
| `reconnect.alertAfterFailures` | `number` | `3`             | Alert after N consecutive failures |

### Capabilities

| Key                                | Type      | Default | Description                                  |
| ---------------------------------- | --------- | ------- | -------------------------------------------- |
| `capabilities.deleteOtherMessages` | `boolean` | `true`  | Allow deleting messages sent by others       |
| `capabilities.readHistory`         | `boolean` | `true`  | Mark conversations as read                   |
| `capabilities.forceDocument`       | `boolean` | `true`  | Send files as documents (no auto-conversion) |

### Action gates

| Key                 | Type      | Default | Description                       |
| ------------------- | --------- | ------- | --------------------------------- |
| `actions.messages`  | `boolean` | `true`  | Enable delete/edit/unsend actions |
| `actions.reactions` | `boolean` | `true`  | Enable react action               |
| `actions.pins`      | `boolean` | `true`  | Enable pin action                 |

### Full example

```json5
{
  channels: {
    "telegram-userbot": {
      apiId: 12345678,
      apiHash: "abc123def456",
      allowFrom: [123456789, "@myusername"],
      rateLimit: {
        messagesPerSecond: 10,
        perChatPerSecond: 1,
        jitterMs: [100, 300],
      },
      reconnect: {
        maxAttempts: 10,
        alertAfterFailures: 5,
      },
      capabilities: {
        deleteOtherMessages: true,
        readHistory: true,
        forceDocument: true,
      },
      actions: {
        messages: true,
        reactions: true,
        pins: true,
      },
    },
  },
}
```

## Coexistence with Telegram Bot

Both `telegram` (Bot API) and `telegram-userbot` (MTProto) can run simultaneously:

```json5
{
  channels: {
    telegram: {
      botToken: "123:abc",
      dmPolicy: "pairing",
    },
    "telegram-userbot": {
      apiId: 12345678,
      apiHash: "abc123",
      allowFrom: [123456789],
    },
  },
}
```

The agent selects which channel to use for outbound messages via the `channel` parameter in the message tool. Inbound messages route to the channel that received them.

## Message actions

The userbot supports these agent actions:

| Action              | Description                     | Parameters                                          |
| ------------------- | ------------------------------- | --------------------------------------------------- |
| `delete` / `unsend` | Delete a message (both parties) | `to`, `messageId`                                   |
| `edit`              | Edit message text               | `to`, `messageId`, `text` (or `newText`, `message`) |
| `react`             | Add emoji reaction              | `to`, `messageId`, `emoji`                          |
| `pin`               | Pin a message                   | `to`, `messageId`                                   |

Target (`to`) accepts numeric chat IDs or `@username`. If omitted, the current conversation context is used.

## Security and risks

<Warning>
Telegram userbots operate under your personal account. Telegram may restrict or ban accounts that exhibit bot-like behavior.
</Warning>

### Best practices

1. **Use a dedicated secondary account.** Never run a userbot on your primary Telegram account.
2. **Keep rate limits conservative.** The defaults are designed to avoid triggering flood detection.
3. **Do not spam.** Avoid sending messages to users who have not consented.
4. **Monitor for flood waits.** If Telegram returns `FLOOD_WAIT`, OpenClaw backs off automatically. Frequent flood waits indicate you should reduce activity.
5. **Protect session files.** The MTProto session stored in `~/.openclaw/sessions/` contains your account credentials. Treat it like a password.

### Session security

- Sessions persist across restarts (no re-authentication needed).
- If your session is compromised, terminate it immediately from Telegram Settings > Devices.
- Rotate API credentials at my.telegram.org if you suspect a leak.

## Troubleshooting

<AccordionGroup>
  <Accordion title="Session invalid or expired">
    Telegram may invalidate your session if you log in from too many devices or if the session is idle for an extended period.

    Fix: restart the gateway and re-authenticate when prompted.

```bash
openclaw gateway run
```

  </Accordion>

  <Accordion title="FLOOD_WAIT errors">
    Telegram rate-limits accounts that send too many requests.

    - OpenClaw automatically waits the required duration.
    - If this happens frequently, reduce `rateLimit.messagesPerSecond` and `rateLimit.perChatPerSecond`.
    - Monitor with `openclaw channels status --probe`.

  </Accordion>

  <Accordion title="Connection drops or reconnect loops">
    - Check network connectivity to Telegram servers.
    - Review `reconnect.maxAttempts` and `reconnect.alertAfterFailures` settings.
    - OpenClaw auto-reconnects by default (infinite retries).
    - If reconnection fails repeatedly, check if your session is still valid.
  </Accordion>

  <Accordion title="Account restricted or banned">
    Telegram may restrict accounts that violate ToS.

    - If restricted, you will see auth errors on connect.
    - Use a secondary account to minimize impact.
    - Reduce message frequency and avoid unsolicited messages.
    - There is no automated way to appeal; contact Telegram support.

  </Accordion>

  <Accordion title="Authentication errors">
    - Verify `apiId` and `apiHash` are correct (from my.telegram.org).
    - Ensure the phone number matches the account you intend to use.
    - If 2FA is enabled, you will be prompted for your password during setup.
  </Accordion>
</AccordionGroup>

More help: [Channel troubleshooting](/channels/troubleshooting).

## Related

- [Telegram (Bot API)](/channels/telegram)
- [Channel routing](/channels/channel-routing)
- [Troubleshooting](/channels/troubleshooting)
