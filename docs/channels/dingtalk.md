---
summary: "DingTalk bot overview, features, and configuration"
read_when:
  - You want to connect a DingTalk bot
  - You are configuring the DingTalk channel
title: DingTalk
---

# DingTalk bot

DingTalk (钉钉) is a team chat platform widely used by companies in China for messaging and collaboration. This plugin connects OpenClaw to a DingTalk bot using the platform's Stream mode (WebSocket) for receiving events, so messages can be received without exposing a public webhook URL.

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

Choose **DingTalk**, then enter the App Key and App Secret.

✅ **After configuration**, manage the gateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Step 1: Create a DingTalk robot

1. Visit [DingTalk Open Platform](https://open.dingtalk.com/)

2. Sign in and go to **Application Development** → **Enterprise Internal Development**

3. Create an application, Get the **AppKey** and **AppSecret** from the app details page
![Get credentials](../images/dingtalk-step6-credentials.jpg)
4. select **Robot** type

![Create robot app](../images/dingtalk-step1-create-app.png)


5. Configure the message receiving mode as **Stream mode**

![Configure Stream mode](../images/dingtalk-step2-stream-mode.jpg)

6. **Publish the robot**

---

## Step 2: Configure permissions

Non-admin users need admin approval.

Search and enable the following permissions:

- `Card.Streaming.Write`
- `Card.Instance.Write`
- `qyapi_robot_sendmsg`

![Configure permissions](../images/dingtalk-step4-permissions.png)

---

## Step 3: Publish the app

![Publish step 1](../images/dingtalk-step5-publish-1.png)

![Publish step 2](../images/dingtalk-step5-publish-2.png)

![Publish step 3](../images/dingtalk-step5-publish-3.png)

![Publish step 4](../images/dingtalk-step5-publish-4.png)

Confirm the visibility scope (you can limit to yourself), ensure robot is enabled, then click **Publish**.

---

## Step 4: Configure OpenClaw

### Configure with the wizard (recommended)

```bash
openclaw channels add
```

Choose **DingTalk** and paste your App Key + App Secret.

### Configure via config file

Edit `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appKey: "dingxxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### Configure via environment variables

```bash
export DINGTALK_APP_KEY="dingxxx"
export DINGTALK_APP_SECRET="xxx"
```

---

## Step 5: Start + test

### 1. Start the gateway

```bash
openclaw gateway
```

### 2. Send a test message

In DingTalk, find your bot and send a message.

![search robot](../images/dingtalk-step7-robot.png)

![send message](../images/dingtalk-step7-chat.png)

### 3. Approve pairing

By default, the bot replies with a pairing code. Approve it:

```bash
openclaw pairing approve dingtalk <CODE>
```

After approval, you can chat normally.

---

## Overview

- **DingTalk bot channel**: DingTalk bot managed by the gateway
- **Deterministic routing**: replies always return to DingTalk
- **Session isolation**: DMs share a main session; groups are isolated
- **Stream mode connection**: WebSocket-based connection via DingTalk SDK, no public URL needed

---

## Access control

### Direct messages

- **Default**: `dmPolicy: "open"`
- **Allowlist mode**: set `channels.dingtalk.allowFrom` with allowed user IDs

### Group chats

**Group policy** (`channels.dingtalk.groupPolicy`):

- `"open"` = allow everyone in groups (default)
- `"allowlist"` = only allow `groupAllowFrom`
- `"disabled"` = disable group messages

---

## Get user IDs

User IDs can be obtained from:

**Method 1 (recommended)**

1. Start the gateway and DM the bot
2. Run `openclaw logs --follow` and look for `senderStaffId` or `senderId`

---

## Common commands

| Command   | Description       |
| --------- | ----------------- |
| `/status` | Show bot status   |
| `/reset`  | Reset the session |
| `/model`  | Show/switch model |

> Note: DingTalk does not support native command menus yet, so commands must be sent as text.

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
2. Ensure Stream mode is enabled for the robot
3. Ensure app permissions are complete
4. Ensure the gateway is running: `openclaw gateway status`
5. Check logs: `openclaw logs --follow`

### App Secret leak

1. Reset the App Secret in DingTalk Open Platform
2. Update the App Secret in your config
3. Restart the gateway

### Message send failures

1. Ensure the app has `qyapi_robot_sendmsg` permission
2. Ensure the app is published
3. Check logs for detailed errors

---

## Configuration reference

Full configuration: [Gateway configuration](/gateway/configuration)

Key options:

| Setting                                                     | Description                 | Default   |
| ----------------------------------------------------------- | --------------------------- | --------- |
| `channels.dingtalk.enabled`                                 | Enable/disable channel      | `true`    |
| `channels.dingtalk.clientId`                                | App Key (Client ID)         | -         |
| `channels.dingtalk.clientSecret`                            | App Secret (Client Secret)  | -         |
| `channels.dingtalk.dmPolicy`                                | DM policy                   | `open`    |
| `channels.dingtalk.allowFrom`                               | DM allowlist (user ID list) | -         |
| `channels.dingtalk.groupPolicy`                             | Group policy                | `open`    |
| `channels.dingtalk.groupAllowFrom`                          | Group allowlist             | -         |

---

## Supported message types

### Receive

- ✅ Text
- ✅ Images
- ✅ Files
- ✅ Audio
- ✅ Video
- ⚠️ Rich text (partial support)

### Send

- ✅ Text
- ✅ Images
- ✅ Files
- ✅ Markdown
- ⚠️ Interactive cards (partial support)
