---
summary: "DingTalk (钉钉) channel — robot receive message and reply via SessionWebhook"
read_when:
  - Setting up DingTalk robot with OpenClaw
  - Configuring webhook and sign verification
title: "DingTalk (钉钉)"
---

# DingTalk (钉钉)

Status: **supported (plugin)**. The DingTalk channel receives user messages via HTTP callback (机器人接收消息) and replies in the same conversation using **SessionWebhook**. Active send (e.g. `openclaw message send --channel dingtalk`) is not implemented yet.

## Plugin required

Install from the workspace:

```bash
openclaw plugins install ./extensions/dingtalk
```

## Prerequisites

1. **钉钉开放平台** — Create an application with **机器人** (robot) capability and enable "Receive message" (接收消息).
2. Get **ClientId** (appKey) and **ClientSecret** (appSecret) from the app’s "凭证与基础信息".
3. Configure the robot’s **message receiving URL** (消息接收地址) to point to your OpenClaw Gateway, e.g. `https://your-gateway-host/webhook/dingtalk`. The Gateway will verify the request using the **sign** (timestamp + appSecret, HMAC-SHA256 + Base64).

## Configuration

Minimal config:

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      appKey: "your-client-id",
      appSecret: "your-client-secret",
      webhookPath: "/webhook/dingtalk",
      dmPolicy: "allowlist",
      allowFrom: ["encrypted-sender-id-1"],
      rateLimitPerMinute: 30,
    },
  },
}
```

| Option                                 | Required       | Description                                                   |
| -------------------------------------- | -------------- | ------------------------------------------------------------- |
| `channels.dingtalk.enabled`            | No             | Default `true`.                                               |
| `channels.dingtalk.appKey`             | Yes (for sign) | Application ClientId.                                         |
| `channels.dingtalk.appSecret`          | Yes (for sign) | Application ClientSecret; used to verify callback sign.       |
| `channels.dingtalk.webhookPath`        | No             | HTTP path for DingTalk callback. Default `/webhook/dingtalk`. |
| `channels.dingtalk.dmPolicy`           | No             | `open` \| `allowlist` \| `pairing`. Default `allowlist`.      |
| `channels.dingtalk.allowFrom`          | When allowlist | List of sender IDs (encrypted) allowed to message the bot.    |
| `channels.dingtalk.rateLimitPerMinute` | No             | Per-sender rate limit. Default `30`.                          |
| `channels.dingtalk.corpId`             | No             | For future OpenAPI (e.g. active send).                        |

## Environment variables

For the default account you can use:

- `DINGTALK_APP_KEY` — appKey
- `DINGTALK_APP_SECRET` — appSecret
- `DINGTALK_CORP_ID` — corpId (for token/OpenAPI later)
- `DINGTALK_ALLOW_FROM` — comma-separated sender IDs

## Current behavior

- **Inbound**: DingTalk sends POST to your `webhookPath` with JSON body (msgtype, text, senderId, sessionWebhook, etc.). OpenClaw verifies the `timestamp` and `sign` headers, checks DM policy and rate limit, then runs the agent and replies via **SessionWebhook** in the same conversation.
- **Outbound**: Replying inside a robot conversation works (SessionWebhook). Sending a new message via `openclaw message send --channel dingtalk` is **not implemented** (would require OpenAPI + conversationId).

## Troubleshooting

- **Invalid sign**: Ensure `appSecret` matches the app’s ClientSecret and that the server time is correct (sign uses timestamp, drift &gt; 1 hour is rejected).
- **Allowlist empty**: If `dmPolicy` is `allowlist`, configure `allowFrom` with the encrypted sender IDs (you can get them from callback logs or DingTalk docs).
- **Reply not sent**: Check that `sessionWebhook` and `sessionWebhookExpiredTime` are present in the callback; replies are only sent when the session webhook is still valid.

## References

- [接收消息 - 钉钉开放平台](https://open.dingtalk.com/document/dingstart/receive-message)
- [机器人回复/发送消息 | 钉钉开发者百科](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/reply/)
