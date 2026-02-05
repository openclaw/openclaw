---
summary: "DingTalk Stream API plugin setup, config, and usage"
read_when:
  - You want to connect OpenClaw to DingTalk
  - You need DingTalk Stream API credentials and configuration
  - You want DingTalk-specific message behavior details
---

# DingTalk (plugin)

DingTalk (钉钉) is an enterprise messaging platform by Alibaba. OpenClaw connects via the
DingTalk Stream API to receive bot messages and replies via DingTalk session webhooks.

Status: supported via plugin. Direct messages and group chats are supported. Media sending is supported.

## Plugin required

Install the DingTalk plugin:

```bash
openclaw plugins install @openclaw/dingtalk
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/dingtalk
```

Details: [Plugins](/plugin)

## Setup

1. Sign in to the DingTalk Open Platform:
   https://open.dingtalk.com/
2. Create an internal application for your organization.
3. Enable the robot capability and Stream mode (message subscription).
4. Copy the **Client ID** and **Client Secret**.

Note: DingTalk UI labels vary by console version. You are looking for the app credentials
and the Stream subscription for bot messages.

## Configure

Minimal config:

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      clientId: "ding***",
      clientSecret: "***",
      // Optional safety: allowlist sender staff IDs.
      allowFrom: ["manager9140"],
    },
  },
}
```

Env vars (default account only):

- `DINGTALK_CLIENT_ID`
- `DINGTALK_CLIENT_SECRET`

Secret file:

```json5
{
  channels: {
    dingtalk: {
      clientId: "ding***",
      clientSecretFile: "/path/to/dingtalk-secret.txt",
    },
  },
}
```

Multiple accounts:

```json5
{
  channels: {
    dingtalk: {
      accounts: {
        support: {
          enabled: true,
          name: "Support Bot",
          clientId: "ding***",
          clientSecret: "***",
        },
      },
    },
  },
}
```

## Access control

- `channels.dingtalk.allowFrom` is an allowlist of DingTalk sender IDs (senderStaffId or senderId).
- An empty allowlist means allow all senders. For safety, prefer an allowlist.

Group behavior:

- `requireMention: true` (default) requires an @mention in group chats.
- `requirePrefix` can be used instead of @mentions.
- `mentionBypassUsers` can bypass the @mention requirement for selected users.

## Media sends

To send a local file or image as an attachment, include a media tag in your reply:

```
[DING:IMAGE path="/absolute/path/to/image.png"]
[DING:FILE path="/absolute/path/to/report.pdf" name="report.pdf"]
```

The tag is removed from the visible text. The file is uploaded and sent separately.

## Capabilities

| Feature         | Status            |
| --------------- | ----------------- |
| Direct messages | ✅ Supported       |
| Group chats     | ✅ Supported       |
| Threads         | ❌ Not supported   |
| Reactions       | ❌ Not supported   |
| Media           | ✅ Supported       |
| Native commands | ❌ Not supported   |

## Configuration reference

- `channels.dingtalk.enabled`
- `channels.dingtalk.clientId`
- `channels.dingtalk.clientSecret`
- `channels.dingtalk.clientSecretFile`
- `channels.dingtalk.replyMode`: `text | markdown`
- `channels.dingtalk.maxChars`
- `channels.dingtalk.tableMode`: `code | off`
- `channels.dingtalk.allowFrom`
- `channels.dingtalk.requireMention`
- `channels.dingtalk.requirePrefix`
- `channels.dingtalk.isolateContextPerUserInGroup`
- `channels.dingtalk.mentionBypassUsers`
- `channels.dingtalk.responsePrefix`
- `channels.dingtalk.showToolStatus`
- `channels.dingtalk.showToolResult`
- `channels.dingtalk.thinking`
- `channels.dingtalk.apiBase`
- `channels.dingtalk.openPath`
- `channels.dingtalk.subscriptionsJson`
- `channels.dingtalk.accounts.<id>.*`
