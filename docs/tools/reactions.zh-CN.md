---
summary: "所有支持的渠道中的反应工具语义"
read_when:
  - 处理任何渠道中的反应
  - 了解不同平台上表情反应的差异
title: "反应"
---

# 反应

代理可以使用带有 `react` 动作的 `message` 工具在消息上添加和删除表情反应。反应行为因渠道而异。

## 工作原理

```json
{
  "action": "react",
  "messageId": "msg-123",
  "emoji": "thumbsup"
}
```

- 添加反应时需要 `emoji`。
- 将 `emoji` 设置为空字符串 (`""`) 以移除机器人的反应。
- 设置 `remove: true` 以移除特定的表情（需要非空的 `emoji`）。

## 渠道行为

<AccordionGroup>
  <Accordion title="Discord 和 Slack">
    - 空 `emoji` 会移除消息上机器人的所有反应。
    - `remove: true` 只移除指定的表情。
  </Accordion>

  <Accordion title="Google Chat">
    - 空 `emoji` 会移除消息上应用的反应。
    - `remove: true` 只移除指定的表情。
  </Accordion>

  <Accordion title="Telegram">
    - 空 `emoji` 会移除机器人的反应。
    - `remove: true` 也会移除反应，但仍需要非空的 `emoji` 进行工具验证。
  </Accordion>

  <Accordion title="WhatsApp">
    - 空 `emoji` 会移除机器人反应。
    - `remove: true` 在内部映射为空表情（工具调用中仍需要 `emoji`）。
  </Accordion>

  <Accordion title="Zalo Personal (zalouser)">
    - 需要非空的 `emoji`。
    - `remove: true` 会移除该特定表情反应。
  </Accordion>

  <Accordion title="飞书/Lark">
    - 使用带有 `add`、`remove` 和 `list` 动作的 `feishu_reaction` 工具。
    - 添加/移除需要 `emoji_type`；移除还需要 `reaction_id`。
  </Accordion>

  <Accordion title="Signal">
    - 入站反应通知由 `channels.signal.reactionNotifications` 控制：`"off"` 禁用它们，`"own"`（默认）在用户对机器人消息做出反应时发出事件，`"all"` 为所有反应发出事件。
  </Accordion>
</AccordionGroup>

## 反应级别

每个渠道的 `reactionLevel` 配置控制代理使用反应的广泛程度。值通常为 `off`、`ack`、`minimal` 或 `extensive`。

- [Telegram 反应级别](/channels/telegram#reaction-notifications) — `channels.telegram.reactionLevel`
- [WhatsApp 反应级别](/channels/whatsapp#reaction-level) — `channels.whatsapp.reactionLevel`

在各个渠道上设置 `reactionLevel` 以调整代理在每个平台上对消息做出反应的活跃度。

## 相关

- [代理发送](/tools/agent-send) — 包含 `react` 的 `message` 工具
- [渠道](/channels) — 渠道特定配置