---
read_when:
  - 在任何渠道中处理表情回应相关工作
summary: 跨渠道共享的表情回应语义
title: 表情回应
x-i18n:
  generated_at: "2026-02-01T21:42:41Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 0f11bff9adb4bd02604f96ebe2573a623702796732b6e17dfeda399cb7be0fa6
  source_path: tools/reactions.md
  workflow: 15
---

# 表情回应工具

跨渠道共享的表情回应语义：

- 添加表情回应时，`emoji` 为必填项。
- `emoji=""` 在支持的情况下移除机器人的表情回应。
- `remove: true` 在支持的情况下移除指定的表情（需要提供 `emoji`）。

渠道说明：

- **Discord/Slack**：空 `emoji` 移除机器人在该消息上的所有表情回应；`remove: true` 仅移除指定的表情。
- **Google Chat**：空 `emoji` 移除应用在该消息上的表情回应；`remove: true` 仅移除指定的表情。
- **Telegram**：空 `emoji` 移除机器人的表情回应；`remove: true` 同样移除表情回应，但工具验证仍要求 `emoji` 为非空值。
- **WhatsApp**：空 `emoji` 移除机器人的表情回应；`remove: true` 映射为空 emoji（仍需提供 `emoji`）。
- **Signal**：当启用 `channels.signal.reactionNotifications` 时，收到的表情回应通知会触发系统事件。
