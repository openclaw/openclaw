---
summary: "Create the Telegram bot token, configure the channel, and approve the first DM"
read_when:
  - Connecting a Telegram bot to OpenClaw for the first time
  - Adding the bot to a group and finding the group chat ID
  - Setting BotFather privacy mode and group permissions
title: "Telegram setup"
sidebarTitle: "Setup"
---

Create the bot in BotFather, give OpenClaw its token, approve the first DM, and add the bot to a group.

## Quick setup

<Steps>
  <Step title="Create the bot token in BotFather">
    Both flows end with a token you paste into OpenClaw — pick one:

    - **Chat flow**: open Telegram and chat with **@BotFather**. Confirm the handle is exactly `@BotFather`. Run `/newbot`, follow the prompts, and save the token.
    - **Web flow**: open [BotFather's web app](https://t.me/BotFather?startapp). It runs in every Telegram client, including [web.telegram.org](https://web.telegram.org). Create the bot in the UI, then copy its token.

  </Step>

  <Step title="Configure token and DM policy">
    The fastest option is the CLI. It writes the token into your config for you:

```bash
openclaw channels add --channel telegram --token <bot-token>
```

    To edit config by hand instead, put this in `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

    Env fallback: `TELEGRAM_BOT_TOKEN` (default account only). Named accounts must use `botToken` or `tokenFile`.
    Telegram does **not** use `openclaw channels login telegram`. Set the token in config or env, then start the gateway.

  </Step>

  <Step title="Restart the gateway">
    A new channel is only picked up after the Gateway loads the new config:

```bash
openclaw gateway restart
```

    Use `openclaw gateway` instead when no Gateway service is installed. That
    command runs the Gateway in the foreground of this terminal.

  </Step>

  <Step title="Approve your first DM">
    Open Telegram and send any message to your bot. That message creates the
    pairing request the next command lists:

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

    Pairing codes expire after 1 hour.

  </Step>

  <Step title="Add the bot to a group">
    Add the bot to your group, then get the two IDs group access needs:

    - your Telegram user ID, for `allowFrom` / `groupAllowFrom`
    - the Telegram group chat ID, as the key under `channels.telegram.groups`

    Get the group chat ID from `openclaw logs --follow`, a forwarded-ID bot, or Bot API `getUpdates`. After the group is allowed, `/whoami@<bot_username>` confirms the user and group IDs.

    Negative supergroup IDs starting with `-100` are group chat IDs. They go under `channels.telegram.groups`, not `groupAllowFrom`.

  </Step>
</Steps>

<Note>
Token resolution is account-aware. `tokenFile` beats `botToken`, and `botToken` beats env. Config always wins over `TELEGRAM_BOT_TOKEN`, which only resolves for the default account. After a successful startup, OpenClaw caches the bot identity for up to 24 hours, so restarts skip an extra `getMe` call. Changing or removing the token clears that cache.
</Note>

## Telegram side settings

<AccordionGroup>
  <Accordion title="Privacy mode and group visibility">
    Telegram bots default to **Privacy Mode**, which limits which group messages they receive.

    To see all group messages, either:

    - disable privacy mode via `/setprivacy`, or
    - make the bot a group admin.

    After toggling privacy mode, remove and re-add the bot in each group so Telegram applies the change.

  </Accordion>

  <Accordion title="Group permissions">
    Admin status is controlled in Telegram group settings. Admin bots receive all group messages, useful for always-on group behavior.
  </Accordion>

  <Accordion title="Helpful BotFather toggles">

    - `/setjoingroups` — allow/deny group adds
    - `/setprivacy` — group visibility behavior

    The same settings are available in [BotFather's web app](https://t.me/BotFather?startapp) if you prefer a UI over chat commands.

  </Accordion>
</AccordionGroup>
