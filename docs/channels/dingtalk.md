---
summary: "DingTalk bot overview, features, and configuration"
read_when:
  - You want to connect a DingTalk bot
  - You are configuring the DingTalk channel
title: DingTalk
---

# DingTalk bot

DingTalk (钉钉) is China's largest enterprise communication platform. This plugin connects OpenClaw to a DingTalk bot using Stream Mode (WebSocket), so messages can be received without exposing a public URL or port.

---

## Community plugin

DingTalk support is provided by the `@openclaw-china/channels` community plugin.

```bash
openclaw plugins install @openclaw-china/channels
```

---

## Quickstart

There are two ways to add the DingTalk channel:

### Method 1: setup wizard (recommended)

If you just installed OpenClaw, run the setup wizard:

```bash
openclaw configure --section channels
```

The wizard guides you through:

1. Selecting DingTalk as a channel
2. Entering your credentials
3. Starting the gateway

✅ **After configuration**, check gateway status:

- `openclaw gateway status`
- `openclaw logs --follow`

### Method 2: CLI setup

```bash
openclaw config set channels.dingtalk.enabled true
openclaw config set channels.dingtalk.clientId "your_client_id"
openclaw config set channels.dingtalk.clientSecret "your_client_secret"
```

✅ **After configuration**, manage the gateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Step 1: Create a DingTalk Robot

### 1. Open DingTalk Open Platform

