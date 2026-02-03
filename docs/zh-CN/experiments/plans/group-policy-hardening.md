---
read_when:
  - 审查 Telegram 允许列表的历史变更
summary: Telegram 允许列表加固：前缀与空白字符规范化
title: Telegram 允许列表加固
x-i18n:
  generated_at: "2026-02-01T20:25:02Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a2eca5fcc85376948cfe1b6044f1a8bc69c7f0eb94d1ceafedc1e507ba544162
  source_path: experiments/plans/group-policy-hardening.md
  workflow: 14
---

# Telegram 允许列表加固

**日期**：2026-01-05  
**状态**：已完成  
**PR**：#216

## 概要

Telegram 允许列表现在以不区分大小写的方式接受 `telegram:` 和 `tg:` 前缀，并容许意外的空白字符。这使得入站允许列表检查与出站发送的规范化保持一致。

## 变更内容

- 前缀 `telegram:` 和 `tg:` 被视为相同（不区分大小写）。
- 允许列表条目会被修剪空白；空条目将被忽略。

## 示例

以下所有格式均被接受为同一 ID：

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## 重要性

从日志或聊天 ID 中复制粘贴时经常会包含前缀和空白字符。规范化处理可以避免在决定是否响应私聊或群组消息时出现误判。

## 相关文档

- [群组聊天](/concepts/groups)
- [Telegram 渠道](/channels/telegram)
