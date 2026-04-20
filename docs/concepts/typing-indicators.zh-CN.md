---
summary: "OpenClaw 何时显示打字指示器以及如何调整它们"
read_when:
  - 更改打字指示器行为或默认值
title: "打字指示器"
---

# 打字指示器

打字指示器在运行活跃时发送到聊天通道。使用
`agents.defaults.typingMode` 控制**何时**开始打字，使用 `typingIntervalSeconds`
控制**多久**刷新一次。

## 默认值

当 `agents.defaults.typingMode` **未设置**时，OpenClaw 保持旧行为：

- **直接聊天**：一旦模型循环开始，打字立即开始。
- **带有提及的群组聊天**：打字立即开始。
- **没有提及的群组聊天**：仅当消息文本开始流式传输时才开始打字。
- **心跳运行**：打字已禁用。

## 模式

将 `agents.defaults.typingMode` 设置为以下之一：

- `never` — 永远不显示打字指示器。
- `instant` — **一旦模型循环开始**就开始打字，即使运行
  后来只返回静默回复令牌。
- `thinking` — 在**第一个推理增量**时开始打字（需要
  运行的 `reasoningLevel: "stream"`）。
- `message` — 在**第一个非静默文本增量**时开始打字（忽略
  `NO_REPLY` 静默令牌）。

“触发时间早到晚”的顺序：
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

您可以按会话覆盖模式或节奏：

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## 注意事项

- `message` 模式不会为仅静默回复显示打字，当整个
  有效负载是确切的静默令牌时（例如 `NO_REPLY` / `no_reply`，
  不区分大小写匹配）。
- `thinking` 仅在运行流式传输推理时触发（`reasoningLevel: "stream"`）。
  如果模型不发出推理增量，打字不会开始。
- 心跳永远不会显示打字，无论模式如何。
- `typingIntervalSeconds` 控制**刷新节奏**，而不是开始时间。
  默认值为 6 秒。