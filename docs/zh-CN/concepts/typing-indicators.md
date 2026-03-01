---
read_when:
  - 更改输入指示器的行为或默认设置
summary: OpenClaw 何时显示输入指示器以及如何调整它们
title: 输入指示器
x-i18n:
  generated_at: "2026-02-01T20:24:47Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 8ee82d02829c4ff58462be8bf5bb52f23f519aeda816c2fd8a583e7a317a2e98
  source_path: concepts/typing-indicators.md
  workflow: 14
---

# 输入指示器

在运行活跃期间，输入指示器会发送到聊天渠道。使用
`agents.defaults.typingMode` 控制输入指示器**何时**开始显示，使用 `typingIntervalSeconds`
控制**刷新频率**。

## 默认行为

当 `agents.defaults.typingMode` **未设置**时，OpenClaw 保持旧版行为：

- **私聊**：模型循环开始后立即显示输入指示器。
- **群聊中被提及**：立即显示输入指示器。
- **群聊中未被提及**：仅在消息文本开始流式传输时显示输入指示器。
- **心跳运行**：输入指示器禁用。

## 模式

将 `agents.defaults.typingMode` 设置为以下值之一：

- `never` — 永远不显示输入指示器。
- `instant` — **模型循环开始后立即**显示输入指示器，即使运行最终只返回静默回复令牌。
- `thinking` — 在**第一个推理增量**时开始显示输入指示器（需要运行时设置
  `reasoningLevel: "stream"`）。
- `message` — 在**第一个非静默文本增量**时开始显示输入指示器（忽略
  `NO_REPLY` 静默令牌）。

触发时机从晚到早的顺序：
`never` → `message` → `thinking` → `instant`

## 配置

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

可以按会话覆盖模式或刷新频率：

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## 注意事项

- `message` 模式不会为纯静默回复显示输入指示器（例如用于抑制输出的 `NO_REPLY`
  令牌）。
- `thinking` 仅在运行流式传输推理时触发（`reasoningLevel: "stream"`）。
  如果模型未产生推理增量，则不会显示输入指示器。
- 无论使用何种模式，心跳运行都不会显示输入指示器。
- `typingIntervalSeconds` 控制的是**刷新频率**，而非开始时间。
  默认值为 6 秒。
