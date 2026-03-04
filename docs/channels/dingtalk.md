---
summary: "DingTalk bot overview, features, and configuration"
read_when:
  - You want to connect a DingTalk bot
  - You are configuring the DingTalk channel
title: DingTalk
---

# DingTalk bot

DingTalk (钉钉) is a team chat platform widely used by enterprises in China. This plugin connects OpenClaw to a DingTalk bot using the platform's Stream mode (WebSocket long connection) so messages can be received without exposing a public webhook URL.

---

## Plugin required

Install the DingTalk plugin:

```bash
openclaw plugins install @openclaw/dingtalk
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/dingtalk
```

---

## Quickstart

There are two ways to add the DingTalk channel:

### Method 1: onboarding wizard (recommended)

If you just installed OpenClaw, run the wizard:

```bash
openclaw onboard
```

The wizard guides you through:

1. Creating a DingTalk app and collecting credentials
2. Configuring app credentials in OpenClaw
3. Starting the gateway

✅ **After configuration**, check gateway status:

- `openclaw gateway status`
- `openclaw logs --follow`

### Method 2: CLI setup

If you already completed initial install, add the channel via CLI:

```bash
openclaw channels add
```

Choose **DingTalk**, then enter the Client ID and Client Secret.

✅ **After configuration**, manage the gateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Step 1: Create a DingTalk app

### 1. Open DingTalk Developer Console

