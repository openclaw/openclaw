---
read_when:
  - 查看历史 Telegram 允许列表更改
summary: Telegram 允许列表加固：前缀 + 空白规范化
title: Telegram 允许列表加固
x-i18n:
  generated_at: "2026-02-03T07:47:16Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a2eca5fcc85376948cfe1b6044f1a8bc69c7f0eb94d1ceafedc1e507ba544162
  source_path: experiments/plans/group-policy-hardening.md
  workflow: 15
---

# Telegram 允许列表加固

**日期**：2026-01-05  
**状态**：已完成  
**PR**：#216

## 摘要

Telegram 允许列表现在不区分大小写地接受 `telegram:` 和 `tg:` 前缀，并容忍意外的空白。这使入站允许列表检查与出站发送规范化保持一致。

## 更改内容

- 前缀 `telegram:` 和 `tg:` 被同等对待（不区分大小写）。
- 允许列表条目会被修剪；空条目会被忽略。

## 示例

以下所有形式都被接受为同一 ID：

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## 为什么重要

从日志或聊天 ID 复制/粘贴通常会包含前缀和空白。规范化可避免在决定是否在私信或群组中响应时出现误判。

## 相关文档

- [群聊](/channels/groups)
- [Telegram 提供商](/channels/telegram)
