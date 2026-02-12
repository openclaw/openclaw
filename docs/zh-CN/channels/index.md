---
read_when:
  - 你想为 OpenClaw 选择一个聊天渠道
  - 你需要快速了解支持的消息平台
summary: OpenClaw 可连接的消息平台
title: 聊天渠道
x-i18n:
  generated_at: "2026-02-03T07:43:27Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2632863def6dee97e0fa8b931762f0969174fd4fb22303a00dcd46527fe4a141
  source_path: channels/index.md
  workflow: 15
---

# 聊天渠道

OpenClaw 可以在你已经使用的任何聊天应用上与你交流。每个渠道通过 Gateway 网关连接。
所有渠道都支持文本；媒体和表情回应的支持因渠道而异。

## 支持的渠道

- [Telegram](/channels/telegram) — 通过 grammY 使用 Bot API；支持群组。
- [Slack](/channels/slack) — Bolt SDK；工作区应用。

## 注意事项

- 渠道可以同时运行；配置多个渠道后，OpenClaw 会按聊天进行路由。
- 最快的设置方式通常是 **Telegram**（简单的机器人令牌）。
- 群组行为因渠道而异；参见[群组](/channels/groups)。
- 为安全起见，私信配对和允许列表会被强制执行；参见[安全](/gateway/security)。
- Telegram 内部机制：[grammY 说明](/channels/grammy)。
- 故障排除：[渠道故障排除](/channels/troubleshooting)。
- 模型提供商单独记录；参见[模型提供商](/providers/models)。
