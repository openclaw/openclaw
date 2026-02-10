---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Slack setup for socket or HTTP webhook mode"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when: "Setting up Slack or debugging Slack socket/HTTP mode"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Slack"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Slack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Socket mode (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Quick setup (beginner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a Slack app and enable **Socket Mode**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create an **App Token** (`xapp-...`) and **Bot Token** (`xoxb-...`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Set tokens for OpenClaw and start the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    slack: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      appToken: "xapp-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botToken: "xoxb-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a Slack app (From scratch) in [https://api.slack.com/apps](https://api.slack.com/apps).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Socket Mode** → toggle on. Then go to **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** with scope `connections:write`. Copy the **App Token** (`xapp-...`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **OAuth & Permissions** → add bot token scopes (use the manifest below). Click **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-...`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Optional: **OAuth & Permissions** → add **User Token Scopes** (see the read-only list below). Reinstall the app and copy the **User OAuth Token** (`xoxp-...`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Event Subscriptions** → enable events and subscribe to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `message.*` (includes edits/deletes/thread broadcasts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `app_mention`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `reaction_added`, `reaction_removed`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `member_joined_channel`, `member_left_channel`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `channel_rename`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `pin_added`, `pin_removed`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Invite the bot to channels you want it to read.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. Slash Commands → create `/openclaw` if you use `channels.slack.slashCommand`. If you enable native commands, add one slash command per built-in command (same names as `/help`). Native defaults to off for Slack unless you set `channels.slack.commands.native: true` (global `commands.native` is `"auto"` which leaves Slack off).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. App Home → enable the **Messages Tab** so users can DM the bot.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the manifest below so scopes and events stay in sync.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account support: use `channels.slack.accounts` with per-account tokens and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OpenClaw config (Socket mode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set tokens via env vars (recommended):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SLACK_APP_TOKEN=xapp-...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SLACK_BOT_TOKEN=xoxb-...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or via config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    slack: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      appToken: "xapp-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botToken: "xoxb-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### User token (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can use a Slack user token (`xoxp-...`) for read operations (history,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pins, reactions, emoji, member info). By default this stays read-only: reads（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prefer the user token when present, and writes still use the bot token unless（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
you explicitly opt in. Even with `userTokenReadOnly: false`, the bot token stays（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
preferred for writes when it is available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
User tokens are configured in the config file (no env var support). For（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
multi-account, set `channels.slack.accounts.<id>.userToken`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example with bot + app + user tokens:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    slack: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      appToken: "xapp-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botToken: "xoxb-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      userToken: "xoxp-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example with userTokenReadOnly explicitly set (allow user token writes):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    slack: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      appToken: "xapp-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botToken: "xoxb-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      userToken: "xoxp-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      userTokenReadOnly: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Token usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Read operations (history, reactions list, pins list, emoji list, member info,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  search) prefer the user token when configured, otherwise the bot token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Write operations (send/edit/delete messages, add/remove reactions, pin/unpin,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  file uploads) use the bot token by default. If `userTokenReadOnly: false` and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  no bot token is available, OpenClaw falls back to the user token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### History context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.slack.historyLimit` (or `channels.slack.accounts.*.historyLimit`) controls how many recent channel/group messages are wrapped into the prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Falls back to `messages.groupChat.historyLimit`. Set `0` to disable (default 50).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## HTTP mode (Events API)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use HTTP webhook mode when your Gateway is reachable by Slack over HTTPS (typical for server deployments).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
HTTP mode uses the Events API + Interactivity + Slash Commands with a shared request URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Setup (HTTP mode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a Slack app and **disable Socket Mode** (optional if you only use HTTP).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Basic Information** → copy the **Signing Secret**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **OAuth & Permissions** → install the app and copy the **Bot User OAuth Token** (`xoxb-...`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Event Subscriptions** → enable events and set the **Request URL** to your gateway webhook path (default `/slack/events`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Interactivity & Shortcuts** → enable and set the same **Request URL**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Slash Commands** → set the same **Request URL** for your command(s).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example request URL:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`https://gateway-host/slack/events`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OpenClaw config (minimal)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    slack: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mode: "http",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botToken: "xoxb-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      signingSecret: "your-signing-secret",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      webhookPath: "/slack/events",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account HTTP mode: set `channels.slack.accounts.<id>.mode = "http"` and provide a unique（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`webhookPath` per account so each Slack app can point to its own URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Manifest (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this Slack app manifest to create the app quickly (adjust the name/command if you want). Include the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
user scopes if you plan to configure a user token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "display_information": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "name": "OpenClaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "description": "Slack connector for OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "features": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "bot_user": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "display_name": "OpenClaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "always_online": false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "app_home": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "messages_tab_enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "messages_tab_read_only_enabled": false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "slash_commands": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "command": "/openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "description": "Send a message to OpenClaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "should_escape": false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "oauth_config": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "scopes": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "bot": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "chat:write",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "channels:history",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "channels:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "groups:history",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "groups:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "groups:write",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "im:history",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "im:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "im:write",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "mpim:history",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "mpim:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "mpim:write",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "users:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "app_mentions:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "reactions:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "reactions:write",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "pins:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "pins:write",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "commands",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "files:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "files:write"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "user": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "channels:history",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "channels:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "groups:history",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "groups:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "im:history",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "im:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "mpim:history",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "mpim:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "users:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "reactions:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "pins:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji:read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "search:read"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "settings": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "socket_mode_enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "event_subscriptions": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "bot_events": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "app_mention",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "message.channels",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "message.groups",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "message.im",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "message.mpim",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "reaction_added",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "reaction_removed",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "member_joined_channel",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "member_left_channel",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "channel_rename",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "pin_added",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "pin_removed"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you enable native commands, add one `slash_commands` entry per command you want to expose (matching the `/help` list). Override with `channels.slack.commands.native`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Scopes (current vs optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Slack's Conversations API is type-scoped: you only need the scopes for the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
conversation types you actually touch (channels, groups, im, mpim). See（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) for the overview.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Bot token scopes (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chat:write` (send/update/delete messages via `chat.postMessage`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `im:write` (open DMs via `conversations.open` for user DMs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels:history`, `groups:history`, `im:history`, `mpim:history`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels:read`, `groups:read`, `im:read`, `mpim:read`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `users:read` (user lookup)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `emoji:read` (`emoji.list`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `files:write` (uploads via `files.uploadV2`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### User token scopes (optional, read-only by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add these under **User Token Scopes** if you configure `channels.slack.userToken`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels:history`, `groups:history`, `im:history`, `mpim:history`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels:read`, `groups:read`, `im:read`, `mpim:read`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `users:read`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `reactions:read`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pins:read`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `emoji:read`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `search:read`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Not needed today (but likely future)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mpim:write` (only if we add group-DM open/DM start via `conversations.open`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `groups:write` (only if we add private-channel management: create/rename/invite/archive)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chat:write.public` (only if we want to post to channels the bot isn't in)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `users:read.email` (only if we need email fields from `users.info`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `files:read` (only if we start listing/reading file metadata)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Slack uses Socket Mode only (no HTTP webhook server). Provide both tokens:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "slack": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "botToken": "xoxb-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "appToken": "xapp-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "groupPolicy": "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "dm": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "policy": "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "allowFrom": ["U123", "U456", "*"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "groupEnabled": false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "groupChannels": ["G123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "replyToMode": "all"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "channels": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "C123": { "allow": true, "requireMention": true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "#general": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "allow": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requireMention": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "users": ["U123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "skills": ["search", "docs"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "systemPrompt": "Keep answers short."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "reactionNotifications": "own",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "reactionAllowlist": ["U123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "replyToMode": "off",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "actions": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "reactions": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "messages": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "pins": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "memberInfo": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "emojiList": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "slashCommand": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "name": "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "sessionPrefix": "slack:slash",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "ephemeral": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "textChunkLimit": 4000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "mediaMaxMb": 20（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tokens can also be supplied via env vars:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SLACK_BOT_TOKEN`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SLACK_APP_TOKEN`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ack reactions are controlled globally via `messages.ackReaction` +（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`messages.ackReactionScope`. Use `messages.removeAckAfterReply` to clear the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ack reaction after the bot replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Outbound text is chunked to `channels.slack.textChunkLimit` (default 4000).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional newline chunking: set `channels.slack.chunkMode="newline"` to split on blank lines (paragraph boundaries) before length chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media uploads are capped by `channels.slack.mediaMaxMb` (default 20).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reply threading（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, OpenClaw replies in the main channel. Use `channels.slack.replyToMode` to control automatic threading:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Mode    | Behavior                                                                                                                                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `off`   | **Default.** Reply in main channel. Only thread if the triggering message was already in a thread.                                                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `first` | First reply goes to thread (under the triggering message), subsequent replies go to main channel. Useful for keeping context visible while avoiding thread clutter. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `all`   | All replies go to thread. Keeps conversations contained but may reduce visibility.                                                                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The mode applies to both auto-replies and agent tool calls (`slack sendMessage`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Per-chat-type threading（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can configure different threading behavior per chat type by setting `channels.slack.replyToModeByChatType`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    slack: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      replyToMode: "off", // default for channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      replyToModeByChatType: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        direct: "all", // DMs always thread（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        group: "first", // group DMs/MPIM thread first reply（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Supported chat types:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `direct`: 1:1 DMs (Slack `im`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group`: group DMs / MPIMs (Slack `mpim`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channel`: standard channels (public/private)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Precedence:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `replyToModeByChatType.<chatType>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `replyToMode`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Provider default (`off`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy `channels.slack.dm.replyToMode` is still accepted as a fallback for `direct` when no chat-type override is set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Thread DMs only:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    slack: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      replyToMode: "off",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      replyToModeByChatType: { direct: "all" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Thread group DMs but keep channels in the root:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    slack: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      replyToMode: "off",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      replyToModeByChatType: { group: "first" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Make channels thread, keep DMs in the root:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    slack: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      replyToMode: "first",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      replyToModeByChatType: { direct: "off", group: "off" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Manual threading tags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For fine-grained control, use these tags in agent responses:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `[[reply_to_current]]` — reply to the triggering message (start/continue thread).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `[[reply_to:<id>]]` — reply to a specific message id.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sessions + routing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DMs share the `main` session (like WhatsApp/Telegram).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels map to `agent:<agentId>:slack:channel:<channelId>` sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slash commands use `agent:<agentId>:slack:slash:<userId>` sessions (prefix configurable via `channels.slack.slashCommand.sessionPrefix`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If Slack doesn’t provide `channel_type`, OpenClaw infers it from the channel ID prefix (`D`, `C`, `G`) and defaults to `channel` to keep session keys stable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Native command registration uses `commands.native` (global default `"auto"` → Slack off) and can be overridden per-workspace with `channels.slack.commands.native`. Text commands require standalone `/...` messages and can be disabled with `commands.text: false`. Slack slash commands are managed in the Slack app and are not removed automatically. Use `commands.useAccessGroups: false` to bypass access-group checks for commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full command list + config: [Slash commands](/tools/slash-commands)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## DM security (pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.slack.dm.policy="pairing"` — unknown DM senders get a pairing code (expires after 1 hour).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approve via: `openclaw pairing approve slack <code>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To allow anyone: set `channels.slack.dm.policy="open"` and `channels.slack.dm.allowFrom=["*"]`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.slack.dm.allowFrom` accepts user IDs, @handles, or emails (resolved at startup when tokens allow). The wizard accepts usernames and resolves them to ids during setup when tokens allow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Group policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.slack.groupPolicy` controls channel handling (`open|disabled|allowlist`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowlist` requires channels to be listed in `channels.slack.channels`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you only set `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` and never create a `channels.slack` section,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the runtime defaults `groupPolicy` to `open`. Add `channels.slack.groupPolicy`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `channels.defaults.groupPolicy`, or a channel allowlist to lock it down.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The configure wizard accepts `#channel` names and resolves them to IDs when possible（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (public + private); if multiple matches exist, it prefers the active channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On startup, OpenClaw resolves channel/user names in allowlists to IDs (when tokens allow)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and logs the mapping; unresolved entries are kept as typed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To allow **no channels**, set `channels.slack.groupPolicy: "disabled"` (or keep an empty allowlist).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Channel options (`channels.slack.channels.<id>` or `channels.slack.channels.<name>`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allow`: allow/deny the channel when `groupPolicy="allowlist"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requireMention`: mention gating for the channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools`: optional per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `toolsBySender`: optional per-sender tool policy overrides within the channel (keys are sender ids/@handles/emails; `"*"` wildcard supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowBots`: allow bot-authored messages in this channel (default: false).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `users`: optional per-channel user allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `skills`: skill filter (omit = all skills, empty = none).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `systemPrompt`: extra system prompt for the channel (combined with topic/purpose).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enabled`: set `false` to disable the channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Delivery targets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use these with cron/CLI sends:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `user:<id>` for DMs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channel:<id>` for channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Slack tool actions can be gated with `channels.slack.actions.*`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Action group | Default | Notes                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | ------- | ---------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| reactions    | enabled | React + list reactions |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| messages     | enabled | Read/send/edit/delete  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| pins         | enabled | Pin/unpin/list         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| memberInfo   | enabled | Member info            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| emojiList    | enabled | Custom emoji list      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Writes default to the bot token so state-changing actions stay scoped to the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  app's bot permissions and identity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Setting `userTokenReadOnly: false` allows the user token to be used for write（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  operations when a bot token is unavailable, which means actions run with the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  installing user's access. Treat the user token as highly privileged and keep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  action gates and allowlists tight.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you enable user-token writes, make sure the user token includes the write（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  scopes you expect (`chat:write`, `reactions:write`, `pins:write`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `files:write`) or those operations will fail.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run this ladder first:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then confirm DM pairing state if needed:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing list slack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common failures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Connected but no channel replies: channel blocked by `groupPolicy` or not in `channels.slack.channels` allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DMs ignored: sender not approved when `channels.slack.dm.policy="pairing"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- API errors (`missing_scope`, `not_in_channel`, auth failures): bot/app tokens or Slack scopes are incomplete.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For triage flow: [/channels/troubleshooting](/channels/troubleshooting).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mention gating is controlled via `channels.slack.channels` (set `requireMention` to `true`); `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`) also count as mentions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multi-agent override: set per-agent patterns on `agents.list[].groupChat.mentionPatterns`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reaction notifications follow `channels.slack.reactionNotifications` (use `reactionAllowlist` with mode `allowlist`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bot-authored messages are ignored by default; enable via `channels.slack.allowBots` or `channels.slack.channels.<id>.allowBots`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Warning: If you allow replies to other bots (`channels.slack.allowBots=true` or `channels.slack.channels.<id>.allowBots=true`), prevent bot-to-bot reply loops with `requireMention`, `channels.slack.channels.<id>.users` allowlists, and/or clear guardrails in `AGENTS.md` and `SOUL.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For the Slack tool, reaction removal semantics are in [/tools/reactions](/tools/reactions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Attachments are downloaded to the media store when permitted and under the size limit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