Visit [DingTalk Open Platform](https://open.dingtalk.com) and sign in with your organization admin account.

### 2. Create an application

1. Navigate to **应用开发** → **企业内部应用** → **机器人**
2. Click **创建应用**
3. Fill in the app name and description

### 3. Copy credentials

From the application details page, copy:

- **ClientID** (AppKey)
- **ClientSecret** (AppSecret)

❗ **Important:** keep the ClientSecret private. Never share it in chat or commit it to code.

### 4. Enable Stream Mode

In the application settings:

1. Navigate to **消息接收模式**
2. Select **Stream 模式** (recommended)

### 5. Grant permissions

In **权限管理**, enable these API permissions:

- **企业内机器人发送消息** — Send messages
- **通讯录只读权限** — Read contact info (for sender identification)
- **群会话管理** — Group chat management (if using group chats)

### 6. Publish the application

1. Navigate to **版本管理与发布**
2. Create a new version
3. Submit for review and publish
4. Wait for organization admin approval

---

## Step 2: Configure OpenClaw

### Configure via config file

Edit `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      clientId: "dingXXXXXXXXXX",
      clientSecret: "your_client_secret",
    },
  },
}
```

### Add a routing binding

Route DingTalk messages to your agent:

```json5
{
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "dingtalk",
        accountId: "default",
      },
    },
  ],
}
```

---

## Step 3: Start + test

### 1. Start the gateway

```bash
openclaw gateway
```

### 2. Send a test message

In DingTalk, find your bot and send a direct message.

### 3. Verify connection

```bash
openclaw channels status
```

You should see: `DingTalk default: enabled, configured`

---

## Overview

- **DingTalk bot channel**: DingTalk bot managed by the gateway
- **Stream Mode**: WebSocket connection — no public IP, no port forwarding
- **Session isolation**: DMs are per-user; groups are per-group
- **Auto-reconnect**: gateway automatically reconnects on connection drops

---

## Access control

### Direct messages

DingTalk DMs work without any allowlist by default. Any user who can find the bot in DingTalk can send direct messages.

### Group chats

**1. Group policy** (`channels.dingtalk.groupPolicy`):

- `"open"` = allow all groups (default)
- `"allowlist"` = only allow groups in `groupAllowFrom`

**2. Mention requirement**:

In group chats, users must @mention the bot. Messages without @mention are ignored.

---

## Group configuration examples

### Allow all groups (default)

```json5
{
  channels: {
    dingtalk: {
      groupPolicy: "open",
    },
  },
}
```

### Allow specific groups only

```json5
{
  channels: {
    dingtalk: {
      groupPolicy: "allowlist",
      // DingTalk group IDs (conversationId) look like: cidXXXXXX==
      groupAllowFrom: ["cidXXXXXX==", "cidYYYYYY=="],
    },
  },
}
```

> **Tip:** To find a group's conversationId, set `groupPolicy: "open"` temporarily, @mention the bot in the group, then check `openclaw logs --follow` for the `conversationId` field. Switch back to `"allowlist"` after.

---

## Get group/user IDs

### Group IDs (conversationId)

Group IDs look like `cidXXXXXX==`.

1. Temporarily set `groupPolicy: "open"`
2. @mention the bot in the target group
3. Run `openclaw logs --follow` and look for `conversationId`
4. Add the ID to `groupAllowFrom` and set `groupPolicy: "allowlist"`

### User IDs (userId)

User IDs look like `managerXXXX` or numeric strings.

1. Have the user send a DM to the bot
2. Run `openclaw logs --follow` and look for `senderId` or `userId`

---

## Stream Mode vs Webhook Mode

| | Stream Mode | Outbound Webhook |
|---|---|---|
| Public IP required | ❌ No | ✅ Yes |
| Port forwarding | ❌ No | ✅ Yes |
| NAT/firewall compatible | ✅ Yes | ❌ No |
| Setup complexity | Low | Medium |
| Recommended | ✅ **Yes** | Only if Stream is unavailable |

**Stream Mode is strongly recommended.** It works behind NAT, corporate firewalls, and home networks without any port forwarding or public IP.

---

## Common commands

| Command | Description |
|---------|-------------|
| `openclaw channels status` | Show channel connection status |
| `openclaw gateway status` | Show gateway status |
| `openclaw gateway restart` | Restart gateway |
| `openclaw logs --follow` | Tail gateway logs |
| `openclaw health` | Quick health check |

---

## Troubleshooting

### Bot not responding in group chats

1. Ensure the bot is added to the group
2. Ensure users @mention the bot (required in groups)
3. Check `groupPolicy` is not blocking the group
4. Check logs: `openclaw logs --follow`

### Bot not receiving messages

1. Ensure the application is published and approved
2. Ensure **Stream Mode** is selected (not webhook)
3. Ensure the gateway is running: `openclaw gateway status`
4. Check logs for connection errors: `openclaw logs --follow`

### Authentication errors

1. Verify ClientID and ClientSecret are correct
2. Ensure the application is in "published" state
3. Check that required API permissions are granted

### Stream connection drops

OpenClaw auto-reconnects. If connections drop frequently:

1. Check network stability
2. Check `openclaw logs --follow` for reconnection patterns
3. A warning `registration not confirmed after 30000ms` is normal on startup — the connection is still alive

### ClientSecret leak

1. Regenerate the ClientSecret in DingTalk Open Platform
2. Update the secret in `~/.openclaw/openclaw.json`
3. Restart the gateway: `openclaw gateway restart`

---

## Configuration reference

| Setting | Description | Default |
|---------|-------------|---------|
| `channels.dingtalk.enabled` | Enable/disable channel | `true` |
| `channels.dingtalk.clientId` | DingTalk AppKey | - |
| `channels.dingtalk.clientSecret` | DingTalk AppSecret | - |
| `channels.dingtalk.enableAICard` | Enable AI interactive cards | `false` |
| `channels.dingtalk.groupPolicy` | Group access policy (`open` / `allowlist`) | `open` |
| `channels.dingtalk.groupAllowFrom` | Allowed group conversationIds | - |

---

## Supported message types

### Receive

- ✅ Text
- ✅ Rich text (markdown)
- ⚠️ Images (limited — DingTalk does not forward image data to Stream bots by default)
- ❌ Files (not supported via Stream Mode)

### Send

- ✅ Text
- ✅ Markdown
- ⚠️ Images (via DingTalk media upload API)
- ⚠️ Interactive cards (requires `enableAICard: true`)

---

## Limitations

- DingTalk Stream Mode robots can only receive @mentions in group chats
- File and image sharing is limited compared to other channels
- DingTalk API rate limits apply (varies by organization tier)
- The `@openclaw-china/channels` plugin is community-maintained

---

_This guide is based on production deployment experience with DingTalk Stream Mode in an enterprise environment. Stream Mode requires no public IP or port forwarding, making it the recommended approach for most deployments._