Visit [DingTalk Developer Console](https://open-dev.dingtalk.com) and sign in with your enterprise admin account.

### 2. Create an internal enterprise app

1. Click **应用开发** > **企业内部开发** > **创建应用**
2. Fill in the app name and description
3. Choose an app icon

### 3. Copy credentials

From the app's **基本信息** page, copy:

- **Client ID** (AppKey)
- **Client Secret** (AppSecret)

❗ **Important:** keep the Client Secret private.

### 4. Enable robot capability

In **应用功能** > **机器人**:

1. Enable robot capability
2. Set the robot name
3. **Select Stream mode** (消息接收模式选择 Stream 模式)

### 5. Publish the app

1. In **版本管理与发布**, create a new version
2. Set the visible range (which users/departments can access the bot)
3. Submit for review and publish
4. Wait for admin approval

---

## Step 2: Configure OpenClaw

### Configure with the wizard (recommended)

```bash
openclaw channels add
```

Choose **DingTalk** and paste your Client ID + Client Secret.

### Configure via config file

Edit `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      dmPolicy: "pairing",
      clientId: "your-client-id",
      clientSecret: "your-client-secret",
    },
  },
}
```

### Configure via environment variables

```bash
export DINGTALK_CLIENT_ID="your-client-id"
export DINGTALK_CLIENT_SECRET="your-client-secret"
```

---

## Step 3: Start + test

### 1. Start the gateway

```bash
openclaw gateway
```

### 2. Send a test message

In DingTalk, find your bot and send a message (DM or @mention in a group).

### 3. Approve pairing

By default, the bot replies with a pairing code. Approve it:

```bash
openclaw pairing approve dingtalk <CODE>
```

After approval, you can chat normally.

---

## Overview

- **DingTalk bot channel**: DingTalk bot managed by the gateway
- **Stream mode**: WebSocket long connection via `dingtalk-stream` SDK, no public URL needed
- **Deterministic routing**: replies always return to DingTalk
- **Session isolation**: DMs share a main session; groups are isolated
- **Streaming card output**: interactive cards with typewriter-style incremental text display

---

## Access control

### Direct messages

- **Default**: `dmPolicy: "pairing"` (unknown users get a pairing code)
- **Approve pairing**:

  ```bash
  openclaw pairing list dingtalk
  openclaw pairing approve dingtalk <CODE>
  ```

- **Allowlist mode**: set `channels.dingtalk.allowFrom` with allowed staffIds

### Group chats

**1. Group policy** (`channels.dingtalk.groupPolicy`):

- `"open"` = allow all groups (default, requires @mention)
- `"allowlist"` = only allow groups in `groupAllowFrom`
- `"disabled"` = disable group messages

**2. Mention requirement** (`channels.dingtalk.requireMention`):

- `true` = require @mention (default)
- `false` = respond without mentions

---

## Group configuration examples

### Allow all groups, require @mention (default)

```json5
{
  channels: {
    dingtalk: {
      groupPolicy: "open",
      // Default requireMention: true
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
      groupAllowFrom: ["cidXXXXXX", "cidYYYYYY"],
    },
  },
}
```

---

## Get group/user IDs

### Group IDs (conversationId)

Group IDs look like `cidXXXXXX`.

**Method 1 (recommended)**

1. Start the gateway and @mention the bot in the group
2. Run `openclaw logs --follow` and look for `conversationId`

### User IDs (staffId)

**Method 1 (recommended)**

1. Start the gateway and DM the bot
2. Run `openclaw logs --follow` and look for `senderStaffId`

**Method 2**

Check pairing requests for user staffIds:

```bash
openclaw pairing list dingtalk
```

---

## Common commands

| Command   | Description       |
| --------- | ----------------- |
| `/status` | Show bot status   |
| `/reset`  | Reset the session |
| `/model`  | Show/switch model |

> Note: DingTalk does not support native command menus, so commands must be sent as text.

## Gateway management commands

| Command                    | Description                   |
| -------------------------- | ----------------------------- |
| `openclaw gateway status`  | Show gateway status           |
| `openclaw gateway install` | Install/start gateway service |
| `openclaw gateway stop`    | Stop gateway service          |
| `openclaw gateway restart` | Restart gateway service       |
| `openclaw logs --follow`   | Tail gateway logs             |

---

## Troubleshooting

### Bot does not respond in group chats

1. Ensure the bot is added to the group
2. Ensure you @mention the bot (default behavior)
3. Check `groupPolicy` is not set to `"disabled"`
4. Check logs: `openclaw logs --follow`

### Bot does not receive messages

1. Ensure the app is published and approved
2. Ensure robot capability is enabled with **Stream mode**
3. Ensure the visible range includes the user/group
4. Ensure the gateway is running: `openclaw gateway status`
5. Check logs: `openclaw logs --follow`

### Client Secret leak

1. Reset the Client Secret in DingTalk Developer Console
2. Update the Client Secret in your config
3. Restart the gateway

### Message send failures

1. Ensure the app has robot capability enabled
2. Ensure the app is published
3. Check rate limits (DingTalk: 20 messages/minute/robot)
4. Check logs for detailed errors

### Group chat media limitations

DingTalk has different media support between DM and group chats:

- **DM**: supports text, images, voice, video, files
- **Group (@mention)**: only supports text and images

---

## Advanced configuration

### Multiple accounts

```json5
{
  channels: {
    dingtalk: {
      defaultAccount: "main",
      accounts: {
        main: {
          clientId: "app-key-1",
          clientSecret: "app-secret-1",
          name: "Primary bot",
        },
        backup: {
          clientId: "app-key-2",
          clientSecret: "app-secret-2",
          name: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

`defaultAccount` controls which DingTalk account is used when outbound APIs do not specify an `accountId` explicitly.

### Message limits

- `textChunkLimit`: outbound text chunk size (default: 2000 chars)
- `mediaMaxMb`: media upload/download limit (default: 20MB)

### Streaming

DingTalk supports streaming replies via interactive cards. When enabled, the bot sends a card and updates it incrementally as it generates text (typewriter effect).

```json5
{
  channels: {
    dingtalk: {
      streaming: true, // enable streaming card output (default true)
    },
  },
}
```

Set `streaming: false` to wait for the full reply before sending.

### Multi-agent routing

Use `bindings` to route DingTalk DMs or groups to different agents.

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "support-bot",
        workspace: "/home/user/support-bot",
        agentDir: "/home/user/.openclaw/agents/support-bot/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "dingtalk",
        peer: { kind: "direct", id: "staffId123" },
      },
    },
    {
      agentId: "support-bot",
      match: {
        channel: "dingtalk",
        peer: { kind: "group", id: "cidXXXXXX" },
      },
    },
  ],
}
```

Routing fields:

- `match.channel`: `"dingtalk"`
- `match.peer.kind`: `"direct"` or `"group"`
- `match.peer.id`: user staffId or group conversationId

See [Get group/user IDs](#get-groupuser-ids) for lookup tips.

---

## Configuration reference

Full configuration: [Gateway configuration](/gateway/configuration)

Key options:

| Setting                                                    | Description                             | Default     |
| ---------------------------------------------------------- | --------------------------------------- | ----------- |
| `channels.dingtalk.enabled`                                | Enable/disable channel                  | `true`      |
| `channels.dingtalk.clientId`                               | App Client ID (AppKey)                  | -           |
| `channels.dingtalk.clientSecret`                           | App Client Secret (AppSecret)           | -           |
| `channels.dingtalk.robotCode`                              | Robot code (defaults to clientId)       | `clientId`  |
| `channels.dingtalk.defaultAccount`                         | Default account ID for outbound routing | `default`   |
| `channels.dingtalk.accounts.<id>.clientId`                 | Per-account Client ID                   | -           |
| `channels.dingtalk.accounts.<id>.clientSecret`             | Per-account Client Secret               | -           |
| `channels.dingtalk.dmPolicy`                               | DM policy                               | `pairing`   |
| `channels.dingtalk.allowFrom`                              | DM allowlist (staffId list)             | -           |
| `channels.dingtalk.groupPolicy`                            | Group policy                            | `open`      |
| `channels.dingtalk.groupAllowFrom`                         | Group allowlist (conversationId list)   | -           |
| `channels.dingtalk.requireMention`                         | Require @mention in groups              | `true`      |
| `channels.dingtalk.groups.<conversationId>.requireMention` | Per-group @mention requirement          | `true`      |
| `channels.dingtalk.groups.<conversationId>.enabled`        | Enable/disable group                    | `true`      |
| `channels.dingtalk.textChunkLimit`                         | Message chunk size                      | `2000`      |
| `channels.dingtalk.mediaMaxMb`                             | Media size limit                        | `20`        |
| `channels.dingtalk.streaming`                              | Enable streaming card output            | `true`      |
| `channels.dingtalk.resolveSenderNames`                     | Resolve sender display names            | `true`      |

---

## dmPolicy reference

| Value         | Behavior                                                        |
| ------------- | --------------------------------------------------------------- |
| `"pairing"`   | **Default.** Unknown users get a pairing code; must be approved |
| `"allowlist"` | Only users in `allowFrom` can chat                              |
| `"open"`      | Allow all users (requires `"*"` in allowFrom)                   |

---

## Supported message types

### Receive

- ✅ Text
- ✅ Images (DM + group)
- ✅ Voice (DM only)
- ✅ Files (DM only)
- ✅ Video (DM only)

### Send

- ✅ Text
- ✅ Markdown
- ✅ Images
- ✅ Files (DM only)
- ✅ Audio (DM only)
- ✅ Video (DM only)
- ✅ Interactive cards (streaming)
- ✅ ActionCard

---

## Feature comparison with Feishu

| Feature           | DingTalk | Feishu |
| ----------------- | -------- | ------ |
| Text messages     | ✅        | ✅      |
| Markdown          | ✅        | ✅      |
| Images            | ✅        | ✅      |
| Files             | ✅ (DM)  | ✅      |
| Audio/Video       | ✅ (DM)  | ✅      |
| Streaming cards   | ✅        | ✅      |
| Message reactions  | ❌        | ✅      |
| Message editing   | ❌        | ✅      |
| Reply/threads     | ❌        | ✅      |
| Stickers          | ❌        | ✅      |
| WebSocket (no URL) | ✅       | ✅      |
