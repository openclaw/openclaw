---
read_when:
  - 添加或修改投票支持
  - 调试从 CLI 或 Gateway网关发送的投票
summary: 通过 Gateway网关 + CLI 发送投票
title: 投票
x-i18n:
  generated_at: "2026-02-01T19:38:57Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 760339865d27ec40def7996cac1d294d58ab580748ad6b32cc34d285d0314eaf
  source_path: automation/poll.md
  workflow: 14
---

# 投票

## 支持的渠道

- WhatsApp（Web 渠道）
- Discord
- Microsoft Teams（Adaptive Cards）

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

选项：

- `--channel`：`whatsapp`（默认）、`discord` 或 `msteams`
- `--poll-multi`：允许选择多个选项
- `--poll-duration-hours`：仅限 Discord（省略时默认为 24）

## Gateway网关 RPC

方法：`poll`

参数：

- `to`（字符串，必填）
- `question`（字符串，必填）
- `options`（字符串数组，必填）
- `maxSelections`（数字，可选）
- `durationHours`（数字，可选）
- `channel`（字符串，可选，默认：`whatsapp`）
- `idempotencyKey`（字符串，必填）

## 渠道差异

- WhatsApp：2-12 个选项，`maxSelections` 必须在选项数量范围内，忽略 `durationHours`。
- Discord：2-10 个选项，`durationHours` 限制在 1-768 小时（默认 24）。`maxSelections > 1` 启用多选；Discord 不支持严格的选择数量限制。
- Microsoft Teams：Adaptive Card 投票（由 OpenClaw 管理）。没有原生投票 API；`durationHours` 被忽略。

## 智能体工具（Message）

使用 `message` 工具的 `poll` 操作（`to`、`pollQuestion`、`pollOption`，可选 `pollMulti`、`pollDurationHours`、`channel`）。

注意：Discord 没有"精确选择 N 个"模式；`pollMulti` 映射为多选。
Teams 投票以 Adaptive Cards 形式渲染，需要 Gateway网关保持在线以在 `~/.openclaw/msteams-polls.json` 中记录投票结果。
