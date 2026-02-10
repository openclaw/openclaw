---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Telegram bot support status, capabilities, and configuration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Working on Telegram features or webhooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Telegram"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Telegram (Bot API)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: production-ready for bot DMs + groups via grammY. Long-polling by default; webhook optional.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup (beginner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a bot with **@BotFather** ([direct link](https://t.me/BotFather)). Confirm the handle is exactly `@BotFather`, then copy the token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Set the token:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Env: `TELEGRAM_BOT_TOKEN=...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Or config: `channels.telegram.botToken: "..."`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - If both are set, config takes precedence (env fallback is default-account only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Start the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. DM access is pairing by default; approve the pairing code on first contact.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botToken: "123:abc",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A Telegram Bot API channel owned by the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deterministic routing: replies go back to Telegram; the model never chooses channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DMs share the agent's main session; groups stay isolated (`agent:<agentId>:telegram:group:<chatId>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup (fast path)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Create a bot token (BotFather)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Open Telegram and chat with **@BotFather** ([direct link](https://t.me/BotFather)). Confirm the handle is exactly `@BotFather`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Run `/newbot`, then follow the prompts (name + username ending in `bot`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Copy the token and store it safely.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional BotFather settings:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/setjoingroups` — allow/deny adding the bot to groups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/setprivacy` — control whether the bot sees all group messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Configure the token (env or config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botToken: "123:abc",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: { "*": { requireMention: true } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Env option: `TELEGRAM_BOT_TOKEN=...` (works for the default account).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If both env and config are set, config takes precedence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account support: use `channels.telegram.accounts` with per-account tokens and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Start the gateway. Telegram starts when a token is resolved (config first, env fallback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. DM access defaults to pairing. Approve the code when the bot is first contacted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. For groups: add the bot, decide privacy/admin behavior (below), then set `channels.telegram.groups` to control mention gating + allowlists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Token + privacy + permissions (Telegram side)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Token creation (BotFather)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/newbot` creates the bot and returns the token (keep it secret).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If a token leaks, revoke/regenerate it via @BotFather and update your config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Group message visibility (Privacy Mode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram bots default to **Privacy Mode**, which limits which group messages they receive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your bot must see _all_ group messages, you have two options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Disable privacy mode with `/setprivacy` **or**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add the bot as a group **admin** (admin bots receive all messages).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** When you toggle privacy mode, Telegram requires removing + re‑adding the bot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to each group for the change to take effect.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Group permissions (admin rights)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Admin status is set inside the group (Telegram UI). Admin bots always receive all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
group messages, so use admin if you need full visibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works (behavior)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Inbound messages are normalized into the shared channel envelope with reply context and media placeholders.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group replies require a mention by default (native @mention or `agents.list[].groupChat.mentionPatterns` / `messages.groupChat.mentionPatterns`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multi-agent override: set per-agent patterns on `agents.list[].groupChat.mentionPatterns`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Replies always route back to the same Telegram chat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Long-polling uses grammY runner with per-chat sequencing; overall concurrency is capped by `agents.defaults.maxConcurrent`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram Bot API does not support read receipts; there is no `sendReadReceipts` option.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Draft streaming（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can stream partial replies in Telegram DMs using `sendMessageDraft`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Requirements:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Threaded Mode enabled for the bot in @BotFather (forum topic mode).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Private chat threads only (Telegram includes `message_thread_id` on inbound messages).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.streamMode` not set to `"off"` (default: `"partial"`, `"block"` enables chunked draft updates).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Draft streaming is DM-only; Telegram does not support it in groups or channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Formatting (Telegram HTML)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Outbound Telegram text uses `parse_mode: "HTML"` (Telegram’s supported tag subset).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Markdown-ish input is rendered into **Telegram-safe HTML** (bold/italic/strike/code/links); block elements are flattened to text with newlines/bullets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Raw HTML from models is escaped to avoid Telegram parse errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If Telegram rejects the HTML payload, OpenClaw retries the same message as plain text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Commands (native + custom)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw registers native commands (like `/status`, `/reset`, `/model`) with Telegram’s bot menu on startup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can add custom commands to the menu via config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      customCommands: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { command: "backup", description: "Git backup" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { command: "generate", description: "Create an image" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup troubleshooting (commands)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `setMyCommands failed` in logs usually means outbound HTTPS/DNS is blocked to `api.telegram.org`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you see `sendMessage` or `sendChatAction` failures, check IPv6 routing and DNS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
More help: [Channel troubleshooting](/channels/troubleshooting).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Custom commands are **menu entries only**; OpenClaw does not implement them unless you handle them elsewhere.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Some commands can be handled by plugins/skills without being registered in Telegram’s command menu. These still work when typed (they just won't show up in `/commands` / the menu).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Command names are normalized (leading `/` stripped, lowercased) and must match `a-z`, `0-9`, `_` (1–32 chars).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Custom commands **cannot override native commands**. Conflicts are ignored and logged.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `commands.native` is disabled, only custom commands are registered (or cleared if none).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Device pairing commands (`device-pair` plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the `device-pair` plugin is installed, it adds a Telegram-first flow for pairing a new phone:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `/pair` generates a setup code (sent as a separate message for easy copy/paste).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Paste the setup code in the iOS app to connect.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. `/pair approve` approves the latest pending device request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
More details: [Pairing](/channels/pairing#pair-via-telegram-recommended-for-ios).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Outbound text is chunked to `channels.telegram.textChunkLimit` (default 4000).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional newline chunking: set `channels.telegram.chunkMode="newline"` to split on blank lines (paragraph boundaries) before length chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media downloads/uploads are capped by `channels.telegram.mediaMaxMb` (default 5).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram Bot API requests time out after `channels.telegram.timeoutSeconds` (default 500 via grammY). Set lower to avoid long hangs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group history context uses `channels.telegram.historyLimit` (or `channels.telegram.accounts.*.historyLimit`), falling back to `messages.groupChat.historyLimit`. Set `0` to disable (default 50).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DM history can be limited with `channels.telegram.dmHistoryLimit` (user turns). Per-user overrides: `channels.telegram.dms["<user_id>"].historyLimit`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Group activation modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, the bot only responds to mentions in groups (`@botname` or patterns in `agents.list[].groupChat.mentionPatterns`). To change this behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Via config (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "-1001234567890": { requireMention: false }, // always respond in this group（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Important:** Setting `channels.telegram.groups` creates an **allowlist** - only listed groups (or `"*"`) will be accepted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Forum topics inherit their parent group config (allowFrom, requireMention, skills, prompts) unless you add per-topic overrides under `channels.telegram.groups.<groupId>.topics.<topicId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To allow all groups with always-respond:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "*": { requireMention: false }, // all groups, always respond（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To keep mention-only for all groups (default behavior):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "*": { requireMention: true }, // or omit groups entirely（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Via command (session-level)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send in the group:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/activation always` - respond to all messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/activation mention` - require mentions (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** Commands update session state only. For persistent behavior across restarts, use config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Getting the group chat ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Forward any message from the group to `@userinfobot` or `@getidsbot` on Telegram to see the chat ID (negative number like `-1001234567890`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Tip:** For your own user ID, DM the bot and it will reply with your user ID (pairing message), or use `/whoami` once commands are enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Privacy note:** `@userinfobot` is a third-party bot. If you prefer, add the bot to the group, send a message, and use `openclaw logs --follow` to read `chat.id`, or use the Bot API `getUpdates`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config writes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, Telegram is allowed to write config updates triggered by channel events or `/config set|unset`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This happens when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A group is upgraded to a supergroup and Telegram emits `migrate_to_chat_id` (chat ID changes). OpenClaw can migrate `channels.telegram.groups` automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You run `/config set` or `/config unset` in a Telegram chat (requires `commands.config: true`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Disable with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: { telegram: { configWrites: false } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Topics (forum supergroups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram forum topics include a `message_thread_id` per message. OpenClaw:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Appends `:topic:<threadId>` to the Telegram group session key so each topic is isolated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sends typing indicators and replies with `message_thread_id` so responses stay in the topic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- General topic (thread id `1`) is special: message sends omit `message_thread_id` (Telegram rejects it), but typing indicators still include it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exposes `MessageThreadId` + `IsForum` in template context for routing/templating.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Topic-specific configuration is available under `channels.telegram.groups.<chatId>.topics.<threadId>` (skills, allowlists, auto-reply, system prompts, disable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Topic configs inherit group settings (requireMention, allowlists, skills, prompts, enabled) unless overridden per topic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Private chats can include `message_thread_id` in some edge cases. OpenClaw keeps the DM session key unchanged, but still uses the thread id for replies/draft streaming when it is present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inline Buttons（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram supports inline keyboards with callback buttons.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      capabilities: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        inlineButtons: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For per-account configuration:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        main: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          capabilities: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            inlineButtons: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Scopes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `off` — inline buttons disabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dm` — only DMs (group targets blocked)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group` — only groups (DM targets blocked)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `all` — DMs + groups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowlist` — DMs + groups, but only senders allowed by `allowFrom`/`groupAllowFrom` (same rules as control commands)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default: `allowlist`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy: `capabilities: ["inlineButtons"]` = `inlineButtons: "all"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Sending buttons（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the message tool with the `buttons` parameter:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  action: "send",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channel: "telegram",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  to: "123456789",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  message: "Choose an option:",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  buttons: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { text: "Yes", callback_data: "yes" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { text: "No", callback_data: "no" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    [{ text: "Cancel", callback_data: "cancel" }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a user clicks a button, the callback data is sent back to the agent as a message with the format:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`callback_data: value`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Configuration options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram capabilities can be configured at two levels (object form shown above; legacy string arrays still supported):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.capabilities`: Global default capability config applied to all Telegram accounts unless overridden.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.accounts.<account>.capabilities`: Per-account capabilities that override the global defaults for that specific account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the global setting when all Telegram bots/accounts should behave the same. Use per-account configuration when different bots need different behaviors (for example, one account only handles DMs while another is allowed in groups).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control (DMs + groups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### DM access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.telegram.dmPolicy = "pairing"`. Unknown senders receive a pairing code; messages are ignored until approved (codes expire after 1 hour).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approve via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing list telegram`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing approve telegram <CODE>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing is the default token exchange used for Telegram DMs. Details: [Pairing](/channels/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.allowFrom` accepts numeric user IDs (recommended) or `@username` entries. It is **not** the bot username; use the human sender’s ID. The wizard accepts `@username` and resolves it to the numeric ID when possible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Finding your Telegram user ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Safer (no third-party bot):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Start the gateway and DM your bot.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Run `openclaw logs --follow` and look for `from.id`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Alternate (official Bot API):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. DM your bot.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Fetch updates with your bot token and read `message.from.id`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   curl "https://api.telegram.org/bot<bot_token>/getUpdates"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Third-party (less private):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DM `@userinfobot` or `@getidsbot` and use the returned user id.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Group access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Two independent controls:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**1. Which groups are allowed** (group allowlist via `channels.telegram.groups`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No `groups` config = all groups allowed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- With `groups` config = only listed groups or `"*"` are allowed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example: `"groups": { "-1001234567890": {}, "*": {} }` allows all groups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**2. Which senders are allowed** (sender filtering via `channels.telegram.groupPolicy`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"open"` = all senders in allowed groups can message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"allowlist"` = only senders in `channels.telegram.groupAllowFrom` can message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"disabled"` = no group messages accepted at all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Default is `groupPolicy: "allowlist"` (blocked unless you add `groupAllowFrom`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Most users want: `groupPolicy: "allowlist"` + `groupAllowFrom` + specific groups listed in `channels.telegram.groups`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To allow **any group member** to talk in a specific group (while still keeping control commands restricted to authorized senders), set a per-group override:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "-1001234567890": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          groupPolicy: "open",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          requireMention: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Long-polling vs webhook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: long-polling (no public URL required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Webhook mode: set `channels.telegram.webhookUrl` and `channels.telegram.webhookSecret` (optionally `channels.telegram.webhookPath`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - The local listener binds to `0.0.0.0:8787` and serves `POST /telegram-webhook` by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If your public URL is different, use a reverse proxy and point `channels.telegram.webhookUrl` at the public endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reply threading（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram supports optional threaded replies via tags:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `[[reply_to_current]]` -- reply to the triggering message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `[[reply_to:<id>]]` -- reply to a specific message id.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Controlled by `channels.telegram.replyToMode`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `first` (default), `all`, `off`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Audio messages (voice vs file)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram distinguishes **voice notes** (round bubble) from **audio files** (metadata card).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw defaults to audio files for backward compatibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To force a voice note bubble in agent replies, include this tag anywhere in the reply:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `[[audio_as_voice]]` — send audio as a voice note instead of a file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The tag is stripped from the delivered text. Other channels ignore this tag.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For message tool sends, set `asVoice: true` with a voice-compatible audio `media` URL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(`message` is optional when media is present):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  action: "send",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channel: "telegram",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  to: "123456789",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  media: "https://example.com/voice.ogg",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  asVoice: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Video messages (video vs video note)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram distinguishes **video notes** (round bubble) from **video files** (rectangular).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw defaults to video files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For message tool sends, set `asVideoNote: true` with a video `media` URL:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  action: "send",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channel: "telegram",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  to: "123456789",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  media: "https://example.com/video.mp4",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  asVideoNote: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(Note: Video notes do not support captions. If you provide a message text, it will be sent as a separate message.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Stickers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw supports receiving and sending Telegram stickers with intelligent caching.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Receiving stickers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a user sends a sticker, OpenClaw handles it based on the sticker type:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Static stickers (WEBP):** Downloaded and processed through vision. The sticker appears as a `<media:sticker>` placeholder in the message content.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Animated stickers (TGS):** Skipped (Lottie format not supported for processing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Video stickers (WEBM):** Skipped (video format not supported for processing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Template context field available when receiving stickers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Sticker` — object with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `emoji` — emoji associated with the sticker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `setName` — name of the sticker set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `fileId` — Telegram file ID (send the same sticker back)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `fileUniqueId` — stable ID for cache lookup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `cachedDescription` — cached vision description when available（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Sticker cache（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Stickers are processed through the AI's vision capabilities to generate descriptions. Since the same stickers are often sent repeatedly, OpenClaw caches these descriptions to avoid redundant API calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**How it works:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **First encounter:** The sticker image is sent to the AI for vision analysis. The AI generates a description (e.g., "A cartoon cat waving enthusiastically").（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Cache storage:** The description is saved along with the sticker's file ID, emoji, and set name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Subsequent encounters:** When the same sticker is seen again, the cached description is used directly. The image is not sent to the AI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Cache location:** `~/.openclaw/telegram/sticker-cache.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Cache entry format:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "fileId": "CAACAgIAAxkBAAI...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "fileUniqueId": "AgADBAADb6cxG2Y",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "emoji": "👋",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "setName": "CoolCats",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "description": "A cartoon cat waving enthusiastically",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "cachedAt": "2026-01-15T10:30:00.000Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Benefits:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reduces API costs by avoiding repeated vision calls for the same sticker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Faster response times for cached stickers (no vision processing delay)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enables sticker search functionality based on cached descriptions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The cache is populated automatically as stickers are received. There is no manual cache management required.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Sending stickers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The agent can send and search stickers using the `sticker` and `sticker-search` actions. These are disabled by default and must be enabled in config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      actions: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sticker: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Send a sticker:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  action: "sticker",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channel: "telegram",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  to: "123456789",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  fileId: "CAACAgIAAxkBAAI...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `fileId` (required) — the Telegram file ID of the sticker. Obtain this from `Sticker.fileId` when receiving a sticker, or from a `sticker-search` result.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `replyTo` (optional) — message ID to reply to.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `threadId` (optional) — message thread ID for forum topics.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Search for stickers:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The agent can search cached stickers by description, emoji, or set name:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  action: "sticker-search",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channel: "telegram",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  query: "cat waving",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  limit: 5,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Returns matching stickers from the cache:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ok: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  count: 2,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  stickers: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      fileId: "CAACAgIAAxkBAAI...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      emoji: "👋",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      description: "A cartoon cat waving enthusiastically",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      setName: "CoolCats",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The search uses fuzzy matching across description text, emoji characters, and set names.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example with threading:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  action: "sticker",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channel: "telegram",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  to: "-1001234567890",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  fileId: "CAACAgIAAxkBAAI...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  replyTo: 42,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  threadId: 123,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Streaming (drafts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram can stream **draft bubbles** while the agent is generating a response.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses Bot API `sendMessageDraft` (not real messages) and then sends the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
final reply as a normal message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Requirements (Telegram Bot API 9.3+):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Private chats with topics enabled** (forum topic mode for the bot).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Incoming messages must include `message_thread_id` (private topic thread).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Streaming is ignored for groups/supergroups/channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.streamMode: "off" | "partial" | "block"` (default: `partial`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `partial`: update the draft bubble with the latest streaming text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `block`: update the draft bubble in larger blocks (chunked).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `off`: disable draft streaming.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional (only for `streamMode: "block"`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels.telegram.draftChunk: { minChars?, maxChars?, breakPreference? }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - defaults: `minChars: 200`, `maxChars: 800`, `breakPreference: "paragraph"` (clamped to `channels.telegram.textChunkLimit`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: draft streaming is separate from **block streaming** (channel messages).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Block streaming is off by default and requires `channels.telegram.blockStreaming: true`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if you want early Telegram messages instead of draft updates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reasoning stream (Telegram only):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/reasoning stream` streams reasoning into the draft bubble while the reply is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generating, then sends the final answer without reasoning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `channels.telegram.streamMode` is `off`, reasoning stream is disabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  More context: [Streaming + chunking](/concepts/streaming).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Retry policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Outbound Telegram API calls retry on transient network/429 errors with exponential backoff and jitter. Configure via `channels.telegram.retry`. See [Retry policy](/concepts/retry).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Agent tool (messages + reactions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool: `telegram` with `sendMessage` action (`to`, `content`, optional `mediaUrl`, `replyToMessageId`, `messageThreadId`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool: `telegram` with `react` action (`chatId`, `messageId`, `emoji`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool: `telegram` with `deleteMessage` action (`chatId`, `messageId`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reaction removal semantics: see [/tools/reactions](/tools/reactions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool gating: `channels.telegram.actions.reactions`, `channels.telegram.actions.sendMessage`, `channels.telegram.actions.deleteMessage` (default: enabled), and `channels.telegram.actions.sticker` (default: disabled).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reaction notifications（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**How reactions work:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram reactions arrive as **separate `message_reaction` events**, not as properties in message payloads. When a user adds a reaction, OpenClaw:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Receives the `message_reaction` update from Telegram API（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Converts it to a **system event** with format: `"Telegram reaction added: {emoji} by {user} on msg {id}"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Enqueues the system event using the **same session key** as regular messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. When the next message arrives in that conversation, system events are drained and prepended to the agent's context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The agent sees reactions as **system notifications** in the conversation history, not as message metadata.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Configuration:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.reactionNotifications`: Controls which reactions trigger notifications（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"off"` — ignore all reactions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"own"` — notify when users react to bot messages (best-effort; in-memory) (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"all"` — notify for all reactions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.reactionLevel`: Controls agent's reaction capability（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"off"` — agent cannot react to messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"ack"` — bot sends acknowledgment reactions (👀 while processing) (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"minimal"` — agent can react sparingly (guideline: 1 per 5-10 exchanges)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"extensive"` — agent can react liberally when appropriate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Forum groups:** Reactions in forum groups include `message_thread_id` and use session keys like `agent:main:telegram:group:{chatId}:topic:{threadId}`. This ensures reactions and messages in the same topic stay together.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example config:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      reactionNotifications: "all", // See all reactions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      reactionLevel: "minimal", // Agent can react sparingly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Requirements:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram bots must explicitly request `message_reaction` in `allowed_updates` (configured automatically by OpenClaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For webhook mode, reactions are included in the webhook `allowed_updates`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For polling mode, reactions are included in the `getUpdates` `allowed_updates`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Delivery targets (CLI/cron)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use a chat id (`123456789`) or a username (`@name`) as the target.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example: `openclaw message send --channel telegram --target 123456789 --message "hi"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Bot doesn’t respond to non-mention messages in a group:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you set `channels.telegram.groups.*.requireMention=false`, Telegram’s Bot API **privacy mode** must be disabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - BotFather: `/setprivacy` → **Disable** (then remove + re-add the bot to the group)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw channels status` shows a warning when config expects unmentioned group messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw channels status --probe` can additionally check membership for explicit numeric group IDs (it can’t audit wildcard `"*"` rules).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Quick test: `/activation always` (session-only; use config for persistence)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Bot not seeing group messages at all:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `channels.telegram.groups` is set, the group must be listed or use `"*"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check Privacy Settings in @BotFather → "Group Privacy" should be **OFF**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify bot is actually a member (not just an admin with no read access)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check gateway logs: `openclaw logs --follow` (look for "skipping group message")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Bot responds to mentions but not `/activation always`:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The `/activation` command updates session state but doesn't persist to config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For persistent behavior, add group to `channels.telegram.groups` with `requireMention: false`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Commands like `/status` don't work:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Make sure your Telegram user ID is authorized (via pairing or `channels.telegram.allowFrom`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commands require authorization even in groups with `groupPolicy: "open"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Long-polling aborts immediately on Node 22+ (often with proxies/custom fetch):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node 22+ is stricter about `AbortSignal` instances; foreign signals can abort `fetch` calls right away.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Upgrade to a OpenClaw build that normalizes abort signals, or run the gateway on Node 20 until you can upgrade.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Bot starts, then silently stops responding (or logs `HttpError: Network request ... failed`):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Some hosts resolve `api.telegram.org` to IPv6 first. If your server does not have working IPv6 egress, grammY can get stuck on IPv6-only requests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix by enabling IPv6 egress **or** forcing IPv4 resolution for `api.telegram.org` (for example, add an `/etc/hosts` entry using the IPv4 A record, or prefer IPv4 in your OS DNS stack), then restart the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Quick check: `dig +short api.telegram.org A` and `dig +short api.telegram.org AAAA` to confirm what DNS returns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration reference (Telegram)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full configuration: [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.enabled`: enable/disable channel startup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.botToken`: bot token (BotFather).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.tokenFile`: read token from file path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.allowFrom`: DM allowlist (ids/usernames). `open` requires `"*"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.groupPolicy`: `open | allowlist | disabled` (default: allowlist).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.groupAllowFrom`: group sender allowlist (ids/usernames).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.groups`: per-group defaults + allowlist (use `"*"` for global defaults).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels.telegram.groups.<id>.groupPolicy`: per-group override for groupPolicy (`open | allowlist | disabled`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels.telegram.groups.<id>.requireMention`: mention gating default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels.telegram.groups.<id>.skills`: skill filter (omit = all skills, empty = none).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels.telegram.groups.<id>.allowFrom`: per-group sender allowlist override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels.telegram.groups.<id>.systemPrompt`: extra system prompt for the group.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels.telegram.groups.<id>.enabled`: disable the group when `false`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: per-topic overrides (same fields as group).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: per-topic override for groupPolicy (`open | allowlist | disabled`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: per-topic mention gating override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist` (default: allowlist).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: per-account override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.replyToMode`: `off | first | all` (default: `first`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.textChunkLimit`: outbound chunk size (chars).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.chunkMode`: `length` (default) or `newline` to split on blank lines (paragraph boundaries) before length chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.linkPreview`: toggle link previews for outbound messages (default: true).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.streamMode`: `off | partial | block` (draft streaming).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.mediaMaxMb`: inbound/outbound media cap (MB).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.retry`: retry policy for outbound Telegram API calls (attempts, minDelayMs, maxDelayMs, jitter).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.network.autoSelectFamily`: override Node autoSelectFamily (true=enable, false=disable). Defaults to disabled on Node 22 to avoid Happy Eyeballs timeouts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.proxy`: proxy URL for Bot API calls (SOCKS/HTTP).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.webhookUrl`: enable webhook mode (requires `channels.telegram.webhookSecret`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.webhookSecret`: webhook secret (required when webhookUrl is set).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.webhookPath`: local webhook path (default `/telegram-webhook`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.actions.reactions`: gate Telegram tool reactions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.actions.sendMessage`: gate Telegram tool message sends.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.actions.deleteMessage`: gate Telegram tool message deletes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.actions.sticker`: gate Telegram sticker actions — send and search (default: false).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.reactionNotifications`: `off | own | all` — control which reactions trigger system events (default: `own` when not set).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — control agent's reaction capability (default: `minimal` when not set).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related global options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].groupChat.mentionPatterns` (mention gating patterns).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messages.groupChat.mentionPatterns` (global fallback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.native` (defaults to `"auto"` → on for Telegram/Discord, off for Slack), `commands.text`, `commands.useAccessGroups` (command behavior). Override with `channels.telegram.commands.native`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`, `messages.removeAckAfterReply`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
