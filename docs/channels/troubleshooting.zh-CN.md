---
summary: "快速频道级故障排除，包含每个频道的故障特征和修复方法"
read_when:
  - 频道传输显示已连接但回复失败
  - 在深入查看提供者文档之前需要频道特定的检查
title: "频道故障排除"
---

# 频道故障排除

当频道连接但行为异常时使用此页面。

## 命令阶梯

首先按顺序运行这些命令：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

健康基线：

- `Runtime: running`
- `Connectivity probe: ok`
- `Capability: read-only`、`write-capable` 或 `admin-capable`
- 频道探测显示传输已连接，在支持的情况下显示 `works` 或 `audit ok`

## WhatsApp

### WhatsApp 故障特征

| 症状 | 最快检查 | 修复 |
| --- | --- | --- |
| 已连接但无 DM 回复 | `openclaw pairing list whatsapp` | 批准发送者或切换 DM 策略/允许列表。 |
| 群消息被忽略 | 检查 `requireMention` + 配置中的提及模式 | 提及机器人或放宽该群组的提及策略。 |
| 随机断开/重新登录循环 | `openclaw channels status --probe` + 日志 | 重新登录并验证凭证目录是否健康。 |

完整故障排除：[/channels/whatsapp#troubleshooting](/channels/whatsapp#troubleshooting)

## Telegram

### Telegram 故障特征

| 症状 | 最快检查 | 修复 |
| --- | --- | --- |
| `/start` 但无可用回复流程 | `openclaw pairing list telegram` | 批准配对或更改 DM 策略。 |
| 机器人在线但群组保持沉默 | 验证提及要求和机器人隐私模式 | 为群组可见性禁用隐私模式或提及机器人。 |
| 发送失败并显示网络错误 | 检查 Telegram API 调用失败的日志 | 修复到 `api.telegram.org` 的 DNS/IPv6/代理路由。 |
| 启动时 `setMyCommands` 被拒绝 | 检查 `BOT_COMMANDS_TOO_MUCH` 的日志 | 减少插件/技能/自定义 Telegram 命令或禁用原生菜单。 |
| 升级后允许列表阻止您 | `openclaw security audit` 和配置允许列表 | 运行 `openclaw doctor --fix` 或用数字发送者 ID 替换 `@username`。 |

完整故障排除：[/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord 故障特征

| 症状 | 最快检查 | 修复 |
| --- | --- | --- |
| 机器人在线但无公会回复 | `openclaw channels status --probe` | 允许公会/频道并验证消息内容意图。 |
| 群消息被忽略 | 检查提及门控丢弃的日志 | 提及机器人或为公会/频道设置 `requireMention: false`。 |
| DM 回复丢失 | `openclaw pairing list discord` | 批准 DM 配对或调整 DM 策略。 |

完整故障排除：[/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack 故障特征

| 症状 | 最快检查 | 修复 |
| --- | --- | --- |
| 套接字模式已连接但无响应 | `openclaw channels status --probe` | 验证应用令牌 + 机器人令牌和所需作用域；在 SecretRef 支持的设置中关注 `botTokenStatus` / `appTokenStatus = configured_unavailable`。 |
| DMs 被阻止 | `openclaw pairing list slack` | 批准配对或放宽 DM 策略。 |
| 频道消息被忽略 | 检查 `groupPolicy` 和频道允许列表 | 允许频道或切换策略为 `open`。 |

完整故障排除：[/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage 和 BlueBubbles

### iMessage 和 BlueBubbles 故障特征

| 症状 | 最快检查 | 修复 |
| --- | --- | --- |
| 无入站事件 | 验证 webhook/服务器可达性和应用权限 | 修复 webhook URL 或 BlueBubbles 服务器状态。 |
| 在 macOS 上可以发送但无法接收 | 检查 Messages 自动化的 macOS 隐私权限 | 重新授予 TCC 权限并重启频道进程。 |
| DM 发送者被阻止 | `openclaw pairing list imessage` 或 `openclaw pairing list bluebubbles` | 批准配对或更新允许列表。 |

完整故障排除：

- [/channels/imessage#troubleshooting](/channels/imessage#troubleshooting)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signal 故障特征

| 症状 | 最快检查 | 修复 |
| --- | --- | --- |
| 守护进程可达但机器人沉默 | `openclaw channels status --probe` | 验证 `signal-cli` 守护进程 URL/账号和接收模式。 |
| DM 被阻止 | `openclaw pairing list signal` | 批准发送者或调整 DM 策略。 |
| 群回复不触发 | 检查群允许列表和提及模式 | 添加发送者/群组或放宽门控。 |

完整故障排除：[/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## QQ Bot

### QQ Bot 故障特征

| 症状 | 最快检查 | 修复 |
| --- | --- | --- |
| 机器人回复"去火星了" | 验证配置中的 `appId` 和 `clientSecret` | 设置凭证或重启网关。 |
| 无入站消息 | `openclaw channels status --probe` | 验证 QQ 开放平台上的凭证。 |
| 语音未转录 | 检查 STT 提供者配置 | 配置 `channels.qqbot.stt` 或 `tools.media.audio`。 |
| 主动消息未到达 | 检查 QQ 平台交互要求 | QQ 可能会阻止没有最近交互的机器人发起的消息。 |

完整故障排除：[/channels/qqbot#troubleshooting](/channels/qqbot#troubleshooting)

## Matrix

### Matrix 故障特征

| 症状 | 最快检查 | 修复 |
| --- | --- | --- |
| 已登录但忽略房间消息 | `openclaw channels status --probe` | 检查 `groupPolicy`、房间允许列表和提及门控。 |
| DMs 不处理 | `openclaw pairing list matrix` | 批准发送者或调整 DM 策略。 |
| 加密房间失败 | `openclaw matrix verify status` | 重新验证设备，然后检查 `openclaw matrix verify backup status`。 |
| 备份恢复挂起/损坏 | `openclaw matrix verify backup status` | 运行 `openclaw matrix verify backup restore` 或使用恢复密钥重新运行。 |
| 交叉签名/引导看起来错误 | `openclaw matrix verify bootstrap` | 一次性修复密钥存储、交叉签名和备份状态。 |

完整设置和配置：[Matrix](/channels/matrix)