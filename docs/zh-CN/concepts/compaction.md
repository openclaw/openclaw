---
read_when:
  - 你想了解自动压缩和 /compact
  - 你正在调试长会话触及上下文限制的问题
summary: 上下文窗口 + 压缩：OpenClaw 如何将会话保持在模型限制内
title: 压缩
x-i18n:
  generated_at: "2026-02-01T20:22:17Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: e1d6791f2902044b5798ebf9320a7d055d37211eff4be03caa35d7e328ae803c
  source_path: concepts/compaction.md
  workflow: 14
---

# 上下文窗口与压缩

每个模型都有一个**上下文窗口**（可见的最大 token 数）。长时间运行的对话会累积消息和工具结果；一旦窗口空间紧张，OpenClaw 会**压缩**较早的历史记录以保持在限制范围内。

## 什么是压缩

压缩会将**较早的对话总结**为一条紧凑的摘要条目，并保持近期消息不变。摘要存储在会话历史中，因此后续请求使用的是：

- 压缩摘要
- 压缩点之后的近期消息

压缩会**持久化**到会话的 JSONL 历史记录中。

## 配置

有关 `agents.defaults.compaction` 设置，请参阅[压缩配置与模式](/concepts/compaction)。

## 自动压缩（默认开启）

当会话接近或超过模型的上下文窗口时，OpenClaw 会触发自动压缩，并可能使用压缩后的上下文重试原始请求。

你会看到：

- 详细模式下显示 `🧹 Auto-compaction complete`
- `/status` 显示 `🧹 Compactions: <count>`

在压缩之前，OpenClaw 可以运行一次**静默记忆刷写**轮次，将持久化笔记写入磁盘。详情及配置请参阅[记忆](/concepts/memory)。

## 手动压缩

使用 `/compact`（可选附带指令）强制执行一次压缩：

```
/compact Focus on decisions and open questions
```

## 上下文窗口来源

上下文窗口因模型而异。OpenClaw 使用已配置提供商目录中的模型定义来确定限制。

## 压缩与修剪

- **压缩**：总结并**持久化**到 JSONL 中。
- **会话修剪**：仅裁剪旧的**工具结果**，**在内存中**按请求进行。

有关修剪的详情，请参阅 [/concepts/session-pruning](/concepts/session-pruning)。

## 提示

- 当会话感觉过时或上下文臃肿时，使用 `/compact`。
- 大型工具输出已被截断；修剪可以进一步减少工具结果的堆积。
- 如果你需要全新开始，`/new` 或 `/reset` 会启动一个新的会话 ID。
